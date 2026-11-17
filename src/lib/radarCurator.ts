import { callAgent } from "./agent";
import {
  buildInteractionContext,
  generateBriefing,
  generateInsights,
  type InteractionSignals,
} from "./claude";
import { AGENT_CONTEXT_CONFIG } from "./config";
import { fetchPodcastSignals } from "./connectors/podcast";
import { fetchRssSignals } from "./connectors/rss";
import { fetchYoutubeSignals } from "./connectors/youtube";
import { promptRadarTriage, promptSourceReasons } from "./prompts";
import { canonicalizeUrl, ingestSignalItems, loadRadarItemsInWindow, loadRadarSources, loadSourceStats, recordSourceEvents } from "./radarStorage";
import { searchNews, type BraveSearchResult } from "./search";
import {
  listSources,
  listSourcesForConnections,
  loadFeedHistory,
  loadProfileDoc,
  loadStarredBriefings,
  loadUserConfig,
  saveFeedCache,
} from "./storage";
import type {
  FeedCache,
  FeedItem,
  FeedSignals,
  InsightItem,
  RadarSource,
  RadarSourceStatus,
  RadarWindowDays,
  RelatedMention,
  SignalChannel,
  SignalEngagement,
  SignalItem,
  SourceRecommendation,
  SourceStats,
  StructuredBriefing,
} from "./types";

export const BATCH_SIZE = 25;
export const TRIAGE_CONCURRENCY = 2;
const DAY_MS = 86_400_000;

const PRIMARY_CHANNELS = new Set<SignalChannel>(["rss", "youtube", "podcast", "search"]);

export interface MergedSignal extends SignalItem {
  relatedMentions: RelatedMention[];
}

export interface ScoredSignal extends MergedSignal {
  score: number;
  action: "recommend" | "skip";
  topicCluster?: string;
  isPrimarySource?: boolean;
  whyRead?: string;
  whySkip?: string;
  connectsTo?: string;
}

export interface RadarFeedResult {
  items: FeedItem[];
  interests: string[];
  generatedAt: string;
  fromCache: false;
  message?: string;
  briefing?: StructuredBriefing;
  signals?: FeedSignals;
  insights?: InsightItem[];
  sourceRecommendations?: FeedCache["sourceRecommendations"];
  windowDays: RadarWindowDays;
}

export function parseWindowDays(value: unknown): RadarWindowDays {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (numeric === 1 || numeric === 7) return numeric;
  return 3;
}

