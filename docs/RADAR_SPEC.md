# Multi-Source Radar & Curation Pipeline Spec

> **Scope**: End-to-end pipeline for multi-channel signal ingestion (RSS/Blogs, YouTube, Podcasts, X, Browser active reading), time-windowed local buffering, cross-source deduplication & primary-source clustering, and actionable curation (*what to read/watch* + *who to follow/mute*).
>
> **Non-goal (Deferred)**: Full `LLM Wiki` (`wiki/` graph compilation & linting) is intentionally out of scope for this milestone. However, `.radar/` storage formats are designed to be clean, append-friendly, and deterministically structured so a future Wiki compiler can consume them without rewriting ingestion or curation.

---

## 1. Architecture Overview

```text
[Connectors & Extension]        [Local Time-Window Buffer: .radar/]        [3-Stage Curation Funnel]           [For You UI]
1. RSS / Blogs / Newsletters ──┐                                        ┌─ Stage 1: Deterministic dedup     ┌─ Briefing + Go Deeper
2. YouTube Atom + Captions   ──┼─▶ SignalItem (.radar/items/YYYY-MM-DD) ├─ Stage 2: Batch AI triage/cluster ├─ Primary Cards (+ folded echoes)
3. Podcast RSS (Show Notes)  ──┤                                        ├─ Stage 3: Cluster fold +          ├─ Who to Follow / Mute
4. Extension (X + Browser)   ──┘   SourceStats (.radar/source_stats)    │           Source ROI              └─ One-click Capture / Follow / Mute
```

### Core Design Principles (from `AGENTS.md`)
- **Local-first**: All ingested items, source lists, stats, and snapshots live in plain files under `{root}/.radar/`.
- **Deterministic math in TypeScript, semantic judgment in Agent CLI**: Counts (`fetchedCount`, `recommendedCount`, `capturedCount`, `mutedCount`), URL normalization, time-window filtering, and deduplication are deterministic code. Only semantic scoring, topic clustering, primary-source identification, and briefing synthesis call `callAgent`.
- **No `library/` pollution**: Ingested radar signals stay in `.radar/` until the user explicitly clicks **Capture** (which runs the existing `processSourceInBackground` into `library/`).
- **Minimal code & backward compatibility**: Extend existing `FeedCache`, `FeedItem`, `FeedSignals`, `/api/feed`, `useFeed`, and `FeedSection` rather than building a parallel feed UI.

---

## 2. Data Model & Storage (`.radar/`)

Directory layout under `{root}` (`getCurrentRootPath()`):

```text
{root}/
├── .feed/                     # Existing feed cache, snapshots, seen history, starred briefings
└── .radar/                    # Multi-source buffer & source intelligence
    ├── sources.json           # Configured + discovered + muted RadarSource entries
    ├── source_stats.json      # Deterministic per-source ROI counters
    └── items/
        └── YYYY-MM-DD.jsonl   # Daily append-deduped SignalItem records
```

### 2.1 Types (`src/lib/types.ts` + `src/lib/schemas.ts`)

```typescript
export type SignalChannel = "rss" | "youtube" | "podcast" | "x" | "browser" | "search";

export type RadarSourceStatus = "active" | "candidate" | "muted";

export interface RadarSource {
  id: string;                 // Stable ID, e.g. "yt:UC..." or "x:@karpathy" or host/hash
  channel: SignalChannel;
  label: string;
  url: string;                // Feed URL, channel Atom URL, profile URL, or domain
  handle?: string;            // e.g. "@karpathy"
  status: RadarSourceStatus;
  addedAt: string;            // ISO timestamp
}

export interface SignalEngagement {
  dwellSeconds?: number;
  scrollDepth?: number;       // 0..1
  likesOrReplies?: number;
}

export interface SignalItem {
  id: string;                 // Stable hash from canonicalUrl
  channel: SignalChannel;
  sourceId: string;           // Maps to RadarSource.id & source_stats.json
  sourceName: string;         // Display name (channel/podcast/handle/domain)
  authorHandle?: string;
  title: string;
  url: string;
  canonicalUrl: string;       // Normalized URL without tracking params
  publishedAt: string;        // ISO timestamp
  capturedAt: string;         // ISO timestamp when ingested into .radar/
  rawLengthHint?: string;     // e.g. "42 min", "1800 words", "Thread (6)"
  snippet: string;            // Up to 1500 chars of clean text / transcript / show notes
  outboundUrls?: string[];    // Links found in tweets or show notes (for primary-source linking)
  thumbnail?: string;
  engagement?: SignalEngagement;
}

export interface SourceStats {
  sourceId: string;
  sourceName: string;
  channel: SignalChannel;
  url?: string;
  handle?: string;
  fetchedCount: number;
  recommendedCount: number;
  skippedCount: number;
  capturedCount: number;      // User clicked Capture into library/
  dismissedCount: number;
  lastSeenAt: string;
}

export interface RelatedMention {
  title: string;
  url: string;
  channel: SignalChannel;
  sourceName: string;
}

export interface SourceRecommendation {
  sourceId: string;
  sourceName: string;
  channel: SignalChannel;
  url?: string;
  handle?: string;
  reason: string;
  stats?: {
    fetchedCount: number;
    recommendedCount: number;
    capturedCount: number;
  };
}
```

