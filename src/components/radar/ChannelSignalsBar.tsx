"use client";

import type { FeedSignals, SignalChannel } from "@/lib/types";

const LABELS: { channel: SignalChannel; label: string }[] = [
  { channel: "rss", label: "RSS" },
  { channel: "youtube", label: "YT" },
  { channel: "podcast", label: "Podcast" },
  { channel: "x", label: "X" },
  { channel: "browser", label: "Browser" },
  { channel: "search", label: "Search" },
];

export function ChannelSignalsBar({
  signals,
  palette,
  theme,
}: {
  signals?: FeedSignals;
  palette: Record<number, string>;
  theme: Record<string, string>;
}) {
  const counts = signals?.channelCounts;
  if (counts) {
    const parts = LABELS
      .filter((entry) => (counts[entry.channel] ?? 0) > 0)
      .map((entry) => `${counts[entry.channel]} ${entry.label}`);
    if (signals?.foldedDuplicates) parts.push(`${signals.foldedDuplicates} echoes folded`);
    if (parts.length === 0) return null;
    return (
      <div className="px-3 mb-4 text-xs" style={{ color: theme.textMuted }}>
        <span>Signals </span>
        <span style={{ color: palette[600] }}>{parts.join(" · ")}</span>
      </div>
    );
  }

  const legacy: string[] = [];
  if (signals?.rssFeedCount) legacy.push(`${signals.rssFeedCount} RSS feed${signals.rssFeedCount > 1 ? "s" : ""}`);
  if (signals?.radarCount) legacy.push(`${signals.radarCount} configured radar${signals.radarCount > 1 ? "s" : ""}`);
  if (legacy.length === 0) return null;
  return (
    <div className="px-3 mb-4 text-xs" style={{ color: theme.textMuted }}>
      <span>Curated from </span>
      <span style={{ color: palette[600] }}>{legacy.join(" and ")}</span>
    </div>
  );
}