export function normalizeTopicCluster(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function mentionFrom(item: Pick<SignalItem, "title" | "url" | "channel" | "sourceName">): RelatedMention {
  return { title: item.title, url: item.url, channel: item.channel, sourceName: item.sourceName };
}

function pushMention(target: MergedSignal, mention: RelatedMention): void {
  if (!mention.url) return;
  const duplicate = target.relatedMentions.some((existing) =>
    existing.url === mention.url && existing.channel === mention.channel && existing.sourceName === mention.sourceName);
  if (duplicate) return;
  target.relatedMentions.push(mention);
}

function mergeEngagement(left?: SignalEngagement, right?: SignalEngagement): SignalEngagement | undefined {
  const max = (a?: number, b?: number) => {
    if (typeof a !== "number" && typeof b !== "number") return undefined;
    return Math.max(a ?? Number.NEGATIVE_INFINITY, b ?? Number.NEGATIVE_INFINITY);
  };
  const engagement: SignalEngagement = {
    dwellSeconds: max(left?.dwellSeconds, right?.dwellSeconds),
    scrollDepth: max(left?.scrollDepth, right?.scrollDepth),
    likesOrReplies: max(left?.likesOrReplies, right?.likesOrReplies),
  };
  if (engagement.dwellSeconds == null && engagement.scrollDepth == null && engagement.likesOrReplies == null) return undefined;
  return engagement;
}

function lookupUrl(value: string, primaries: Map<string, MergedSignal>): MergedSignal | undefined {
  try {
    return primaries.get(canonicalizeUrl(value));
  } catch {
    return primaries.get(value);
  }
}

export function filterAndMergeSignals(input: {
  items: SignalItem[];
  mutedSourceIds: ReadonlySet<string>;
  seenUrls: ReadonlySet<string>;
  libraryUrls: ReadonlySet<string>;
}): { candidates: MergedSignal[]; channelCounts: Partial<Record<SignalChannel, number>> } {
  const seen = new Set([...input.seenUrls].map((url) => canonicalizeUrl(url)));
  const library = new Set([...input.libraryUrls].map((url) => canonicalizeUrl(url)));
  const filtered = input.items.filter((item) => {
    if (input.mutedSourceIds.has(item.sourceId)) return false;
    const canonical = item.canonicalUrl || canonicalizeUrl(item.url);
    if (seen.has(canonical) || library.has(canonical)) return false;
    if (item.channel === "x" && item.snippet.trim().length < 40 && (item.outboundUrls?.length ?? 0) === 0) return false;
    return true;
  });

  const channelCounts: Partial<Record<SignalChannel, number>> = {};
  for (const item of filtered) {
    channelCounts[item.channel] = (channelCounts[item.channel] ?? 0) + 1;
  }

  const primaries = new Map<string, MergedSignal>();
  const mentions: SignalItem[] = [];
  for (const item of filtered) {
    if (!PRIMARY_CHANNELS.has(item.channel)) {
      mentions.push(item);
      continue;
    }
    const canonical = item.canonicalUrl || canonicalizeUrl(item.url);
    const existing = primaries.get(canonical);
    if (!existing) {
      primaries.set(canonical, { ...item, canonicalUrl: canonical, relatedMentions: [] });
      continue;
    }
    existing.snippet = item.snippet.trim().length > existing.snippet.trim().length ? item.snippet : existing.snippet;
    existing.engagement = mergeEngagement(existing.engagement, item.engagement);
    pushMention(existing, mentionFrom(item));
  }

  const standalone: MergedSignal[] = [];
  for (const item of mentions) {
    const keys = [item.canonicalUrl || item.url, ...(item.outboundUrls ?? [])];
    let host: MergedSignal | undefined;
    for (const key of keys) {
      host = lookupUrl(key, primaries);
      if (host) break;
    }
    if (!host) {
      standalone.push({ ...item, relatedMentions: [] });
      continue;
    }
    pushMention(host, mentionFrom(item));
    host.engagement = mergeEngagement(host.engagement, item.engagement);
  }

  return { candidates: [...primaries.values(), ...standalone], channelCounts };
}

function channelRank(channel: SignalChannel): number {
  if (channel === "rss" || channel === "youtube" || channel === "podcast" || channel === "search") return 0;
  if (channel === "browser") return 1;
  return 2;
}

function comparePrimary(left: ScoredSignal, right: ScoredSignal): number {
  const leftPrimary = left.isPrimarySource ? 1 : 0;
  const rightPrimary = right.isPrimarySource ? 1 : 0;
  if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
  const rank = channelRank(left.channel) - channelRank(right.channel);
  if (rank !== 0) return rank;
  return right.score - left.score;
}

export function foldTopicClusters(items: ScoredSignal[]): { items: ScoredSignal[]; foldedDuplicates: number } {
  const groups = new Map<string, ScoredSignal[]>();
  const skipped: ScoredSignal[] = [];
  items.forEach((item, index) => {
    if (item.action !== "recommend") {
      skipped.push(item);
      return;
    }
    const cluster = normalizeTopicCluster(item.topicCluster) || `__solo:${item.id || index}`;
    const group = groups.get(cluster) ?? [];
    group.push({ ...item, relatedMentions: [...(item.relatedMentions ?? [])] });
    groups.set(cluster, group);
  });

  let foldedDuplicates = 0;
  const folded: ScoredSignal[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort(comparePrimary);
    const winner = ranked[0];
    for (const other of ranked.slice(1)) {
      foldedDuplicates += 1;
      pushMention(winner, mentionFrom(other));
      for (const mention of other.relatedMentions) pushMention(winner, mention);
    }
    folded.push(winner);
  }

  folded.sort((a, b) => b.score - a.score);
  skipped.sort((a, b) => b.score - a.score);
  return { items: [...folded, ...skipped], foldedDuplicates };
}

interface ScoredRef {
  sourceId: string;
  sourceName: string;
  channel: SignalChannel;
  action: "recommend" | "skip";
  score: number;
  isPrimarySource?: boolean;
  url?: string;
  authorHandle?: string;
}

export function selectSourceRecommendations(input: {
  sources: RadarSource[];
  stats: SourceStats[];
  scored: ScoredRef[];
}): { follow: SourceRecommendation[]; mute: SourceRecommendation[] } {
  const sourcesById = new Map(input.sources.map((source) => [source.id, source]));
  const statsById = new Map(input.stats.map((stat) => [stat.sourceId, stat]));
  const windows = new Map<string, { count: number; bestPrimary: number; sample: ScoredRef }>();

  for (const item of input.scored) {
    if (item.action !== "recommend") continue;
    const current = windows.get(item.sourceId) ?? { count: 0, bestPrimary: 0, sample: item };
    current.count += 1;
    if (item.isPrimarySource && item.score > current.bestPrimary) current.bestPrimary = item.score;
    current.sample = item;
    windows.set(item.sourceId, current);
  }

  const follow = [...windows.entries()]
    .filter(([sourceId, window]) => {
      const source = sourcesById.get(sourceId);
      if (source?.status === "active" || source?.status === "muted") return false;
      return window.count >= 2 || window.bestPrimary >= 85;
    })
    .sort((a, b) => b[1].count - a[1].count || b[1].bestPrimary - a[1].bestPrimary || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([sourceId, window]) => {
      const source = sourcesById.get(sourceId);
      const stats = statsById.get(sourceId);
      const handle = source?.handle || window.sample.authorHandle;
      const url = source?.url
        || (window.sample.channel === "x" && handle ? `https://x.com/${handle.replace(/^@/, "")}` : window.sample.url);
      return {
        sourceId,
        sourceName: source?.label || window.sample.sourceName,
        channel: source?.channel || window.sample.channel,
        url,
        handle,
        reason: window.count >= 2
          ? `${window.count} recommended in this window`
          : `Primary source scored ${window.bestPrimary}`,
        stats: stats
          ? { fetchedCount: stats.fetchedCount, recommendedCount: stats.recommendedCount, capturedCount: stats.capturedCount }
          : undefined,
      };
    });

  const mute = input.stats
    .filter((stat) => {
      const source = sourcesById.get(stat.sourceId);
      if (!source || source.status !== "active" || stat.fetchedCount < 5) return false;
      return (stat.recommendedCount + stat.capturedCount) / stat.fetchedCount < 0.15;
    })
    .sort((a, b) => {
      const ratio = (stat: SourceStats) => (stat.recommendedCount + stat.capturedCount) / stat.fetchedCount;
      return ratio(a) - ratio(b) || b.fetchedCount - a.fetchedCount;
    })
    .slice(0, 3)
    .map((stat) => {
      const source = sourcesById.get(stat.sourceId);
      const useful = stat.recommendedCount + stat.capturedCount;
      return {
        sourceId: stat.sourceId,
        sourceName: source?.label || stat.sourceName,
        channel: source?.channel || stat.channel,
        url: source?.url || stat.url,
        handle: source?.handle || stat.handle,
        reason: `Low signal: ${useful} useful out of ${stat.fetchedCount}`,
        stats: { fetchedCount: stat.fetchedCount, recommendedCount: stat.recommendedCount, capturedCount: stat.capturedCount },
      };
    });

  return { follow, mute };
}

function parseAgentJson(text: string): unknown {
  const cleaned = text
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, "");
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced?.[1] ?? cleaned;
  const start = source.search(/[\[{]/);
  if (start < 0) return null;
  const opening = source[start];
  const closing = opening === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === closing) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface TriageRow {
  index: number;
  score: number;
  action: "recommend" | "skip";
  topicCluster?: string;
  isPrimarySource?: boolean;
  whyRead?: string;
  whySkip?: string;
  connectsTo?: string;
}

function parseTriage(text: string): TriageRow[] | null {
  const value = parseAgentJson(text);
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items
      : null;
  if (!rows) return null;
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const index = typeof record.index === "number" ? record.index : Number(record.index);
    const score = typeof record.score === "number" ? record.score : Number(record.score);
    if (!Number.isFinite(index) || !Number.isFinite(score)) return [];
    const action = record.action === "recommend" || record.action === "skip"
      ? record.action
      : score >= 75 ? "recommend" : "skip";
    return [{
      index,
      score: Math.max(0, Math.min(100, score)),
      action,
      topicCluster: typeof record.topicCluster === "string" ? record.topicCluster.slice(0, 80) : undefined,
      isPrimarySource: record.isPrimarySource === true,
      whyRead: typeof record.whyRead === "string" ? record.whyRead : undefined,
      whySkip: typeof record.whySkip === "string" ? record.whySkip : undefined,
      connectsTo: typeof record.connectsTo === "string" ? record.connectsTo : undefined,
    }];
  });
}

