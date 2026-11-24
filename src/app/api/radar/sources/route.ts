import { NextRequest, NextResponse } from "next/server";
import { resolveYoutubeAtomUrl } from "@/lib/connectors/youtube";
import { RadarSourceCreateSchema, RadarSourcePatchSchema } from "@/lib/schemas";
import {
  deleteRadarSource,
  loadRadarSources,
  loadSourceStats,
  radarSourceId,
  setRadarSourceStatus,
  upsertRadarSource,
} from "@/lib/radarStorage";
import { loadUserConfig } from "@/lib/storage";
import type { RadarSource } from "@/lib/types";

async function rssFeeds() {
  const config = await loadUserConfig();
  return config.rssFeeds ?? null;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export async function GET() {
  try {
    const [sources, stats] = await Promise.all([loadRadarSources(), loadSourceStats()]);
    return NextResponse.json({ success: true, sources, stats, rssFeeds: await rssFeeds() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load radar sources" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = RadarSourceCreateSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid source" },
        { status: 400 },
      );
    }

    let url = parsed.data.url.trim();
    let label = parsed.data.label?.trim();
    let handle = parsed.data.handle?.trim();
    if (parsed.data.channel === "youtube") {
      const resolved = await resolveYoutubeAtomUrl(url);
      url = resolved.atomUrl;
      label = label || resolved.label || (resolved.handle ? `@${resolved.handle.replace(/^@/, "")}` : "YouTube");
      handle = handle || (resolved.handle ? `@${resolved.handle.replace(/^@/, "")}` : undefined);
    }
    if (parsed.data.channel === "x" && !handle) {
      const slug = url.startsWith("@") ? url.slice(1) : undefined;
      handle = slug ? `@${slug.replace(/^@/, "")}` : undefined;
    }

    const source: RadarSource = {
      id: radarSourceId(parsed.data.channel, url, handle),
      channel: parsed.data.channel,
      label: label || handle || hostLabel(url),
      url,
      handle,
      status: "active",
      addedAt: new Date().toISOString(),
    };
    const saved = await upsertRadarSource(source);
    const sources = await loadRadarSources();
    return NextResponse.json({ success: true, source: saved, sources, rssFeeds: await rssFeeds() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to add radar source" },
      { status: 400 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const parsed = RadarSourcePatchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid source update" },
        { status: 400 },
      );
    }
    if (parsed.data.delete) {
      const removed = await deleteRadarSource(parsed.data.id);
      if (!removed) {
        return NextResponse.json({ success: false, error: "Source not found" }, { status: 404 });
      }
    } else if (parsed.data.status) {
      const updated = await setRadarSourceStatus(parsed.data.id, parsed.data.status);
      if (!updated) {
        return NextResponse.json({ success: false, error: "Source not found" }, { status: 404 });
      }
    }
    const sources = await loadRadarSources();
    return NextResponse.json({ success: true, sources, rssFeeds: await rssFeeds() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to update radar source" },
      { status: 500 },
    );
  }
}
