import { describe, expect, it } from "vitest";
import {
  filterAndMergeSignals,
  foldTopicClusters,
  selectSourceRecommendations,
  type ScoredSignal,
} from "@/lib/radarCurator";
import { canonicalizeUrl } from "@/lib/radarStorage";
import type { RadarSource, SignalItem, SourceStats } from "@/lib/types";

function signal(overrides: Partial<SignalItem> & Pick<SignalItem, "channel" | "sourceId" | "url" | "title">): SignalItem {
  const canonicalUrl = overrides.canonicalUrl ?? canonicalizeUrl(overrides.url);
  return {
    id: overrides.id ?? canonicalUrl,
    channel: overrides.channel,
    sourceId: overrides.sourceId,
    sourceName: overrides.sourceName ?? overrides.sourceId,
    title: overrides.title,
    url: overrides.url,
    canonicalUrl,
    publishedAt: overrides.publishedAt ?? "2026-11-16T12:00:00.000Z",
    capturedAt: overrides.capturedAt ?? "2026-11-16T12:00:00.000Z",
    snippet: overrides.snippet ?? "This snippet is long enough to survive the short-tweet filter easily.",
    outboundUrls: overrides.outboundUrls,
    engagement: overrides.engagement,
    authorHandle: overrides.authorHandle,
    rawLengthHint: overrides.rawLengthHint,
  };
}

function scored(overrides: Partial<ScoredSignal> & Pick<ScoredSignal, "channel" | "sourceId" | "url" | "title" | "score" | "action">): ScoredSignal {
  return {
    ...signal(overrides),
    relatedMentions: overrides.relatedMentions ?? [],
    score: overrides.score,
    action: overrides.action,
    topicCluster: overrides.topicCluster,
    isPrimarySource: overrides.isPrimarySource,
    whyRead: overrides.whyRead,
    whySkip: overrides.whySkip,
  };
}

describe("stage 1 filtering and cross-channel merge", () => {
  const article = signal({
    channel: "rss",
    sourceId: "rss:hn",
    sourceName: "HN",
    title: "Primary",
    url: "https://example.com/post?utm_source=tw",
    snippet: "The article body",
    engagement: { dwellSeconds: 5 },
  });
  const quote = signal({
    channel: "x",
    sourceId: "x:@ada",
    sourceName: "@ada",
    title: "look",
    url: "https://x.com/ada/status/1",
    snippet: "This is a long enough tweet about the article that exceeds forty characters.",
    outboundUrls: ["https://www.example.com/post/"],
    engagement: { dwellSeconds: 12, likesOrReplies: 4 },
  });
  const shortTweet = signal({
    channel: "x",
    sourceId: "x:@bob",
    sourceName: "@bob",
    title: "hi",
    url: "https://x.com/bob/status/2",
    snippet: "too short",
  });
  const linkedTweet = signal({
    channel: "x",
    sourceId: "x:@cara",
    sourceName: "@cara",
    title: "link",
    url: "https://x.com/cara/status/3",
    snippet: "short",
    outboundUrls: ["https://other.test/a"],
  });
  const reading = signal({
    channel: "browser",
    sourceId: "browser:example.com",
    sourceName: "example.com",
    title: "Primary",
    url: "https://example.com/post",
    snippet: "read it closely",
    engagement: { scrollDepth: 0.8 },
  });

  it("drops muted, seen, library, and empty tweets, then folds echoes onto the article", () => {
    const result = filterAndMergeSignals({
      items: [
        article,
        quote,
        shortTweet,
        linkedTweet,
        reading,
        signal({ channel: "podcast", sourceId: "pod:muted", url: "https://pods.example/1", title: "Muted" }),
        signal({ channel: "youtube", sourceId: "yt:1", url: "https://youtube.com/watch?v=seen", title: "Seen" }),
        signal({ channel: "rss", sourceId: "rss:lib", url: "https://library.example/a", title: "Saved" }),
      ],
      mutedSourceIds: new Set(["pod:muted"]),
      seenUrls: new Set(["https://www.youtube.com/watch?v=seen"]),
      libraryUrls: new Set(["https://library.example/a?utm_source=sb"]),
    });

    expect(result.channelCounts).toEqual({ rss: 1, x: 2, browser: 1 });
    expect(result.candidates.map((candidate) => candidate.sourceId).sort()).toEqual(["rss:hn", "x:@cara"]);
    const primary = result.candidates.find((candidate) => candidate.sourceId === "rss:hn");
    expect(primary?.snippet).toBe("The article body");
    expect(primary?.relatedMentions.map((mention) => mention.channel)).toEqual(["x", "browser"]);
    expect(primary?.engagement).toMatchObject({ dwellSeconds: 12, scrollDepth: 0.8, likesOrReplies: 4 });
  });
});

