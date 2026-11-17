import { NextRequest, NextResponse } from "next/server";
import { RadarFeedbackSchema } from "@/lib/schemas";
import { recordSourceEvents, setRadarSourceStatus } from "@/lib/radarStorage";
import type { RadarSource } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const parsed = RadarFeedbackSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid radar feedback" },
        { status: 400 },
      );
    }
    const { action, sourceId, url, channel, sourceName, handle } = parsed.data;
    if (action === "capture" || action === "dismiss") {
      await recordSourceEvents([{
        sourceId,
        sourceName,
        channel,
        url,
        handle,
        captured: action === "capture" ? 1 : 0,
        dismissed: action === "dismiss" ? 1 : 0,
      }]);
      return NextResponse.json({ success: true });
    }

    const draft: Omit<RadarSource, "status" | "addedAt"> | undefined = channel
      ? {
          id: sourceId,
          channel,
          label: sourceName || sourceId,
          url: url || (channel === "x" && handle ? `https://x.com/${handle.replace(/^@/, "")}` : sourceId),
          handle,
        }
      : undefined;
    const status = action === "follow" ? "active" : "muted";
    const updated = await setRadarSourceStatus(sourceId, status, draft);
    if (!updated) {
      return NextResponse.json({ success: false, error: "Source not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, source: updated });
  } catch (error) {
    console.error("[POST /api/radar/feedback]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to record radar feedback" },
      { status: 500 },
    );
  }
}
