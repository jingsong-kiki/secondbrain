import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { youtubeChannelIdFromUrl } from "@/lib/radarStorage";
import type { RadarSource, SignalItem } from "@/lib/types";
import {
  clip,
  decodeEntities,
  fetchText,
  htmlToText,
  isWithinDays,
  stripCaptionText,
  toIsoDate,
  toSignalItem,
  xmlBlocks,
  xmlText,
} from "./text";

const execFileAsync = promisify(execFile);

export interface YoutubeInspection {
  atomUrl?: string;
  channelId?: string;
  fetchUrl?: string;
  handle?: string;
}

export function inspectYoutubeInput(input: string): YoutubeInspection {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) {
    const handle = trimmed.slice(1);
    return { fetchUrl: `https://www.youtube.com/@${handle}`, handle };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return {};
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "youtube.com" && !host.endsWith(".youtube.com") && host !== "youtu.be") return {};
  if (url.pathname === "/feeds/videos.xml" || url.pathname.endsWith("/feeds/videos.xml")) {
    const channelId = youtubeChannelIdFromUrl(url.toString());
    return {
      channelId,
      atomUrl: channelId ? `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` : url.toString(),
    };
  }
  const channelId = youtubeChannelIdFromUrl(url.toString());
  if (channelId) {
    return { channelId, atomUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}` };
  }
  const handle = url.pathname.match(/^\/@([^/]+)/)?.[1];
  if (handle) return { fetchUrl: `https://www.youtube.com/@${handle}`, handle };
  if (/^\/(c|user)\//.test(url.pathname)) return { fetchUrl: url.toString() };
  return {};
}

export function extractYoutubeChannelId(html: string): string | null {
  return html.match(/<meta[^>]*itemprop="channelId"[^>]*content="(UC[\w-]{10,})"/i)?.[1]
    || html.match(/content="(UC[\w-]{10,})"[^>]*itemprop="channelId"/i)?.[1]
    || html.match(/"externalId"\s*:\s*"(UC[\w-]{10,})"/)?.[1]
    || null;
}

export async function resolveYoutubeAtomUrl(input: string): Promise<{ atomUrl: string; channelId?: string; label?: string; handle?: string }> {
  const inspected = inspectYoutubeInput(input);
  if (inspected.atomUrl) {
    return { atomUrl: inspected.atomUrl, channelId: inspected.channelId, handle: inspected.handle };
  }
  if (!inspected.fetchUrl) {
    throw new Error("Could not resolve a YouTube channel from that URL");
  }
  const html = await fetchText(inspected.fetchUrl, 8_000);
  const channelId = extractYoutubeChannelId(html);
  if (!channelId) throw new Error("Could not find a YouTube channel id on that page");
  const label = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1]
    || html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i)?.[1];
  return {
    atomUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    channelId,
    handle: inspected.handle,
    label: label ? decodeEntities(label) : undefined,
  };
}

function videoLink(block: string, videoId: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  for (const link of links) {
    const href = link[1].match(/href="([^"]+)"/i)?.[1];
    const rel = link[1].match(/\brel="([^"]+)"/i)?.[1] ?? "alternate";
    if (href && rel === "alternate") return href;
  }
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
}

export function parseYoutubeAtom(xml: string, source: { id: string; label: string; url: string }, now = Date.now()): SignalItem[] {
  const nowIso = new Date(now).toISOString();
  const items: SignalItem[] = [];
  for (const block of xmlBlocks(xml, "entry")) {
    const videoId = xmlText(block, "yt:videoId");
    const url = videoLink(block, videoId);
    const title = htmlToText(xmlText(block, "title"));
    if (!url || !title) continue;
    const author = htmlToText(xmlText(block, "name"));
    const description = xmlText(block, "media:description") || xmlText(block, "summary");
    const thumbnail = block.match(/<media:thumbnail\b[^>]*\burl="([^"]+)"/i)?.[1];
    items.push(toSignalItem({
      channel: "youtube",
      sourceId: source.id,
      sourceName: author || source.label,
      title,
      url,
      publishedAt: toIsoDate(xmlText(block, "published") || xmlText(block, "updated"), nowIso),
      capturedAt: nowIso,
      snippet: clip(htmlToText(description)),
      thumbnail,
    }));
  }
  return items;
}

let ytDlpAvailable: Promise<boolean> | null = null;

function hasYtDlp(): Promise<boolean> {
  if (!ytDlpAvailable) {
    ytDlpAvailable = new Promise((resolve) => {
      execFile("yt-dlp", ["--version"], { timeout: 2000 }, (error) => resolve(!error));
    });
  }
  return ytDlpAvailable;
}

async function fetchCaptionWithYtDlp(videoId: string): Promise<string | null> {
  if (!(await hasYtDlp())) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-yt-"));
  try {
    await execFileAsync("yt-dlp", [
      "--write-auto-sub",
      "--skip-download",
      "--sub-format", "vtt",
      "--sub-langs", "en",
      "-o", path.join(dir, "%(id)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 8000 });
    const files = await fs.readdir(dir);
    const vtt = files.find((file) => file.endsWith(".vtt"));
    if (!vtt) return null;
    const clean = stripCaptionText(await fs.readFile(path.join(dir, vtt), "utf-8"));
    return clean ? clean.slice(0, 1500) : null;
  } catch {
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function fetchCaptionSnippet(videoId: string): Promise<string | null> {
  try {
    const timed = await fetchText(
      `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&lang=en&fmt=vtt`,
      8000,
    );
    const clean = stripCaptionText(timed);
    if (clean.length >= 40) return clean.slice(0, 1500);
  } catch {
    // Timed text is often unavailable. Captions are best-effort.
  }
  try {
    return await fetchCaptionWithYtDlp(videoId);
  } catch {
    return null;
  }
}

function videoIdFromItem(item: SignalItem): string | undefined {
  try {
    return new URL(item.url).searchParams.get("v") || undefined;
  } catch {
    return undefined;
  }
}

export async function fetchYoutubeSignals(source: RadarSource, windowDays = 3, now = Date.now()): Promise<SignalItem[]> {
  const xml = await fetchText(source.url, 10_000);
  const parsed = parseYoutubeAtom(xml, source, now).filter((item) => isWithinDays(item.publishedAt, windowDays, now));
  const newest = [...parsed].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 5);
  const captions = new Map<string, string>();
  for (const item of newest) {
    const videoId = videoIdFromItem(item);
    if (!videoId) continue;
    const caption = await fetchCaptionSnippet(videoId);
    if (caption) captions.set(item.id, caption);
  }
  return parsed.map((item) => {
    const caption = captions.get(item.id);
    if (!caption) return item;
    return { ...item, snippet: clip(`${caption} ${item.snippet}`) };
  });
}