Extend existing feed types cleanly (all new fields optional so existing snapshots remain valid):
- `FeedItem`: add `channel?: SignalChannel`, `sourceId?: string`, `sourceName?: string`, `rawLengthHint?: string`, `topicCluster?: string`, `isPrimarySource?: boolean`, `relatedMentions?: RelatedMention[]`.
- `FeedSignals`: add `windowDays?: number`, `channelCounts?: Partial<Record<SignalChannel, number>>`, `foldedDuplicates?: number`.
- `FeedCache`: add `windowDays?: number`, `sourceRecommendations?: { follow: SourceRecommendation[]; mute: SourceRecommendation[] }`.

### 2.2 Storage Functions (`src/lib/radarStorage.ts`)

1. **URL Canonicalization (`canonicalizeUrl`)**:
   - Lowercase host, strip `www.`, strip tracking params (`utm_*`, `fbclid`, `gclid`, `mc_cid`, `mc_eid`, `si`, `s`, `t` when not YouTube timestamp — keep `v` on `youtube.com/watch`), normalize `twitter.com` -> `x.com`, strip trailing `/` (except root).
2. **Daily JSONL Persistence (`appendRadarItems`, `loadRadarItemsInWindow(windowDays)`)**:
   - Partition by `publishedAt` (clamped to valid ISO date, fallback to `capturedAt`) into `.radar/items/YYYY-MM-DD.jsonl`.
   - Deduplicate by `canonicalUrl` (or `id`) when appending: if an item already exists on that day, merge richer `snippet` / `engagement` (e.g., max `dwellSeconds`) without duplicating lines.
   - `loadRadarItemsInWindow(windowDays)` reads the last `windowDays` daily files (plus 1 day buffer) and filters strictly by `publishedAt >= now - windowDays * 86400_000`.
   - Include a helper `pruneOldRadarItems(retainDays = 30)` to keep `.radar/items/` bounded.
3. **Sources & Migration (`loadRadarSources`, `saveRadarSources`, `upsertRadarSource`, `setRadarSourceStatus`)**:
   - Sync/seed from `config.json` `rssFeeds` on first read so existing RSS feeds automatically appear as active `RadarSource` entries.
   - Keep `rss` sources bidirectionally compatible when user updates Settings.
4. **Deterministic Stats (`loadSourceStats`, `recordSourceEvents`)**:
   - Update `fetchedCount`, `recommendedCount`, `skippedCount`, `capturedCount`, `dismissedCount` deterministically with an in-process write lock (simple promise chain mutex) to prevent race conditions during concurrent `/api/radar/ingest` or curation runs.

---

## 3. Multi-Source Connectors (`src/lib/connectors/`)

Create modular connectors returning `SignalItem[]`:

### 3.1 RSS / Blog Connector (`src/lib/connectors/rss.ts`)
- Upgrade RSS 2.0 & Atom parsing (can share XML helpers with `search.ts`):
  - Extract `<content:encoded>` before `<description>` / `<summary>`, strip HTML tags cleanly, decode common HTML entities, keep up to **1500 chars** (instead of 200).
  - Extract `outboundUrls` (`href="https://..."`) inside item content (up to 5 unique external URLs).
  - Preserve `author` / `dc:creator` if present for `sourceName`.

