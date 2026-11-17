import { NextRequest, NextResponse } from "next/server";
import { FEED_CONFIG } from "@/lib/config";
import { curateRadarFeed, parseWindowDays } from "@/lib/radarCurator";
import { listFeedSnapshots, loadFeedCache, loadFeedHistory, loadFeedSnapshot, loadStarredBriefings } from "@/lib/storage";
import type { FeedCache, RadarWindowDays } from "@/lib/types";

function isCacheFresh(cache: FeedCache, days: RadarWindowDays): boolean {
  if (cache.windowDays !== days) return false;
  const generatedAt = new Date(cache.generatedAt).getTime();
  const cacheAgeHours = (Date.now() - generatedAt) / (1000 * 60 * 60);
  return cacheAgeHours < FEED_CONFIG.cacheHours;
}

function feedPayload(cache: FeedCache, fromCache: boolean, starred: string[], read: string[]) {
  return {
    items: cache.items,
    interests: cache.interests,
    generatedAt: cache.generatedAt,
    fromCache,
    briefing: cache.briefing,
    signals: cache.signals,
    insights: cache.insights,
    message: cache.message,
    windowDays: cache.windowDays,
    sourceRecommendations: cache.sourceRecommendations,
    starredBriefingTexts: starred,
    readBriefingTexts: read,
  };
}

export async function GET(request: NextRequest) {
  try {
    const availableDates = await listFeedSnapshots();
    const dateParam = request.nextUrl.searchParams.get("date");
    if (dateParam) {
      const snapshot = await loadFeedSnapshot(dateParam);
      if (!snapshot) {
        return NextResponse.json(
          { success: false, error: `No feed snapshot for ${dateParam}` },
          { status: 404 },
        );
      }
      const starredBriefings = await loadStarredBriefings();
      const snapshotHistory = await loadFeedHistory();
      return NextResponse.json({
        success: true,
        feed: feedPayload(
          snapshot,
          true,
          starredBriefings.items.map((item) => item.text),
          snapshotHistory.readTexts ?? [],
        ),
        availableDates,
      });
    }

    const days = parseWindowDays(request.nextUrl.searchParams.get("days"));
    const starredBriefings = await loadStarredBriefings();
    const history = await loadFeedHistory();
    const starred = starredBriefings.items.map((item) => item.text);
    const read = history.readTexts ?? [];

    const cache = await loadFeedCache();
    if (cache && isCacheFresh(cache, days)) {
      return NextResponse.json({
        success: true,
        feed: feedPayload(cache, true, starred, read),
        availableDates,
      });
    }

    const feedResult = await curateRadarFeed(days);
    const updatedDates = await listFeedSnapshots();
    return NextResponse.json({
      success: true,
      feed: { ...feedResult, starredBriefingTexts: starred, readBriefingTexts: read },
      availableDates: updatedDates,
    });
  } catch (error) {
    console.error("[GET /api/feed] Error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = parseWindowDays(
      body && typeof body === "object" ? (body as { windowDays?: unknown; days?: unknown }).windowDays ?? (body as { days?: unknown }).days : undefined,
    );
    const feedResult = await curateRadarFeed(days);
    const starredBriefings = await loadStarredBriefings();
    const history = await loadFeedHistory();
    const availableDates = await listFeedSnapshots();
    return NextResponse.json({
      success: true,
      feed: {
        ...feedResult,
        starredBriefingTexts: starredBriefings.items.map((item) => item.text),
        readBriefingTexts: history.readTexts ?? [],
      },
      availableDates,
    });
  } catch (error) {
    console.error("[POST /api/feed] Error:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