describe("stage 3 topic folding", () => {
  it("keeps the primary source and counts folded echoes", () => {
    const result = foldTopicClusters([
      scored({ channel: "x", sourceId: "x:@a", url: "https://x.com/a/status/1", title: "quote", score: 99, action: "recommend", topicCluster: "AI Agents", isPrimarySource: false }),
      scored({ channel: "rss", sourceId: "rss:1", url: "https://example.com/agents", title: "report", score: 70, action: "recommend", topicCluster: "ai-agents", isPrimarySource: true }),
      scored({ channel: "youtube", sourceId: "yt:1", url: "https://youtube.com/watch?v=talk", title: "talk", score: 95, action: "recommend", topicCluster: "AI Agents", isPrimarySource: false }),
      scored({ channel: "podcast", sourceId: "pod:1", url: "https://pods.example/other", title: "other", score: 80, action: "recommend", topicCluster: "other story" }),
      scored({ channel: "rss", sourceId: "rss:skip", url: "https://example.com/skip", title: "skip", score: 20, action: "skip", topicCluster: "ai-agents" }),
    ]);

    expect(result.foldedDuplicates).toBe(2);
    const agents = result.items.find((item) => item.url === "https://example.com/agents");
    expect(agents?.relatedMentions.map((mention) => mention.channel).sort()).toEqual(["x", "youtube"]);
    expect(result.items.filter((item) => item.action === "recommend").map((item) => item.url)).toEqual([
      "https://pods.example/other",
      "https://example.com/agents",
    ]);
    expect(result.items.some((item) => item.url === "https://example.com/skip")).toBe(true);
  });

  it("uses channel priority, then score, when nothing is marked primary", () => {
    const priority = foldTopicClusters([
      scored({ channel: "x", sourceId: "x:@a", url: "https://x.com/a/status/9", title: "hot take", score: 99, action: "recommend", topicCluster: "launch" }),
      scored({ channel: "podcast", sourceId: "pod:1", url: "https://pods.example/launch", title: "show", score: 60, action: "recommend", topicCluster: "launch" }),
    ]);
    expect(priority.items[0].url).toBe("https://pods.example/launch");
    expect(priority.foldedDuplicates).toBe(1);

    const score = foldTopicClusters([
      scored({ channel: "rss", sourceId: "rss:1", url: "https://example.com/low", title: "low", score: 70, action: "recommend", topicCluster: "score" }),
      scored({ channel: "youtube", sourceId: "yt:1", url: "https://youtube.com/watch?v=high", title: "high", score: 90, action: "recommend", topicCluster: "score" }),
    ]);
    expect(score.items[0].url).toBe("https://youtube.com/watch?v=high");
  });
});