### 3.2 YouTube Connector (`src/lib/connectors/youtube.ts`)
- **Source normalization helper** (`resolveYoutubeAtomUrl(input)`):
  - Accepts:
    - `https://www.youtube.com/feeds/videos.xml?channel_id=UC...` (direct)
    - `https://www.youtube.com/channel/UC...` (convert directly)
    - `https://www.youtube.com/@handle` or `youtube.com/c/...` (fetch page HTML once with 8s timeout, parse `<meta itemprop="channelId" content="UC...">` or `"externalId":"UC..."`, convert to Atom URL).
- **Feed fetch**:
  - Fetch Atom XML, parse `<entry>` (`yt:videoId`, `title`, `link`, `published`, `author > name`, `media:group > media:description`, `media:group > media:thumbnail`).
- **Best-effort caption extraction**:
  - For videos within the requested `windowDays` (limit e.g. top 5 newest per refresh to stay fast), try fetching captions:
    - First attempt lightweight caption fetch (or `yt-dlp --write-auto-sub --skip-download --sub-format vtt` if `yt-dlp` binary exists, with short 8s timeout).
    - Strip VTT/XML timestamps cleanly, take up to 1500 chars as `snippet` prefix + description.
    - **Never fail** the connector if captions are unavailable or `yt-dlp` is missing — fall back cleanly to `media:description`.

### 3.3 Podcast Connector (`src/lib/connectors/podcast.ts`)
- Parse standard Podcast RSS 2.0 feeds:
  - Detect podcast attributes: `<itunes:duration>`, `<itunes:author>`, `<enclosure url="..." type="audio/...">`, `<content:encoded>` / `<itunes:summary>` / `<description>`.
  - Populate `rawLengthHint` with formatted duration (e.g., `"48 min"`).
  - Populate `snippet` with up to 1500 chars of cleaned Show Notes + guest/chapter info + extracted `outboundUrls`.
  - No audio transcription required in this milestone (show notes + guest/topic metadata drive curation).

### 3.4 External Ingestion API (`src/app/api/radar/ingest/route.ts`)
- `POST /api/radar/ingest` with CORS headers (same pattern as `/api/capture`):
  - Validates body via Zod: `{ items: IngestItemSchema[] }` (max 100 items per request).
  - Normalizes `canonicalUrl`, builds `SignalItem`, registers unknown `sourceId` as `"candidate"` in `sources.json` (unless already `"active"` or `"muted"`), appends to `.radar/items/YYYY-MM-DD.jsonl`, and increments `fetchedCount` in `source_stats.json`.
  - Returns `{ success: true, ingested: number, deduplicated: number }`.

### 3.5 Source Management & Feedback APIs
- `GET /api/radar/sources`: returns `{ sources, stats }`.
- `POST /api/radar/sources`: add a source (`channel: "rss" | "youtube" | "podcast" | "x"`, `url`, `label?`); resolves YouTube handle -> Atom URL when `channel === "youtube"`.
- `PATCH /api/radar/sources`: update status (`"active" | "candidate" | "muted"`) or delete a source.
- `POST /api/radar/feedback`: accepts `{ action: "capture" | "dismiss" | "follow" | "mute", sourceId, url?, channel?, sourceName?, handle? }`, updates `source_stats.json` and `sources.json`.

---

## 4. Chrome Extension Upgrades (`extension/`)

Keep changes clean, privacy-safe, and configurable in `extension/welcome.html` + `welcome.js`:

### 4.1 Background Queue & Ingestion (`extension/background.js`)
- Add `radarIngest(items)` message handler using existing `getApiUrl()` server discovery (replacing `/api/capture` with `/api/radar/ingest`).
- If Second Brain server is offline, buffer pending items in `chrome.storage.local` (`radarPendingQueue`, capped at 200 items) and flush on next successful probe/ingest.

