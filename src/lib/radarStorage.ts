import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_RSS_FEEDS } from "./config";
import { getCurrentRootPath, loadUserConfig, saveUserConfig, type RssFeedSource } from "./storage";
import type {
  RadarSource,
  RadarSourceStatus,
  SignalChannel,
  SignalEngagement,
  SignalItem,
  SourceStats,
} from "./types";

const DAY_MS = 86_400_000;
const TRACKING_KEYS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "si", "s"]);

export interface SourceStatEvent {
  sourceId: string;
  sourceName?: string;
  channel?: SignalChannel;
  url?: string;
  handle?: string;
  fetched?: number;
  recommended?: number;
  skipped?: number;
  captured?: number;
  dismissed?: number;
}

export interface AppendRadarResult {
  ingested: number;
  deduplicated: number;
}

interface SourceFile {
  sources: RadarSource[];
}

interface StatsFile {
  sources: SourceStats[];
}

let radarWriteTail: Promise<unknown> = Promise.resolve();

function withRadarLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = radarWriteTail.then(fn, fn);
  radarWriteTail = run.then(() => undefined, () => undefined);
  return run;
}

function radarDir(): string {
  return path.join(getCurrentRootPath(), ".radar");
}

function itemsDir(): string {
  return path.join(radarDir(), "items");
}

function sourcesPath(): string {
  return path.join(radarDir(), "sources.json");
}

function statsPath(): string {
  return path.join(radarDir(), "source_stats.json");
}

function isYoutubeHost(host: string): boolean {
  return host === "youtube.com"
    || host === "m.youtube.com"
    || host === "music.youtube.com"
    || host === "youtu.be"
    || host.endsWith(".youtube.com");
}

export function canonicalizeUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  if (host === "twitter.com" || host === "mobile.twitter.com") host = "x.com";
  parsed.hostname = host;

  const keepYoutubeTime = isYoutubeHost(host);
  const kept: [string, string][] = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("utm_") || TRACKING_KEYS.has(normalized)) continue;
    if (normalized === "t" && !keepYoutubeTime) continue;
    kept.push([key, value]);
  }
  parsed.search = kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : "";
  parsed.hash = "";
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

export function signalItemId(canonicalUrl: string): string {
  return createHash("sha1").update(canonicalUrl).digest("hex").slice(0, 16);
}

export function youtubeChannelIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const queryId = parsed.searchParams.get("channel_id");
    if (queryId && /^UC[\w-]{10,}$/.test(queryId)) return queryId;
    const match = parsed.pathname.match(/\/channel\/(UC[\w-]{10,})/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function radarSourceId(channel: SignalChannel, url: string, handle?: string): string {
  if (channel === "x") {
    const fromHandle = (handle || "").replace(/^@/, "").trim().toLowerCase();
    if (fromHandle) return `x:@${fromHandle}`;
    try {
      const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
      if (slug && slug !== "i" && slug !== "intent") return `x:@${slug.toLowerCase()}`;
    } catch {
      // Fall through to the hash id.
    }
  }
  if (channel === "browser") {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return `browser:${host}`;
    } catch {
      // Fall through to the hash id.
    }
  }
  if (channel === "youtube") {
    const channelId = youtubeChannelIdFromUrl(url);
    if (channelId) return `yt:${channelId}`;
  }
  const digest = createHash("sha1").update(`${channel}:${canonicalizeUrl(url)}`).digest("hex").slice(0, 12);
  const prefix = channel === "youtube" ? "yt" : channel;
  return `${prefix}:${digest}`;
}

function asList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && "sources" in data && Array.isArray((data as { sources: unknown }).sources)) {
    return (data as { sources: T[] }).sources;
  }
  return [];
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

async function readSources(): Promise<RadarSource[]> {
  const data = await readJson<unknown>(sourcesPath(), { sources: [] });
  return asList<RadarSource>(data);
}

async function writeSources(sources: RadarSource[]): Promise<void> {
  const payload: SourceFile = { sources };
  await writeAtomic(sourcesPath(), JSON.stringify(payload, null, 2));
}

