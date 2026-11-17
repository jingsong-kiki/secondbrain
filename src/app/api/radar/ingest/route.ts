import { NextRequest, NextResponse } from "next/server";
import { RadarIngestRequestSchema } from "@/lib/schemas";
import { canonicalizeUrl, ingestSignalItems, signalItemId } from "@/lib/radarStorage";
import type { SignalItem } from "@/lib/types";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const parsed = RadarIngestRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid radar ingest payload" },
        { status: 400, headers: corsHeaders },
      );
    }

    const capturedAt = new Date().toISOString();
    const items: SignalItem[] = parsed.data.items.map((item) => {
      const canonicalUrl = canonicalizeUrl(item.canonicalUrl || item.url);
      return {
        id: item.id || signalItemId(canonicalUrl),
        channel: item.channel,
        sourceId: item.sourceId,
        sourceName: item.sourceName,
        authorHandle: item.authorHandle,
        title: item.title,
        url: item.url,
        canonicalUrl,
        publishedAt: item.publishedAt || capturedAt,
        capturedAt: item.capturedAt || capturedAt,
        rawLengthHint: item.rawLengthHint,
        snippet: item.snippet.slice(0, 1500),
        outboundUrls: item.outboundUrls?.slice(0, 8),
        thumbnail: item.thumbnail,
        engagement: item.engagement,
      };
    });
    const result = await ingestSignalItems(items, { registerUnknown: true });
    return NextResponse.json(
      { success: true, ingested: result.ingested, deduplicated: result.deduplicated },
      { headers: corsHeaders },
    );
  } catch (error) {
    console.error("[POST /api/radar/ingest]", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to ingest radar items" },
      { status: 500, headers: corsHeaders },
    );
  }
}