### 4.2 High-Dwell Browser Reading Tracker (`extension/browser-radar.js`)
- Injected on `<all_urls>` (excluding `localhost`, `127.0.0.1`, common webmail/chat/search/banking domains, plus user-configurable excluded domains in storage; toggleable via `browserRadarEnabled`, default `true`).
- Tracks **active reading time** (only ticks when `document.visibilityState === "visible"` AND user interacted via `scroll`, `mousemove`, or `keydown` within the last 15s) and **max scroll depth** (`0..1`).
- Once `activeDwellSeconds >= 60 && maxScrollDepth >= 0.30` (sent at most once per page load / canonical URL, and updates on unload if dwell grew significantly):
  - Extracts `title`, canonical URL (`link[rel="canonical"]` or `location.href`), and clean visible article text snippet (prefer `<article>`, `<main>`, else `document.body`, collapsed whitespace, first 1500 chars).
  - Sends `{ channel: "browser", sourceId: "browser:" + hostname, sourceName: hostname, title, url, publishedAt: now, snippet, engagement: { dwellSeconds, scrollDepth } }` via `chrome.runtime.sendMessage({ action: "radarIngest", items: [...] })`.

### 4.3 Passive X (Twitter) Timeline & List Collector (`extension/twitter-autocapture.js`)
- Keep existing `[data-testid="bookmark"]` auto-capture to `/api/capture` untouched.
- Add passive viewport collector (toggleable via `xRadarEnabled`, default `true`) on `x.com` / `twitter.com`:
  - Uses `IntersectionObserver` / debounced scroll observer on `article[data-testid="tweet"]` while user browses Home / Following / Lists / Bookmarks.
  - Extracts: tweet status URL, author `@handle` & display name, `time[datetime]`, tweet text (`[data-testid="tweetText"]`), quoted tweet text if present, and non-X external links (`outboundUrls`).
  - Merges consecutive tweets by the same author in the same thread view when possible, skips tiny `< 40` char tweets with no links/quote.
  - Debounces & batches every ~10s (or >= 10 items) to `radarIngest` with `channel: "x"`, `sourceId: "x:" + handle`, `sourceName: "@" + handle`.

### 4.4 Extension Options (`extension/welcome.html`, `extension/welcome.js`)
- Add toggles for **Browser Reading Radar** (`browserRadarEnabled`) and **X Stream Radar** (`xRadarEnabled`) alongside the existing floating button & Twitter bookmark toggles, plus a simple comma-separated **Excluded Domains** input.

---

## 5. Three-Stage Curation Engine (`src/lib/radarCurator.ts` & `/api/feed`)

Integrate directly with `GET /api/feed` and `POST /api/feed` (accepting `days` query/body param: `1 | 3 | 7`, default `3`):

### Stage 1: Fetch Active Connectors + Deterministic Pre-Filter (0 LLM tokens)
1. Load `RadarSource[]` from `.radar/sources.json` (plus `config.json` `searchSources` + `feedInterests` for Brave Search if key is set).
2. Fetch live updates in parallel (with per-source timeout & error isolation) for `active` RSS, YouTube, and Podcast sources, and persist them into `.radar/items/YYYY-MM-DD.jsonl` (so live feeds and extension-pushed X/Browser items live in the same time-window pool!).
3. Load all `SignalItem`s from `.radar/items/` within `windowDays`.
4. Filter out:
   - Items whose `sourceId` has `status === "muted"`
   - Items whose `canonicalUrl` is already in `.feed/history.json` (`seen`) or already captured in `library/`
   - Very low-signal items (`channel === "x"` with `< 40` chars and no `outboundUrls`)
5. **Cross-Channel URL Merge**:
   - If an X post's `outboundUrls` (or a Browser item) matches the `canonicalUrl` of an RSS/article item, attach the X/Browser mention as a pre-folded `RelatedMention` onto the primary article item and boost its engagement signal rather than scoring it twice.
6. Compute `channelCounts` across all pre-filtered candidates for `FeedSignals`.