function escapeText(value: string): string {
  return value.replace(/"/g, "'").replace(/\s+/g, " ");
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function triageCandidates(input: {
  candidates: MergedSignal[];
  userProfile: string;
  interests: string[];
  libraryContext: string;
  interactionContext: string;
  browserContext: string;
}): Promise<ScoredSignal[]> {
  const batches: MergedSignal[][] = [];
  for (let index = 0; index < input.candidates.length; index += BATCH_SIZE) {
    batches.push(input.candidates.slice(index, index + BATCH_SIZE));
  }
  const scoredBatches = await mapPool(batches, TRIAGE_CONCURRENCY, async (batch) => {
    const batchContext = batch.map((item, index) => {
      const echoes = item.relatedMentions.length ? `, related: ${item.relatedMentions.length}` : "";
      const length = item.rawLengthHint ? `, length: ${item.rawLengthHint}` : "";
      return `${index + 1}. [${item.channel}] "${escapeText(item.title).slice(0, 80)}" — ${escapeText(item.sourceName)}${length}${echoes}\n   ${escapeText(item.snippet).slice(0, 400)}`;
    }).join("\n");
    try {
      const response = await callAgent(promptRadarTriage({ ...input, batchContext }), "radarTriage");
      const rows = parseTriage(response);
      if (!rows) return batch.map((item) => unscored(item));
      const byIndex = new Map(rows.map((row) => [row.index, row]));
      return batch.map((item, index) => {
        const row = byIndex.get(index + 1);
        if (!row) {
          return { ...item, score: 0, action: "skip" as const, whySkip: "Not scored" };
        }
        return {
          ...item,
          score: row.score,
          action: row.action,
          topicCluster: row.topicCluster,
          isPrimarySource: row.isPrimarySource,
          whyRead: row.whyRead,
          whySkip: row.whySkip,
          connectsTo: row.connectsTo,
        };
      });
    } catch (error) {
      console.error("[radarTriage] Batch failed:", error);
      return batch.map((item) => unscored(item));
    }
  });
  return scoredBatches.flat();
}

function unscored(item: MergedSignal): ScoredSignal {
  return { ...item, score: 0, action: "skip", whySkip: "Curation unavailable" };
}

function browserSummary(items: SignalItem[]): string {
  const reads = items.filter((item) => item.channel === "browser");
  if (reads.length === 0) return "";
  const domains = new Map<string, number>();
  for (const item of reads) domains.set(item.sourceName, (domains.get(item.sourceName) ?? 0) + 1);
  const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([domain, count]) => `${domain} (${count})`).join(", ");
  const titles = reads.slice(0, 6).map((item) => `- ${item.title}`).join("\n");
  return `## Recent active reading in the browser\nDomains: ${top}\n${titles}`;
}

async function enrichReasons(
  recommendations: { follow: SourceRecommendation[]; mute: SourceRecommendation[] },
): Promise<{ follow: SourceRecommendation[]; mute: SourceRecommendation[] }> {
  if (recommendations.follow.length + recommendations.mute.length === 0) return recommendations;
  try {
    const response = await callAgent(promptSourceReasons({
      follow: recommendations.follow.map((item) => ({ sourceId: item.sourceId, sourceName: item.sourceName, channel: item.channel, reason: item.reason })),
      mute: recommendations.mute.map((item) => ({ sourceId: item.sourceId, sourceName: item.sourceName, channel: item.channel, reason: item.reason })),
    }), "radarSourceReasons");
    const parsed = parseAgentJson(response);
    if (!parsed || typeof parsed !== "object") return recommendations;
    const overlay = (items: SourceRecommendation[], rows: unknown): SourceRecommendation[] => {
      if (!Array.isArray(rows)) return items;
      const reasons = new Map(rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const record = row as { sourceId?: unknown; reason?: unknown };
        if (typeof record.sourceId !== "string" || typeof record.reason !== "string" || !record.reason.trim()) return [];
        return [[record.sourceId, record.reason.trim().slice(0, 120)] as const];
      }));
      return items.map((item) => reasons.has(item.sourceId) ? { ...item, reason: reasons.get(item.sourceId)! } : item);
    };
    const record = parsed as { follow?: unknown; mute?: unknown };
    return { follow: overlay(recommendations.follow, record.follow), mute: overlay(recommendations.mute, record.mute) };
  } catch (error) {
    console.error("[radarSourceReasons] Failed:", error);
    return recommendations;
  }
}

