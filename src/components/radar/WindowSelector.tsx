"use client";

import type { RadarWindowDays } from "@/lib/types";

const OPTIONS: { days: RadarWindowDays; label: string }[] = [
  { days: 1, label: "24h" },
  { days: 3, label: "3d" },
  { days: 7, label: "7d" },
];

export function WindowSelector({
  days,
  disabled,
  onChange,
  palette,
  theme,
}: {
  days: RadarWindowDays;
  disabled?: boolean;
  onChange: (days: RadarWindowDays) => void;
  palette: Record<number, string>;
  theme: Record<string, string>;
}) {
  return (
    <div className="flex items-center rounded-lg border overflow-hidden" style={{ borderColor: theme.border }}>
      {OPTIONS.map((option) => {
        const active = option.days === days;
        return (
          <button
            key={option.days}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.days)}
            className="px-2.5 py-1 text-xs font-medium disabled:opacity-50"
            data-track="feed.window"
            style={{
              backgroundColor: active ? palette[500] : "transparent",
              color: active ? "white" : theme.textMuted,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
