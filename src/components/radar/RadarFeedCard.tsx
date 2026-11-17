"use client";

import { useState } from "react";
import { ExternalLink, Plus, X } from "lucide-react";
import type { FeedItem, SignalChannel } from "@/lib/types";

const CHANNEL_LABEL: Record<SignalChannel, string> = {
  rss: "Article",
  search: "Article",
  youtube: "YouTube",
  podcast: "Podcast",
  x: "X",
  browser: "Browser",
};

export function RadarFeedCard({
  item,
  index,
  onCapture,
  onDismiss,
  onFollow,
  onMute,
  formatRelativeTime,
  theme,
}: {
  item: FeedItem;
  index: number;
  onCapture: (url: string) => void;
  onDismiss: (id: string) => void;
  onFollow?: (sourceId: string) => void;
  onMute?: (sourceId: string) => void;
  formatRelativeTime: (date: string) => string;
  theme: Record<string, string>;
}) {
  const [imgError, setImgError] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const accentColor = item.scoring.action === "recommend" ? "#059669" : "#6b7280";
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${item.source}&sz=64`;
  const mentions = item.relatedMentions ?? [];
  const sourceLabel = item.sourceName || item.source;
  const canFollow = item.sourceStatus === "candidate" && item.sourceId && onFollow;
  const canMute = item.sourceId && item.sourceStatus !== "candidate" && onMute;

  return (
    <div
      id={`feed-item-${index}`}
      className="rounded-xl border bg-white dark:bg-zinc-900 overflow-hidden transition-all hover:shadow-md group"
      style={{ borderColor: theme.border }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="relative h-32 bg-gradient-to-br from-slate-100 to-slate-50 overflow-hidden">
        {item.thumbnail && !imgError ? (
          <img src={item.thumbnail} alt="" className="w-full h-full object-cover" onError={() => setImgError(true)} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <img
              src={faviconUrl}
              alt=""
              className="w-12 h-12 opacity-30"
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        )}
        <div
          className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm"
          style={{ backgroundColor: accentColor }}
        >
          {index}
        </div>
        {item.channel && (
          <span className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/90 text-zinc-700">
            {CHANNEL_LABEL[item.channel]}
          </span>
        )}
        <div className={`absolute inset-0 bg-black/40 flex items-center justify-center gap-2 transition-opacity ${hovering ? "opacity-100" : "opacity-0"}`}>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCapture(item.url);
            }}
            className="px-3 py-1.5 bg-white dark:bg-zinc-700 rounded-lg text-xs font-medium shadow-sm hover:bg-gray-50 dark:hover:bg-zinc-600 transition-colors flex items-center gap-1"
            data-track="feed.card_save"
          >
            <Plus className="w-3.5 h-3.5" />
            Save
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 bg-white/90 dark:bg-zinc-700/90 rounded-lg text-xs font-medium shadow-sm hover:bg-white dark:hover:bg-zinc-600 transition-colors flex items-center gap-1"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open
          </a>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss(item.id);
          }}
          className={`absolute top-2 right-2 p-1 rounded-full bg-white/80 dark:bg-zinc-700/80 hover:bg-white dark:hover:bg-zinc-600 transition-all ${hovering ? "opacity-100" : "opacity-0"}`}
          data-track="feed.card_dismiss"
        >
          <X className="w-3.5 h-3.5" style={{ color: theme.textMuted }} />
        </button>
      </div>

      <div className="p-3">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="block">
          <h3 className="text-sm font-medium leading-snug line-clamp-2 mb-1 group-hover:underline" style={{ color: theme.text }}>
            {item.title}
          </h3>
          <div className="flex items-center gap-1.5 text-xs" style={{ color: theme.textMuted }}>
            <span className="truncate">{sourceLabel}</span>
            {item.rawLengthHint && (
              <>
                <span>·</span>
                <span className="shrink-0">{item.rawLengthHint}</span>
              </>
            )}
            <span>·</span>
            <span className="shrink-0">{formatRelativeTime(item.publishedAt)}</span>
          </div>
          {item.scoring.whyRead && (
            <p className="mt-2 text-xs leading-relaxed" style={{ color: theme.textMuted }}>{item.scoring.whyRead}</p>
          )}
          {item.scoring.connectsTo && (
            <div className="mt-2 text-xs flex items-start gap-1.5 px-2 py-1.5 rounded-md" style={{ backgroundColor: `${accentColor}10`, color: accentColor }}>
              <span className="opacity-70 flex-shrink-0">Related:</span>
              <span className="font-medium">{item.scoring.connectsTo}</span>
            </div>
          )}
        </a>

        {mentions.length > 0 && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setShowMentions((open) => !open)}
              className="px-2 py-0.5 rounded-full text-[11px] font-medium"
              style={{ backgroundColor: theme.bgMuted, color: theme.textMuted }}
              data-track="feed.related_mentions"
            >
              {mentions.length} related mention{mentions.length === 1 ? "" : "s"}
            </button>
            {showMentions && (
              <ul className="mt-2 space-y-1">
                {mentions.map((mention) => (
                  <li key={`${mention.channel}:${mention.url}`} className="text-xs" style={{ color: theme.textMuted }}>
                    <a href={mention.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                      {CHANNEL_LABEL[mention.channel]} · {mention.sourceName}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(canFollow || canMute) && (
          <div className="mt-2 flex gap-2">
            {canFollow && (
              <button
                type="button"
                onClick={() => onFollow?.(item.sourceId!)}
                className="px-2 py-1 rounded-md text-[11px] font-medium text-white"
                style={{ backgroundColor: accentColor }}
                data-track="feed.follow_source"
              >
                Follow
              </button>
            )}
            {canMute && (
              <button
                type="button"
                onClick={() => onMute?.(item.sourceId!)}
                className="px-2 py-1 rounded-md text-[11px] font-medium border"
                style={{ borderColor: theme.border, color: theme.textMuted }}
                data-track="feed.mute_source"
              >
                Mute
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