async function readStats(): Promise<SourceStats[]> {
  const data = await readJson<unknown>(statsPath(), { sources: [] });
  return asList<SourceStats>(data);
}

async function writeStats(sources: SourceStats[]): Promise<void> {
  const payload: StatsFile = { sources };
  await writeAtomic(statsPath(), JSON.stringify(payload, null, 2));
}

function rssKey(url: string): string {
  return canonicalizeUrl(url);
}

function sameRssList(left: RssFeedSource[], right: RssFeedSource[]): boolean {
  const norm = (feeds: RssFeedSource[]) => feeds
    .map((feed) => `${rssKey(feed.url)}|${feed.label}`)
    .sort()
    .join("\n");
  return norm(left) === norm(right);
}

function mergeRssSources(sources: RadarSource[], configured: RssFeedSource[]): RadarSource[] {
  const configuredKeys = new Set(configured.map((feed) => rssKey(feed.url)));
  let changed = false;
  const next = sources.map((source) => {
    if (source.channel !== "rss") return source;
    const key = rssKey(source.url);
    if (configuredKeys.has(key)) {
      const feed = configured.find((item) => rssKey(item.url) === key);
      const label = feed?.label || source.label;
      if (source.status !== "active" || source.label !== label) {
        changed = true;
        return { ...source, status: "active" as const, label };
      }
      return source;
    }
    if (source.status === "active") {
      changed = true;
      return { ...source, status: "muted" as const };
    }
    return source;
  });

  const known = new Set(next.filter((source) => source.channel === "rss").map((source) => rssKey(source.url)));
  for (const feed of configured) {
    if (known.has(rssKey(feed.url))) continue;
    changed = true;
    next.push({
      id: radarSourceId("rss", feed.url),
      channel: "rss",
      label: feed.label,
      url: feed.url,
      status: "active",
      addedAt: new Date().toISOString(),
    });
  }
  return changed ? next : sources;
}

async function loadRadarSourcesUnlocked(): Promise<RadarSource[]> {
  const config = await loadUserConfig();
  const configured = config.rssFeeds ?? DEFAULT_RSS_FEEDS;
  const sources = await readSources();
  const merged = mergeRssSources(sources, configured);
  if (merged !== sources) await writeSources(merged);
  return merged;
}

async function syncActiveRssToConfig(sources: RadarSource[]): Promise<RssFeedSource[] | undefined> {
  const config = await loadUserConfig();
  const active = sources
    .filter((source) => source.channel === "rss" && source.status === "active")
    .map((source) => ({ url: source.url, label: source.label }));
  const current = config.rssFeeds;
  if (!current && sameRssList(active, DEFAULT_RSS_FEEDS)) return undefined;
  if (current && sameRssList(current, active)) return current;
  await saveUserConfig({ ...config, rssFeeds: active });
  return active;
}

function dayKey(iso: string): string {
  const parsed = Date.parse(iso);
  const safe = Number.isNaN(parsed) ? new Date() : new Date(parsed);
  const futureLimit = Date.now() + DAY_MS;
  const clamped = safe.getTime() > futureLimit ? new Date() : safe;
  return clamped.toISOString().slice(0, 10);
}

function maxOptional(left?: number, right?: number): number | undefined {
  if (typeof left !== "number" && typeof right !== "number") return undefined;
  return Math.max(typeof left === "number" ? left : Number.NEGATIVE_INFINITY, typeof right === "number" ? right : Number.NEGATIVE_INFINITY);
}

function mergeEngagement(left?: SignalEngagement, right?: SignalEngagement): SignalEngagement | undefined {
  const engagement: SignalEngagement = {
    dwellSeconds: maxOptional(left?.dwellSeconds, right?.dwellSeconds),
    scrollDepth: maxOptional(left?.scrollDepth, right?.scrollDepth),
    likesOrReplies: maxOptional(left?.likesOrReplies, right?.likesOrReplies),
  };
  if (engagement.dwellSeconds == null && engagement.scrollDepth == null && engagement.likesOrReplies == null) {
    return undefined;
  }
  return engagement;
}