describe("follow and mute selection", () => {
  const sources: RadarSource[] = [
    { id: "c-high", channel: "rss", label: "High", url: "https://high.example/feed", status: "candidate", addedAt: "2026-11-01T00:00:00.000Z" },
    { id: "c-low", channel: "youtube", label: "Low", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UClow", status: "candidate", addedAt: "2026-11-01T00:00:00.000Z" },
    { id: "active-good", channel: "rss", label: "Good", url: "https://good.example/feed", status: "active", addedAt: "2026-11-01T00:00:00.000Z" },
    { id: "muted", channel: "x", label: "@muted", url: "https://x.com/muted", handle: "@muted", status: "muted", addedAt: "2026-11-01T00:00:00.000Z" },
  ];
  const stats: SourceStats[] = [
    stat("worse", "rss", 20, 0, 0),
    stat("bad", "rss", 10, 1, 0),
    stat("boundary", "rss", 20, 3, 0),
    stat("young", "rss", 4, 0, 0),
    stat("c-high", "rss", 3, 9, 1),
  ];

  function stat(sourceId: string, channel: SourceStats["channel"], fetched: number, recommended: number, captured: number): SourceStats {
    return {
      sourceId,
      sourceName: sourceId,
      channel,
      fetchedCount: fetched,
      recommendedCount: recommended,
      skippedCount: 0,
      capturedCount: captured,
      dismissedCount: 0,
      lastSeenAt: "2026-11-16T00:00:00.000Z",
    };
  }

  const scoredItems = [
    scored({ channel: "rss", sourceId: "c-high", sourceName: "High", url: "https://high.example/1", title: "one", score: 80, action: "recommend" }),
    scored({ channel: "rss", sourceId: "c-high", sourceName: "High", url: "https://high.example/2", title: "two", score: 81, action: "recommend" }),
    scored({ channel: "rss", sourceId: "c-high", sourceName: "High", url: "https://high.example/3", title: "three", score: 82, action: "recommend" }),
    scored({ channel: "youtube", sourceId: "c-low", sourceName: "Low", url: "https://youtube.com/watch?v=1", title: "y1", score: 80, action: "recommend" }),
    scored({ channel: "youtube", sourceId: "c-low", sourceName: "Low", url: "https://youtube.com/watch?v=2", title: "y2", score: 80, action: "recommend" }),
    scored({ channel: "x", sourceId: "x:@new", sourceName: "@new", url: "https://x.com/new/status/1", title: "primary", score: 90, action: "recommend", isPrimarySource: true, authorHandle: "@new" }),
    scored({ channel: "x", sourceId: "x:@plain", sourceName: "@plain", url: "https://x.com/plain/status/1", title: "plain", score: 90, action: "recommend", isPrimarySource: false }),
    scored({ channel: "x", sourceId: "muted", sourceName: "@muted", url: "https://x.com/muted/status/1", title: "nope", score: 95, action: "recommend", isPrimarySource: true }),
    scored({ channel: "rss", sourceId: "active-good", sourceName: "Good", url: "https://good.example/1", title: "known", score: 99, action: "recommend", isPrimarySource: true }),
  ];

  it("selects candidate voices and low-signal active sources", () => {
    const activeSources: RadarSource[] = [
      ...sources,
      { id: "worse", channel: "rss", label: "Worse", url: "https://worse.example/feed", status: "active", addedAt: "2026-11-01T00:00:00.000Z" },
      { id: "bad", channel: "rss", label: "Bad", url: "https://bad.example/feed", status: "active", addedAt: "2026-11-01T00:00:00.000Z" },
      { id: "boundary", channel: "rss", label: "Boundary", url: "https://boundary.example/feed", status: "active", addedAt: "2026-11-01T00:00:00.000Z" },
      { id: "young", channel: "rss", label: "Young", url: "https://young.example/feed", status: "active", addedAt: "2026-11-01T00:00:00.000Z" },
    ];
    const result = selectSourceRecommendations({ sources: activeSources, stats, scored: scoredItems });

    expect(result.follow.map((item) => item.sourceId)).toEqual(["c-high", "c-low", "x:@new"]);
    expect(result.follow[0].reason).toBe("3 recommended in this window");
    expect(result.follow[0].stats).toEqual({ fetchedCount: 3, recommendedCount: 9, capturedCount: 1 });
    expect(result.follow.find((item) => item.sourceId === "x:@new")?.reason).toBe("Primary source scored 90");
    expect(result.mute.map((item) => item.sourceId)).toEqual(["worse", "bad"]);
    expect(result.mute[0].reason).toBe("Low signal: 0 useful out of 20");
  });

  it("caps follow suggestions at 5 and mute suggestions at 3", () => {
    const manySources: RadarSource[] = [];
    const manyStats: SourceStats[] = [];
    const manyScored = [];
    for (let index = 0; index < 6; index++) {
      const id = `c-${index}`;
      manySources.push({ id, channel: "rss", label: id, url: `https://c${index}.example/feed`, status: "candidate", addedAt: "2026-11-01T00:00:00.000Z" });
      manyScored.push(
        scored({ channel: "rss", sourceId: id, url: `https://c${index}.example/1`, title: `${id}-1`, score: 80, action: "recommend" }),
        scored({ channel: "rss", sourceId: id, url: `https://c${index}.example/2`, title: `${id}-2`, score: 80 + index, action: "recommend" }),
      );
    }
    for (let index = 0; index < 4; index++) {
      const id = `m-${index}`;
      manySources.push({ id, channel: "rss", label: id, url: `https://m${index}.example/feed`, status: "active", addedAt: "2026-11-01T00:00:00.000Z" });
      manyStats.push(stat(id, "rss", 10 + index, 0, 0));
    }
    const result = selectSourceRecommendations({ sources: manySources, stats: manyStats, scored: manyScored });
    expect(result.follow).toHaveLength(5);
    expect(result.mute).toHaveLength(3);
  });
});
