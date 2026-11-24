import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { RadarIngestRequestSchema } from "@/lib/schemas";
import {
  appendRadarItems,
  canonicalizeUrl,
  loadRadarItemsInWindow,
  loadRadarSources,
  loadSourceStats,
  pruneOldRadarItems,
  recordSourceEvents,
  setRadarSourceStatus,
} from "@/lib/radarStorage";
import { clearUserDataInitializationCacheForTests, loadUserConfig } from "@/lib/storage";
import type { SignalItem } from "@/lib/types";

const ORIGINAL_ENV = { ...process.env };
let tmpRoot: string;

function item(overrides: Partial<SignalItem> & Pick<SignalItem, "url" | "title">): SignalItem {
  const publishedAt = overrides.publishedAt ?? "2026-11-16T18:00:00.000Z";
  return {
    id: overrides.id ?? "temp",
    channel: overrides.channel ?? "rss",
    sourceId: overrides.sourceId ?? "rss:test",
    sourceName: overrides.sourceName ?? "Test",
    title: overrides.title,
    url: overrides.url,
    canonicalUrl: overrides.canonicalUrl ?? overrides.url,
    publishedAt,
    capturedAt: overrides.capturedAt ?? publishedAt,
    snippet: overrides.snippet ?? "A useful snippet that is long enough to keep.",
    outboundUrls: overrides.outboundUrls,
    engagement: overrides.engagement,
    rawLengthHint: overrides.rawLengthHint,
    thumbnail: overrides.thumbnail,
    authorHandle: overrides.authorHandle,
  };
}

beforeEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "secondbrain-radar-"));
  process.env.SECONDBRAIN_ROOT = tmpRoot;
  clearUserDataInitializationCacheForTests();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  clearUserDataInitializationCacheForTests();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("canonicalizeUrl", () => {
  it("strips tracking params, www, and trailing slashes", () => {
    expect(canonicalizeUrl("https://www.Example.com/foo/?utm_source=tw&fbclid=1&gclid=2")).toBe("https://example.com/foo");
    expect(canonicalizeUrl("https://www.Example.com/")).toBe("https://example.com/");
  });

  it("maps twitter.com to x.com", () => {
    expect(canonicalizeUrl("https://twitter.com/karpathy/status/1/")).toBe("https://x.com/karpathy/status/1");
  });

  it("keeps YouTube watch params that identify the video and timestamp", () => {
    const url = new URL(canonicalizeUrl("https://www.YouTube.com/watch?v=abc&t=12s&si=xyz&utm_source=tw"));
    expect(url.hostname).toBe("youtube.com");
    expect(url.pathname).toBe("/watch");
    expect(url.searchParams.get("v")).toBe("abc");
    expect(url.searchParams.get("t")).toBe("12s");
    expect(url.searchParams.has("si")).toBe(false);
    expect(url.searchParams.has("utm_source")).toBe(false);
    expect(canonicalizeUrl("https://example.com/a?t=1&s=2")).toBe("https://example.com/a");
    const short = new URL(canonicalizeUrl("https://youtu.be/abc?t=10&si=zz"));
    expect(short.hostname).toBe("youtu.be");
    expect(short.searchParams.get("t")).toBe("10");
    expect(short.searchParams.has("si")).toBe(false);
  });
});

describe("radar item storage", () => {
  it("appends daily jsonl, dedupes, and merges the richer snippet and engagement", async () => {
    const url = "https://www.example.com/post/?utm_source=nl";
    await appendRadarItems([item({
      url,
      title: "First",
      snippet: "short",
      engagement: { dwellSeconds: 10, likesOrReplies: 1 },
    })]);
    await appendRadarItems([item({
      url,
      title: "First",
      snippet: "a much longer snippet with the actual paragraph",
      engagement: { dwellSeconds: 4, scrollDepth: 0.8 },
    })]);

    const dayFile = path.join(tmpRoot, ".radar", "items", "2026-11-16.jsonl");
    const lines = (await fs.readFile(dayFile, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);

    const now = Date.parse("2026-11-17T12:00:00.000Z");
    const loaded = await loadRadarItemsInWindow(3, now);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].canonicalUrl).toBe("https://example.com/post");
    expect(loaded[0].snippet).toContain("much longer");
    expect(loaded[0].engagement).toMatchObject({ dwellSeconds: 10, scrollDepth: 0.8, likesOrReplies: 1 });
  });

  it("filters strictly to the requested window", async () => {
    const now = Date.parse("2026-11-17T12:00:00.000Z");
    await appendRadarItems([
      item({ url: "https://example.com/inside", title: "Inside", publishedAt: "2026-11-16T12:00:00.000Z" }),
      item({ url: "https://example.com/outside", title: "Outside", publishedAt: "2026-11-16T11:59:59.000Z" }),
      item({ url: "https://example.com/old", title: "Old", publishedAt: "2026-11-10T12:00:00.000Z" }),
    ]);

    const loaded = await loadRadarItemsInWindow(1, now);
    expect(loaded.map((entry) => entry.title)).toEqual(["Inside"]);
  });

  it("prunes daily files older than the retention window", async () => {
    await appendRadarItems([
      item({ url: "https://example.com/old", title: "Old", publishedAt: "2026-01-01T00:00:00.000Z" }),
      item({ url: "https://example.com/recent", title: "Recent", publishedAt: "2026-11-10T00:00:00.000Z" }),
    ]);
    const removed = await pruneOldRadarItems(30, Date.parse("2026-11-17T00:00:00.000Z"));
    expect(removed).toBe(1);
    const files = await fs.readdir(path.join(tmpRoot, ".radar", "items"));
    expect(files).toEqual(["2026-11-10.jsonl"]);
  });
});

describe("radar sources and stats", () => {
  it("seeds RSS sources from config and keeps them in sync when muted", async () => {
    await fs.writeFile(path.join(tmpRoot, "config.json"), JSON.stringify({
      rssFeeds: [{ url: "https://example.com/feed.xml", label: "Example" }],
    }));

    const first = await loadRadarSources();
    const second = await loadRadarSources();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ channel: "rss", status: "active", label: "Example" });
    expect(second[0].id).toBe(first[0].id);

    await setRadarSourceStatus(first[0].id, "muted");
    const config = await loadUserConfig();
    expect(config.rssFeeds).toEqual([]);
  });

  it("applies concurrent stat updates without losing increments", async () => {
    await Promise.all(Array.from({ length: 20 }, () => recordSourceEvents([{
      sourceId: "s1",
      sourceName: "Source",
      channel: "rss",
      fetched: 1,
    }])));
    const stats = await loadSourceStats();
    expect(stats.find((entry) => entry.sourceId === "s1")?.fetchedCount).toBe(20);
  });
});

describe("radar ingest schema", () => {
  it("accepts a minimal item and rejects more than 100", () => {
    const itemPayload = {
      channel: "x",
      sourceId: "x:@ada",
      sourceName: "@ada",
      title: "A tweet",
      url: "https://x.com/ada/status/1",
    };
    expect(RadarIngestRequestSchema.safeParse({ items: [itemPayload] }).success).toBe(true);
    expect(RadarIngestRequestSchema.safeParse({ items: Array.from({ length: 101 }, () => itemPayload) }).success).toBe(false);
  });
});
