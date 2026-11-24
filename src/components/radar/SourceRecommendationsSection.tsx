"use client";

import type { SignalChannel, SourceRecommendation } from "@/lib/types";

const CHANNEL_LABEL: Record<SignalChannel, string> = {
  rss: "RSS",
  youtube: "YouTube",
  podcast: "Podcast",
  x: "X",
  browser: "Browser",
  search: "Search",
};

function RecommendationList({
  title,
  items,
  actionLabel,
  onAction,
  palette,
  theme,
}: {
  title: string;
  items: SourceRecommendation[];
  actionLabel: string;
  onAction: (item: SourceRecommendation) => void;
  palette: Record<number, string>;
  theme: Record<string, string>;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: theme.textMuted }}>{title}</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.sourceId} className="flex items-start gap-3 rounded-lg border px-3 py-2" style={{ borderColor: theme.border }}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate" style={{ color: theme.text }}>
                {item.sourceName}
                <span className="ml-2 text-[10px] font-medium uppercase" style={{ color: theme.textMuted }}>{CHANNEL_LABEL[item.channel]}</span>
              </div>
              <p className="text-xs mt-0.5" style={{ color: theme.textMuted }}>{item.reason}</p>
            </div>
            <button
              type="button"
              onClick={() => onAction(item)}
              className="shrink-0 px-2.5 py-1 rounded-md text-xs font-medium text-white"
              style={{ backgroundColor: palette[500] }}
              data-track={actionLabel === "Follow" ? "feed.recommend_follow" : "feed.recommend_mute"}
            >
              {actionLabel}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SourceRecommendationsSection({
  follow,
  mute,
  onFollow,
  onMute,
  palette,
  theme,
}: {
  follow: SourceRecommendation[];
  mute: SourceRecommendation[];
  onFollow: (item: SourceRecommendation) => void;
  onMute: (sourceId: string) => void;
  palette: Record<number, string>;
  theme: Record<string, string>;
}) {
  if (follow.length === 0 && mute.length === 0) return null;
  return (
    <section className="mb-6 grid gap-4 md:grid-cols-2">
      <RecommendationList title="Worth Following" items={follow} actionLabel="Follow" onAction={onFollow} palette={palette} theme={theme} />
      <RecommendationList title="Low Signal" items={mute} actionLabel="Mute" onAction={(item) => onMute(item.sourceId)} palette={palette} theme={theme} />
    </section>
  );
}