function mergeItems(existing: SignalItem, incoming: SignalItem): SignalItem {
  const outbound = [...new Set([...(existing.outboundUrls ?? []), ...(incoming.outboundUrls ?? [])])].slice(0, 8);
  const snippet = (incoming.snippet?.trim().length ?? 0) > (existing.snippet?.trim().length ?? 0)
    ? incoming.snippet
    : existing.snippet;
  return {
    ...existing,
    title: incoming.title?.trim() ? incoming.title : existing.title,
    sourceName: incoming.sourceName || existing.sourceName,
    authorHandle: incoming.authorHandle || existing.authorHandle,
    rawLengthHint: incoming.rawLengthHint || existing.rawLengthHint,
    thumbnail: incoming.thumbnail || existing.thumbnail,
    snippet,
    outboundUrls: outbound.length > 0 ? outbound : undefined,
    engagement: mergeEngagement(existing.engagement, incoming.engagement),
  };
}

function normalizeIncoming(item: SignalItem, nowIso: string): SignalItem {
  const canonicalUrl = canonicalizeUrl(item.canonicalUrl || item.url);
  const capturedAt = item.capturedAt && !Number.isNaN(Date.parse(item.capturedAt))
    ? new Date(item.capturedAt).toISOString()
    : nowIso;
  let publishedAt = capturedAt;
  if (!Number.isNaN(Date.parse(item.publishedAt))) {
    publishedAt = new Date(item.publishedAt).toISOString();
  }
  if (Date.parse(publishedAt) > Date.now() + DAY_MS) publishedAt = nowIso;
  return {
    ...item,
    canonicalUrl,
    id: item.id || signalItemId(canonicalUrl),
    publishedAt,
    capturedAt,
    snippet: item.snippet ?? "",
  };
}