function braveToSignal(result: BraveSearchResult, capturedAt: string): SignalItem {
  let host = "search";
  try {
    host = result.meta_url?.hostname?.replace(/^www\./, "") || new URL(result.url).hostname.replace(/^www\./, "");
  } catch {
    host = result.meta_url?.hostname || "search";
  }
  const canonicalUrl = canonicalizeUrl(result.url);
  return {
    id: "",
    channel: "search",
    sourceId: `search:${host}`,
    sourceName: host,
    title: result.title,
    url: result.url,
    canonicalUrl,
    publishedAt: result.page_age && !Number.isNaN(Date.parse(result.page_age)) ? new Date(result.page_age).toISOString() : capturedAt,
    capturedAt,
    snippet: (result.description || "").slice(0, 1500),
    thumbnail: result.thumbnail?.src,
  };
}

function toFeedItem(item: ScoredSignal, status: RadarSourceStatus | undefined): FeedItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    publishedAt: item.publishedAt,
    source: item.sourceName,
    thumbnail: item.thumbnail,
    channel: item.channel,
    sourceId: item.sourceId,
    sourceName: item.sourceName,
    sourceStatus: status,
    rawLengthHint: item.rawLengthHint,
    topicCluster: item.topicCluster,
    isPrimarySource: item.isPrimarySource,
    relatedMentions: item.relatedMentions.length > 0 ? item.relatedMentions : undefined,
    scoring: {
      overall: item.score,
      action: item.action,
      whyRead: item.whyRead,
      whySkip: item.whySkip,
      connectsTo: item.connectsTo,
    },
  };
}