### Stage 2: Batch Semantic Scoring, Clustering & Primary-Source Tagging
- Process candidates in bounded batches (`BATCH_SIZE = 25`, max concurrency `2` via a small concurrency helper so local `claude`/`codex` CLI doesn't hit rate limits or spawn-storm).
- Context passed to prompt:
  - `USER.md` / `feedInterests`
  - Recent library titles/concepts (bounded by `AGENT_CONTEXT_CONFIG.feedLibrarySources`)
  - Interaction context (`starredHighlights`, `learnedConcepts`, etc.)
  - Implicit browser context summary (top domains/titles from `channel === "browser"` in the window)
- Agent returns JSON array per batch:
  `{ index, score (0-100), action ("recommend" | "skip"), topicCluster (short kebab/phrase label), isPrimarySource (boolean), whyRead?, whySkip?, connectsTo? }`.
- Update `source_stats.json` deterministically (`recommendedCount`, `skippedCount`).

### Stage 3: Cross-Batch Cluster Folding, Briefing & Follow/Mute Recommendations
1. **Cluster Folding**:
   - Group recommended items sharing the same `topicCluster` (case-insensitive normalized).
   - Within each cluster, select the best primary item (`isPrimarySource === true` first, then `channel` priority `rss/youtube/podcast > browser > x`, then highest `score`).
   - Fold remaining cluster members into `primary.relatedMentions` and increment `foldedDuplicates`.
2. **Briefing Generation**:
   - Pass top folded recommended items (include `channel`, `sourceName`, `rawLengthHint`, `relatedMentions.length`) to `generateBriefing` so the Chief-of-Staff briefing highlights cross-channel convergence, primary sources, and browser blind spots.
3. **Who to Follow / Mute (`sourceRecommendations`)**:
   - **Follow candidates** (deterministic candidate selection + short AI reason):
     - Look at `candidate` (not yet `active`, not `muted`) sources in `source_stats.json` that appeared in the window with high `recommendedCount` (e.g., `>= 2` recommended items or `score >= 85` as `isPrimarySource`), plus any standout new authors/channels from recommended items.
   - **Mute candidates**:
     - Look at `active` sources with `fetchedCount >= 5` and `(recommendedCount + capturedCount) / fetchedCount < 0.15` (low signal-to-noise ratio).
   - Format up to 5 Follow suggestions and 3 Mute suggestions via a lightweight summary pass (or deterministic + agent reasons).
4. Save result into `.feed/cache.json` + dated snapshot (via `saveFeedCache`) so `FeedSection` date selector and caching work out of the box.

---

## 6. Frontend Integration (`src/components/`, `src/hooks/useFeed.ts`)

1. **`useFeed.ts`**:
   - Support `windowDays` (`1 | 3 | 7`, default `3`) passed to `GET /api/feed?days=...` and `POST /api/feed` (`{ windowDays }`).
   - Add `followSource(rec)` and `muteSource(sourceId)` helpers calling `POST /api/radar/feedback` and updating local state optimistically.
2. **`FeedSection.tsx`** (extract new subcomponents cleanly into `src/components/radar/` or dedicated small components per `AGENTS.md` rule "Always Extract Components"):
   - **Time window selector** (`24h` / `3d` / `7d`) in the header alongside Refresh.
   - **Multi-channel `SignalsBar`**: display per-channel counts (`RSS`, `YT`, `Podcast`, `X`, `Browser`) and `N echoes folded`.
   - **Enhanced `FeedCard`**:
     - Channel icon/badge (`YouTube`, `Podcast`, `X`, `Browser`, `Article`) + `sourceName` + `rawLengthHint` (e.g., `42 min`).
     - Collapsible `"N related mentions"` pill showing folded discussions across channels.
     - Quick `"Follow"` (when `candidate`) / `"Mute"` source action alongside Capture and Dismiss.
   - **`SourceRecommendationsSection`**:
     - Compact panel showing `"Worth Following"` (new high-signal voices) and `"Low Signal (Consider Muting)"` with one-click Follow / Mute buttons.
3. **`SettingsModal.tsx`**:
   - Add a **Radar Sources** management section under Feed settings supporting adding `YouTube` (channel URL / `@handle` / Atom URL), `Podcast` (RSS URL), and `RSS` feeds, plus toggling/unmuting existing sources.

---

## 7. Verification Plan

1. **Unit tests (`tests/`)**:
   - `tests/radar-storage.test.ts`: URL canonicalization, JSONL daily append & deduplication, time-window filtering, deterministic `source_stats.json` updates.
   - `tests/radar-connectors.test.ts`: YouTube Atom XML parsing + URL normalization, Podcast RSS duration/show-notes/enclosure parsing, RSS rich snippet + outbound URL extraction.
   - `tests/radar-curator.test.ts`: Stage 1 deterministic filtering + cross-channel URL merge, Stage 3 `topicCluster` folding (primary source wins, echoes go to `relatedMentions`, `foldedDuplicates` count), Follow/Mute candidate selection.
2. **Checks**:
   - `npm test` (all existing + new tests pass)
   - `npm run lint` (0 errors)
   - `npm run build` (Next.js production TypeScript & route build passes)
