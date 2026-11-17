"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { theme } from "@/lib/theme";
import type { RssFeedSource } from "@/lib/storage";
import type { RadarSource, RadarSourceStatus } from "@/lib/types";

type AddChannel = "rss" | "youtube" | "podcast";

const PLACEHOLDERS: Record<AddChannel, string> = {
  rss: "https://example.com/feed.xml",
  youtube: "Channel URL, @handle, or Atom URL",
  podcast: "https://example.com/podcast.xml",
};

export function RadarSourcesSettings({
  active,
  palette,
  rssFeedKey,
  onRssFeedsChange,
}: {
  active: boolean;
  palette: Record<number, string>;
  rssFeedKey: string;
  onRssFeedsChange?: (feeds: RssFeedSource[]) => void;
}) {
  const [sources, setSources] = useState<RadarSource[]>([]);
  const [channel, setChannel] = useState<AddChannel>("youtube");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const response = await fetch("/api/radar/sources");
    const data = await response.json();
    if (data.success) setSources(data.sources ?? []);
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch("/api/radar/sources")
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled && data.success) setSources(data.sources ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load radar sources");
      });
    return () => {
      cancelled = true;
    };
  }, [active, rssFeedKey]);

  const applyRss = (data: { rssFeeds?: RssFeedSource[] | null }) => {
    if (Array.isArray(data.rssFeeds)) onRssFeedsChange?.(data.rssFeeds);
  };

  const addSource = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/radar/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, url: trimmed, label: label.trim() || undefined }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || "Couldn't add that source");
        return;
      }
      setSources(data.sources ?? []);
      applyRss(data);
      setUrl("");
      setLabel("");
    } catch {
      setError("Couldn't add that source");
    } finally {
      setBusy(false);
    }
  };

  const updateSource = async (id: string, body: { status?: RadarSourceStatus; delete?: boolean }) => {
    setError(null);
    const response = await fetch("/api/radar/sources", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    const data = await response.json();
    if (!data.success) {
      setError(data.error || "Couldn't update that source");
      return;
    }
    setSources(data.sources ?? []);
    applyRss(data);
  };

  const visible = sources.filter((source) => source.channel !== "search");

  return (
    <div className="mb-6">
      <label className="block text-sm font-medium mb-2">Radar sources</label>
      <p className="text-xs text-gray-400 mb-3">YouTube channels, podcasts, and extra RSS feeds. Muted sources stay out of For You until you unmute them.</p>

      <div className="flex gap-2 mb-3">
        <select
          value={channel}
          onChange={(event) => setChannel(event.target.value as AddChannel)}
          className="px-2 py-2 text-sm border rounded-lg bg-white"
          style={{ borderColor: theme.border }}
        >
          <option value="youtube">YouTube</option>
          <option value="podcast">Podcast</option>
          <option value="rss">RSS</option>
        </select>
        <input
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Label"
          className="w-24 px-3 py-2 text-sm border rounded-lg"
          style={{ borderColor: theme.border }}
        />
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addSource();
          }}
          placeholder={PLACEHOLDERS[channel]}
          className="flex-1 px-3 py-2 text-sm border rounded-lg"
          style={{ borderColor: theme.border }}
        />
        <button
          type="button"
          onClick={() => void addSource()}
          disabled={!url.trim() || busy}
          className="px-3 py-2 rounded-lg text-white text-sm disabled:opacity-50"
          style={{ backgroundColor: palette[500] }}
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {error && <p className="text-xs mb-2" style={{ color: "#dc2626" }}>{error}</p>}

      <div className="space-y-2">
        {visible.map((source) => (
          <div key={source.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border" style={{ borderColor: theme.border }}>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{source.label}</span>
              <span className="block text-xs truncate" style={{ color: theme.textMuted }}>
                {source.channel} · {source.status}
              </span>
            </span>
            {source.status === "muted" || source.status === "candidate" ? (
              <button type="button" className="text-xs font-medium" style={{ color: palette[600] }} onClick={() => void updateSource(source.id, { status: "active" })}>
                {source.status === "muted" ? "Unmute" : "Follow"}
              </button>
            ) : (
              <button type="button" className="text-xs" style={{ color: theme.textMuted }} onClick={() => void updateSource(source.id, { status: "muted" })}>
                Mute
              </button>
            )}
            <button type="button" className="text-xs" style={{ color: "#dc2626" }} onClick={() => void updateSource(source.id, { delete: true })}>
              Remove
            </button>
          </div>
        ))}
        {visible.length === 0 && active && (
          <button type="button" className="text-xs underline" style={{ color: theme.textMuted }} onClick={() => void reload()}>
            No radar sources yet
          </button>
        )}
      </div>
    </div>
  );
}