async function gatherInteractions(now = Date.now()): Promise<{ signals: InteractionSignals; total: number; context: string }> {
  const sources = await listSourcesForConnections(undefined, undefined, AGENT_CONTEXT_CONFIG.feedLibrarySources);
  const cutoff = now - AGENT_CONTEXT_CONFIG.interactionWindowDays * DAY_MS;
  const signals: InteractionSignals = {
    starredHighlights: [],
    dismissedHighlights: [],
    learnedConcepts: [],
    knewConcepts: [],
  };
  for (const source of sources) {
    for (const highlight of source.highlights) {
      if (!highlight.reactionAt || new Date(highlight.reactionAt).getTime() <= cutoff) continue;
      const entry = { text: highlight.text, sourceTitle: source.title, at: highlight.reactionAt };
      if (highlight.reaction === "star") signals.starredHighlights.push(entry);
      else if (highlight.reaction === "dismiss") signals.dismissedHighlights.push(entry);
    }
    for (const concept of source.concepts) {
      if (!concept.statusAt || new Date(concept.statusAt).getTime() <= cutoff) continue;
      const entry = { term: concept.term, sourceTitle: source.title, at: concept.statusAt };
      if (concept.status === "learned") signals.learnedConcepts.push(entry);
      else if (concept.status === "knew") signals.knewConcepts.push(entry);
    }
  }
  const starred = await loadStarredBriefings();
  for (const item of starred.items) {
    if (!item.starredAt || new Date(item.starredAt).getTime() <= cutoff) continue;
    signals.starredHighlights.push({ text: item.text, sourceTitle: "Feed Briefing", at: item.starredAt });
  }
  for (const list of Object.values(signals) as { at?: string }[][]) {
    list.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    list.splice(AGENT_CONTEXT_CONFIG.maxSignalsPerType);
  }
  const total = signals.starredHighlights.length + signals.dismissedHighlights.length
    + signals.learnedConcepts.length + signals.knewConcepts.length;
  return { signals, total, context: buildInteractionContext(signals) };
}