async function readDay(day: string): Promise<SignalItem[]> {
  try {
    const text = await fs.readFile(path.join(itemsDir(), `${day}.jsonl`), "utf-8");
    const items: SignalItem[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed) as SignalItem);
      } catch {
        // Skip a corrupt line rather than dropping the rest of the day.
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function writeDay(day: string, items: SignalItem[]): Promise<void> {
  const filePath = path.join(itemsDir(), `${day}.jsonl`);
  if (items.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await writeAtomic(filePath, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

async function appendRadarItemsUnlocked(items: SignalItem[]): Promise<AppendRadarResult> {
  if (items.length === 0) return { ingested: 0, deduplicated: 0 };
  const nowIso = new Date().toISOString();
  const byDay = new Map<string, SignalItem[]>();
  for (const item of items) {
    const normalized = normalizeIncoming(item, nowIso);
    const day = dayKey(normalized.publishedAt);
    const bucket = byDay.get(day) ?? [];
    bucket.push(normalized);
    byDay.set(day, bucket);
  }

  let ingested = 0;
  let deduplicated = 0;
  for (const [day, incoming] of byDay) {
    const disk = await readDay(day);
    const order: string[] = [];
    const map = new Map<string, SignalItem>();
    for (const existing of disk) {
      const key = existing.canonicalUrl || existing.id;
      if (!map.has(key)) order.push(key);
      map.set(key, existing);
    }
    for (const item of incoming) {
      const key = item.canonicalUrl;
      const previous = map.get(key);
      if (previous) {
        map.set(key, mergeItems(previous, item));
        deduplicated += 1;
      } else {
        map.set(key, item);
        order.push(key);
        ingested += 1;
      }
    }
    await writeDay(day, order.map((key) => map.get(key)!));
  }
  return { ingested, deduplicated };
}

async function recordSourceEventsUnlocked(events: SourceStatEvent[]): Promise<SourceStats[]> {
  if (events.length === 0) return readStats();
  const stats = await readStats();
  const byId = new Map(stats.map((entry) => [entry.sourceId, entry]));
  const now = new Date().toISOString();
  for (const event of events) {
    const current = byId.get(event.sourceId) ?? {
      sourceId: event.sourceId,
      sourceName: event.sourceName || event.sourceId,
      channel: event.channel || "rss",
      url: event.url,
      handle: event.handle,
      fetchedCount: 0,
      recommendedCount: 0,
      skippedCount: 0,
      capturedCount: 0,
      dismissedCount: 0,
      lastSeenAt: now,
    };
    current.fetchedCount += Math.max(0, event.fetched ?? 0);
    current.recommendedCount += Math.max(0, event.recommended ?? 0);
    current.skippedCount += Math.max(0, event.skipped ?? 0);
    current.capturedCount += Math.max(0, event.captured ?? 0);
    current.dismissedCount += Math.max(0, event.dismissed ?? 0);
    if (event.sourceName) current.sourceName = event.sourceName;
    if (event.channel) current.channel = event.channel;
    if (event.url) current.url = event.url;
    if (event.handle) current.handle = event.handle;
    current.lastSeenAt = now;
    byId.set(event.sourceId, current);
  }
  const next = [...byId.values()];
  await writeStats(next);
  return next;
}

async function ingestSignalItemsUnlocked(items: SignalItem[], registerUnknown: boolean): Promise<AppendRadarResult> {
  const nowIso = new Date().toISOString();
  const normalized = items.map((item) => normalizeIncoming(item, nowIso));
  if (registerUnknown && normalized.length > 0) {
    const sources = await loadRadarSourcesUnlocked();
    const known = new Set(sources.map((source) => source.id));
    let changed = false;
    for (const item of normalized) {
      if (known.has(item.sourceId)) continue;
      sources.push({
        id: item.sourceId,
        channel: item.channel,
        label: item.sourceName,
        url: item.channel === "x" && item.authorHandle
          ? `https://x.com/${item.authorHandle.replace(/^@/, "")}`
          : item.url,
        handle: item.authorHandle,
        status: "candidate",
        addedAt: nowIso,
      });
      known.add(item.sourceId);
      changed = true;
    }
    if (changed) await writeSources(sources);
  }

  const existingKeys = new Set<string>();
  const days = new Set(normalized.map((item) => dayKey(item.publishedAt)));
  for (const day of days) {
    for (const existing of await readDay(day)) {
      existingKeys.add(existing.canonicalUrl || existing.id);
    }
  }
  const result = await appendRadarItemsUnlocked(normalized);
  // Count each new canonical URL once. Repeats in the same request and URLs
  // already on disk are deduped by append and do not increment fetchedCount.
  const counted = new Set<string>();
  const events: SourceStatEvent[] = [];
  for (const item of normalized) {
    if (existingKeys.has(item.canonicalUrl) || counted.has(item.canonicalUrl)) continue;
    counted.add(item.canonicalUrl);
    events.push({
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      channel: item.channel,
      url: item.url,
      handle: item.authorHandle,
      fetched: 1,
    });
  }
  if (events.length > 0) await recordSourceEventsUnlocked(events);
  return result;
}

export function appendRadarItems(items: SignalItem[]): Promise<AppendRadarResult> {
  return withRadarLock(() => appendRadarItemsUnlocked(items));
}

export function ingestSignalItems(items: SignalItem[], options?: { registerUnknown?: boolean }): Promise<AppendRadarResult> {
  return withRadarLock(() => ingestSignalItemsUnlocked(items, options?.registerUnknown === true));
}

export async function loadRadarItemsInWindow(windowDays: number, now = Date.now()): Promise<SignalItem[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(itemsDir());
  } catch {
    return [];
  }
  const start = new Date(now - (windowDays + 1) * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(now).toISOString().slice(0, 10);
  const cutoff = now - windowDays * DAY_MS;
  const collected: SignalItem[] = [];
  for (const file of files) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!match || match[1] < start || match[1] > end) continue;
    collected.push(...await readDay(match[1]));
  }
  const byUrl = new Map<string, SignalItem>();
  for (const item of collected) {
    const key = item.canonicalUrl || item.id;
    const previous = byUrl.get(key);
    byUrl.set(key, previous ? mergeItems(previous, item) : item);
  }
  return [...byUrl.values()].filter((item) => {
    const published = Date.parse(item.publishedAt);
    return !Number.isNaN(published) && published >= cutoff;
  });
}

export function pruneOldRadarItems(retainDays = 30, now = Date.now()): Promise<number> {
  return withRadarLock(async () => {
    let files: string[] = [];
    try {
      files = await fs.readdir(itemsDir());
    } catch {
      return 0;
    }
    const cutoff = new Date(now - retainDays * DAY_MS).toISOString().slice(0, 10);
    let removed = 0;
    for (const file of files) {
      const match = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match || match[1] >= cutoff) continue;
      await fs.rm(path.join(itemsDir(), file), { force: true });
      removed += 1;
    }
    return removed;
  });
}

export function loadRadarSources(): Promise<RadarSource[]> {
  return withRadarLock(() => loadRadarSourcesUnlocked());
}

export function saveRadarSources(sources: RadarSource[]): Promise<void> {
  return withRadarLock(() => writeSources(sources));
}

export function upsertRadarSource(source: RadarSource): Promise<RadarSource> {
  return withRadarLock(async () => {
    const sources = await loadRadarSourcesUnlocked();
    const canonical = canonicalizeUrl(source.url);
    const index = sources.findIndex((existing) => existing.id === source.id
      || (existing.channel === source.channel && canonicalizeUrl(existing.url) === canonical));
    let saved: RadarSource;
    if (index >= 0) {
      const previous = sources[index];
      saved = {
        ...previous,
        ...source,
        id: previous.id,
        addedAt: previous.addedAt,
        status: source.status || previous.status,
      };
      sources[index] = saved;
    } else {
      saved = source;
      sources.push(source);
    }
    await writeSources(sources);
    if (saved.channel === "rss") await syncActiveRssToConfig(sources);
    return saved;
  });
}

export function setRadarSourceStatus(
  id: string,
  status: RadarSourceStatus,
  draft?: Omit<RadarSource, "status" | "addedAt"> & { addedAt?: string },
): Promise<RadarSource | null> {
  return withRadarLock(async () => {
    const sources = await loadRadarSourcesUnlocked();
    const index = sources.findIndex((source) => source.id === id);
    let saved: RadarSource;
    if (index >= 0) {
      saved = { ...sources[index], status };
      if (draft?.label) saved.label = sources[index].label || draft.label;
      if (!saved.url && draft?.url) saved.url = draft.url;
      if (!saved.handle && draft?.handle) saved.handle = draft.handle;
      sources[index] = saved;
    } else if (draft) {
      saved = {
        ...draft,
        id,
        status,
        addedAt: draft.addedAt || new Date().toISOString(),
      };
      sources.push(saved);
    } else {
      return null;
    }
    await writeSources(sources);
    if (saved.channel === "rss") await syncActiveRssToConfig(sources);
    return saved;
  });
}

export function deleteRadarSource(id: string): Promise<boolean> {
  return withRadarLock(async () => {
    const sources = await loadRadarSourcesUnlocked();
    const target = sources.find((source) => source.id === id);
    if (!target) return false;
    await writeSources(sources.filter((source) => source.id !== id));
    if (target.channel === "rss") await syncActiveRssToConfig(sources.filter((source) => source.id !== id));
    return true;
  });
}

export function loadSourceStats(): Promise<SourceStats[]> {
  return withRadarLock(() => readStats());
}

export function recordSourceEvents(events: SourceStatEvent[]): Promise<SourceStats[]> {
  return withRadarLock(() => recordSourceEventsUnlocked(events));
}

export async function recordCaptureForUrl(url: string): Promise<void> {
  const canonical = canonicalizeUrl(url);
  const items = await loadRadarItemsInWindow(30);
  const match = items.find((item) => item.canonicalUrl === canonical || canonicalizeUrl(item.url) === canonical);
  if (!match) return;
  await recordSourceEvents([{
    sourceId: match.sourceId,
    sourceName: match.sourceName,
    channel: match.channel,
    url: match.url,
    handle: match.authorHandle,
    captured: 1,
  }]);
}
