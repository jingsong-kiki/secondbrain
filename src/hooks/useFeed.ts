"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { FeedItem, FeedSignals, InsightItem, RadarFeedbackRequest, RadarWindowDays, SourceRecommendation, StructuredBriefing } from "@/lib/types";
import { useLocalStorage } from "@/hooks/useLocalStorage";

interface FeedState {
  items: FeedItem[];
  interests: string[];
  generatedAt: string | null;
  fromCache: boolean;
  message?: string;
  briefing?: StructuredBriefing;
  signals?: FeedSignals;
  insights?: InsightItem[];
  sourceRecommendations?: {
    follow: SourceRecommendation[];
    mute: SourceRecommendation[];
  };
}

interface FeedPayload {
  items?: FeedItem[];
  interests?: string[];
  generatedAt?: string | null;
  fromCache?: boolean;
  message?: string;
  briefing?: StructuredBriefing;
  signals?: FeedSignals;
  insights?: InsightItem[];
  sourceRecommendations?: FeedState["sourceRecommendations"];
  windowDays?: RadarWindowDays;
  starredBriefingTexts?: string[];
  readBriefingTexts?: string[];
}

export function useFeed() {
  const [feed, setFeed] = useState<FeedState>({
    items: [],
    interests: [],
    generatedAt: null,
    fromCache: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useLocalStorage<string[]>("feed-dismissed", []);
  const dismissedSet = useMemo(() => new Set(dismissedIds), [dismissedIds]);
  const [starredTexts, setStarredTexts] = useState<Set<string>>(new Set());
  const [readBriefingTexts, setReadBriefingTexts] = useState<Set<string>>(new Set());
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState<RadarWindowDays>(3);
  const windowDaysRef = useRef<RadarWindowDays>(3);
  const feedRef = useRef(feed);
  feedRef.current = feed;
  // Mirrors selectedDate so an in-flight refresh can tell whether the user
  // navigated to a past snapshot while it was generating.
  const selectedDateRef = useRef<string | null>(null);
  const selectDate = useCallback((date: string | null) => {
    selectedDateRef.current = date;
    setSelectedDate(date);
  }, []);

  // Filter out dismissed items
  const visibleItems = feed.items.filter((item) => !dismissedSet.has(item.id));

  // Mark specific URLs as seen/unseen (called when user toggles briefing items)
  const markBriefingRead = useCallback((text: string, urls: string[]) => {
    setReadBriefingTexts(prev => new Set(prev).add(text));
    fetch("/api/feed/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, text }),
    }).catch(() => {});
  }, []);

  const markBriefingUnread = useCallback((text: string, urls: string[]) => {
    setReadBriefingTexts(prev => {
      const next = new Set(prev);
      next.delete(text);
      return next;
    });
    fetch("/api/feed/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, unseen: true, text }),
    }).catch(() => {});
  }, []);

  const starBriefingItem = useCallback((text: string, meta?: { feedDate?: string; refs?: { url: string; title: string }[] }) => {
    setStarredTexts(prev => new Set(prev).add(text));
    fetch("/api/feed/star", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...meta }),
    }).catch(() => {});
  }, []);

  const unstarBriefingItem = useCallback((text: string) => {
    setStarredTexts(prev => {
      const next = new Set(prev);
      next.delete(text);
      return next;
    });
    fetch("/api/feed/star", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, unstar: true }),
    }).catch(() => {});
  }, []);

  const applyFeedPayload = useCallback((payload: FeedPayload, fromCache: boolean) => {
    if (payload.windowDays) {
      windowDaysRef.current = payload.windowDays;
      setWindowDays(payload.windowDays);
    }
    setFeed({
      items: payload.items ?? [],
      interests: payload.interests ?? [],
      generatedAt: payload.generatedAt ?? null,
      fromCache,
      message: payload.message,
      briefing: payload.briefing,
      signals: payload.signals,
      insights: payload.insights,
      sourceRecommendations: payload.sourceRecommendations,
    });
    if (payload.starredBriefingTexts) setStarredTexts(new Set(payload.starredBriefingTexts));
    if (payload.readBriefingTexts) setReadBriefingTexts(new Set(payload.readBriefingTexts));
  }, []);

  const loadFeed = useCallback(async (days?: RadarWindowDays) => {
    setLoading(true);
    setError(null);
    const requested = days ?? windowDaysRef.current;

    try {
      const res = await fetch(`/api/feed?days=${requested}`);
      const data = await res.json();

      if (data.success && data.feed) {
        applyFeedPayload(data.feed, data.feed.fromCache ?? false);
        if (data.availableDates) {
          setAvailableDates(data.availableDates);
        }
      } else if (data.message) {
        // Feed disabled or no API key
        setFeed((prev) => ({ ...prev, message: data.message }));
      } else {
        setError(data.error || "Failed to load feed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load feed");
    } finally {
      setLoading(false);
    }
  }, [applyFeedPayload]);

  const refreshFeed = useCallback(async () => {
    setLoading(true);
    setError(null);
    selectDate(null);

    try {
      const res = await fetch("/api/feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windowDays: windowDaysRef.current }),
      });
      const data = await res.json();

      if (data.success && data.feed) {
        if (data.availableDates) {
          setAvailableDates(data.availableDates);
        }
        // The user switched to a past snapshot while this refresh was
        // generating — don't yank their view; the new feed is cached and
        // shows when they return to the latest view.
        if (selectedDateRef.current !== null) {
          return;
        }
        applyFeedPayload(data.feed, false);
      } else {
        setError(data.error || "Failed to refresh feed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh feed");
    } finally {
      setLoading(false);
    }
  }, [applyFeedPayload, selectDate]);

  const loadFeedForDate = useCallback(async (date: string | null) => {
    if (!date) {
      // Go back to current/latest feed
      selectDate(null);
      await loadFeed();
      return;
    }

    setLoading(true);
    setError(null);
    selectDate(date);

    try {
      const res = await fetch(`/api/feed?date=${date}`);
      const data = await res.json();

      if (data.success && data.feed) {
        applyFeedPayload(data.feed, true);
        if (data.availableDates) {
          setAvailableDates(data.availableDates);
        }
      } else {
        setError(data.error || "Failed to load feed for date");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load feed for date");
    } finally {
      setLoading(false);
    }
  }, [applyFeedPayload, loadFeed, selectDate]);

  const changeWindow = useCallback(async (days: RadarWindowDays) => {
    windowDaysRef.current = days;
    setWindowDays(days);
    selectDate(null);
    await loadFeed(days);
  }, [loadFeed, selectDate]);

  const recordRadarFeedback = useCallback((payload: RadarFeedbackRequest) => {
    if (payload.action === "mute") {
      setFeed((prev) => ({
        ...prev,
        items: prev.items.filter((item) => item.sourceId !== payload.sourceId),
        sourceRecommendations: prev.sourceRecommendations && {
          follow: prev.sourceRecommendations.follow.filter((item) => item.sourceId !== payload.sourceId),
          mute: prev.sourceRecommendations.mute.filter((item) => item.sourceId !== payload.sourceId),
        },
      }));
    } else if (payload.action === "follow") {
      setFeed((prev) => ({
        ...prev,
        items: prev.items.map((item) => item.sourceId === payload.sourceId ? { ...item, sourceStatus: "active" as const } : item),
        sourceRecommendations: prev.sourceRecommendations && {
          follow: prev.sourceRecommendations.follow.filter((item) => item.sourceId !== payload.sourceId),
          mute: prev.sourceRecommendations.mute,
        },
      }));
    }
    fetch("/api/radar/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }, []);

  const followSource = useCallback((recommendation: SourceRecommendation) => {
    recordRadarFeedback({
      action: "follow",
      sourceId: recommendation.sourceId,
      channel: recommendation.channel,
      sourceName: recommendation.sourceName,
      url: recommendation.url,
      handle: recommendation.handle,
    });
  }, [recordRadarFeedback]);

  const muteSource = useCallback((sourceId: string) => {
    const current = feedRef.current;
    const item = current.items.find((entry) => entry.sourceId === sourceId);
    const recommendation = current.sourceRecommendations?.mute.find((entry) => entry.sourceId === sourceId)
      ?? current.sourceRecommendations?.follow.find((entry) => entry.sourceId === sourceId);
    recordRadarFeedback({
      action: "mute",
      sourceId,
      channel: item?.channel ?? recommendation?.channel,
      sourceName: item?.sourceName ?? recommendation?.sourceName,
      url: recommendation?.url ?? item?.url,
      handle: recommendation?.handle,
    });
  }, [recordRadarFeedback]);

  const dismissItem = useCallback((id: string) => {
    setDismissedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, [setDismissedIds]);

  return {
    items: visibleItems,
    interests: feed.interests,
    generatedAt: feed.generatedAt,
    fromCache: feed.fromCache,
    message: feed.message,
    briefing: feed.briefing,
    signals: feed.signals,
    insights: feed.insights,
    starredBriefingTexts: starredTexts,
    readBriefingTexts,
    availableDates,
    selectedDate,
    windowDays,
    sourceRecommendations: feed.sourceRecommendations,
    loading,
    error,
    loadFeed,
    refreshFeed,
    loadFeedForDate,
    changeWindow,
    followSource,
    muteSource,
    recordRadarFeedback,
    dismissItem,
    markBriefingRead,
    markBriefingUnread,
    starBriefingItem,
    unstarBriefingItem,
  };
}