export async function curateRadarFeed(windowDays: RadarWindowDays): Promise<RadarFeedResult> {
  const generatedAt = new Date().toISOString();
  const now = Date.parse(generatedAt);
  const config = await loadUserConfig();
  const interests = config.feedInterests ?? [];
  const searchSources = config.searchSources ?? [];
  const sources = await loadRadarSources();
  const active = sources.filter((source) => source.status === "active"
    && (source.channel === "rss" || source.channel === "youtube" || source.channel === "podcast"));

  let attempted = 0;
  let failed = 0;
  await Promise.all(active.map(async (source) => {
    attempted += 1;
    try {
      const items = source.channel === "youtube"
        ? await fetchYoutubeSignals(source, windowDays, now)
        : source.channel === "podcast"
          ? await fetchPodcastSignals(source, windowDays, now)
          : await fetchRssSignals(source, windowDays, now);
      if (items.length > 0) await ingestSignalItems(items);
    } catch (error) {
      failed += 1;
      console.error(`[radar] ${source.id} failed:`, error);
    }
  }));

  let searchCallCount = 0;
  if (process.env.BRAVE_SEARCH_API_KEY && interests.length > 0) {
    attempted += 1;
    try {
      const searched = await searchNews(interests, searchSources, []);
      searchCallCount = searched.searchCallCount;
      if (searched.results.length > 0) {
        await ingestSignalItems(searched.results.map((result) => braveToSignal(result, generatedAt)));
      }
    } catch (error) {
      failed += 1;
      console.error("[radar] search failed:", error);
    }
  }

  const windowItems = await loadRadarItemsInWindow(windowDays, now);
  const history = await loadFeedHistory();
  const library = await listSources();
  const merged = filterAndMergeSignals({
    items: windowItems,
    mutedSourceIds: new Set(sources.filter((source) => source.status === "muted").map((source) => source.id)),
    seenUrls: new Set(history.seen.map((entry) => entry.url)),
    libraryUrls: new Set(library.map((source) => source.sourceUrl).filter((url): url is string => Boolean(url))),
  });

  const searchConfigured = Boolean(process.env.BRAVE_SEARCH_API_KEY);
  const rssOnlyMessage = !searchConfigured && interests.length > 0 && searchSources.length > 0
    ? "Search API key is not configured, so this feed is running in RSS-only mode. Add BRAVE_SEARCH_API_KEY to .env.local and restart the dev server to enable web search."
    : undefined;
  const legitimate = windowItems.length > 0 || (attempted > 0 && failed < attempted);
  const emptyMessage = active.length === 0 && interests.length === 0 && windowItems.length === 0
    ? "Add RSS feeds, YouTube channels, podcasts, or topics to Your Radar in Settings"
    : rssOnlyMessage ?? "No new items in this window";

  const interactions = await gatherInteractions(now);
  const librarySources = await listSourcesForConnections(undefined, undefined, AGENT_CONTEXT_CONFIG.feedLibrarySources);
  const libraryContext = librarySources.length > 0
    ? librarySources.slice(0, 15).map((source) => `- "${escapeText(source.title).slice(0, 60)}" (${source.concepts.slice(0, 3).map((concept) => concept.term).join(", ")})`).join("\n")
    : "Empty library";
  const userProfile = await loadProfileDoc("USER");

  let scored: ScoredSignal[] = [];
  if (merged.candidates.length > 0) {
    scored = await triageCandidates({
      candidates: merged.candidates,
      userProfile,
      interests,
      libraryContext,
      interactionContext: interactions.context,
      browserContext: browserSummary(windowItems),
    });
    const counts = new Map<string, { recommended: number; skipped: number; item: ScoredSignal }>();
    for (const item of scored) {
      if (item.whySkip === "Curation unavailable") continue;
      const current = counts.get(item.sourceId) ?? { recommended: 0, skipped: 0, item };
      if (item.action === "recommend") current.recommended += 1;
      else current.skipped += 1;
      counts.set(item.sourceId, current);
    }
    if (counts.size > 0) {
      await recordSourceEvents([...counts.values()].map((entry) => ({
        sourceId: entry.item.sourceId,
        sourceName: entry.item.sourceName,
        channel: entry.item.channel,
        url: entry.item.url,
        handle: entry.item.authorHandle,
        recommended: entry.recommended,
        skipped: entry.skipped,
      })));
    }
  }

  const folded = foldTopicClusters(scored);
  const stats = await loadSourceStats();
  const recommendations = selectSourceRecommendations({ sources, stats, scored });
  const sourceRecommendations = merged.candidates.length > 0
    ? await enrichReasons(recommendations)
    : recommendations;

  const statusById = new Map(sources.map((source) => [source.id, source.status]));
  const items = folded.items.map((item) => toFeedItem(item, statusById.get(item.sourceId)));
  const briefingSources = librarySources.map((source) => ({
    title: source.title,
    summary: source.summary,
    concepts: source.concepts.map((concept) => concept.term),
  }));
  const briefing = items.some((item) => item.scoring.action === "recommend")
    ? await generateBriefing(items, briefingSources, interactions.context, interests) ?? undefined
    : undefined;
  const insights = merged.candidates.length > 0 && interactions.total >= 3
    ? await generateInsights(interactions.signals, briefingSources, interests)
    : [];

  const signals: FeedSignals = {
    searchCalls: searchCallCount,
    rssFeedCount: sources.filter((source) => source.channel === "rss" && source.status === "active").length,
    radarCount: interests.length,
    libraryCount: librarySources.length,
    interactionCount: interactions.total,
    windowDays,
    channelCounts: merged.channelCounts,
    foldedDuplicates: folded.foldedDuplicates,
  };
  const message = items.length === 0 ? emptyMessage : rssOnlyMessage;
  const cache: FeedCache = {
    generatedAt,
    interests,
    items,
    message,
    briefing,
    signals,
    insights: insights.length > 0 ? insights : undefined,
    windowDays,
    sourceRecommendations,
  };
  const shouldCache = items.length > 0 || legitimate;
  if (shouldCache) await saveFeedCache(cache);

  return {
    items,
    interests,
    generatedAt,
    fromCache: false,
    message,
    briefing,
    signals,
    insights: insights.length > 0 ? insights : undefined,
    sourceRecommendations,
    windowDays,
  };
}
