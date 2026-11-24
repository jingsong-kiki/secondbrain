import { canonicalizeUrl, signalItemId } from "@/lib/radarStorage";
import type { SignalChannel, SignalEngagement, SignalItem } from "@/lib/types";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  let text = input;
  for (let pass = 0; pass < 2; pass++) {
    const next = text
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&([a-z]+);/gi, (entity, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? entity);
    if (next === text) break;
    text = next;
  }
  return text;
}

export function htmlToText(html: string): string {
  const decoded = decodeEntities(html);
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function clip(text: string, max = 1500): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max).trim();
}

export function xmlBlocks(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "gi");
  return [...xml.matchAll(re)].map((match) => match[1]);
}

export function xmlText(xml: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`, "i"));
  if (!match) return "";
  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

export function tagAttributes(xml: string, tag: string): Record<string, string> | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}\\b([^>]*)\\/?>`, "i"));
  if (!match) return null;
  const attrs: Record<string, string> = {};
  for (const attr of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attrs[attr[1].toLowerCase()] = attr[2];
  }
  return attrs;
}

export function toIsoDate(raw: string | undefined, fallbackIso: string): string {
  if (!raw?.trim()) return fallbackIso;
  const parsed = Date.parse(raw.trim());
  if (Number.isNaN(parsed)) return fallbackIso;
  return new Date(parsed).toISOString();
}

export function isWithinDays(iso: string, windowDays: number, now: number, bufferDays = 1): boolean {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return true;
  return parsed >= now - (windowDays + bufferDays) * 86_400_000;
}

export function extractOutboundUrls(html: string, pageUrl?: string, limit = 5): string[] {
  const decoded = decodeEntities(html);
  const urls: string[] = [];
  const seen = new Set<string>();
  let pageHost = "";
  try {
    if (pageUrl) pageHost = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    pageHost = "";
  }
  for (const match of decoded.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1].trim();
    if (!/^https?:\/\//i.test(raw)) continue;
    let canonical: string;
    try {
      canonical = canonicalizeUrl(raw);
      const host = new URL(canonical).hostname.replace(/^www\./, "").toLowerCase();
      if (pageHost && host === pageHost) continue;
    } catch {
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    urls.push(canonical);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function formatDuration(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  let seconds: number | undefined;
  if (/^\d+$/.test(trimmed)) {
    seconds = Number(trimmed);
  } else {
    const parts = trimmed.split(":").map((part) => Number(part));
    if (parts.length >= 2 && parts.length <= 3 && parts.every((part) => Number.isFinite(part))) {
      seconds = parts.reduce((total, part) => total * 60 + part, 0);
    }
  }
  if (seconds == null || !Number.isFinite(seconds)) return trimmed;
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  return `${Math.round(seconds / 60)} min`;
}

export function stripCaptionText(raw: string): string {
  return raw
    .replace(/^WEBVTT[^\n]*\n/i, " ")
    .replace(/\d{2}:\d{2}(?::\d{2})?[.,]\d+\s+-->\s+\d{2}:\d{2}(?::\d{2})?[.,]\d+[^\n]*/g, " ")
    .replace(/<\d{2}:\d{2}(?::\d{2})?[.,]\d+>/g, " ")
    .replace(/<\/?text\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSignalItem(input: {
  channel: SignalChannel;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string;
  capturedAt: string;
  snippet: string;
  authorHandle?: string;
  rawLengthHint?: string;
  outboundUrls?: string[];
  thumbnail?: string;
  engagement?: SignalEngagement;
}): SignalItem {
  const canonicalUrl = canonicalizeUrl(input.url);
  const outbound = input.outboundUrls?.filter((url) => url && url !== canonicalUrl);
  return {
    id: signalItemId(canonicalUrl),
    channel: input.channel,
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    authorHandle: input.authorHandle,
    title: clip(htmlToText(input.title), 300) || input.sourceName,
    url: input.url,
    canonicalUrl,
    publishedAt: input.publishedAt,
    capturedAt: input.capturedAt,
    rawLengthHint: input.rawLengthHint,
    snippet: clip(input.snippet),
    outboundUrls: outbound && outbound.length > 0 ? outbound.slice(0, 5) : undefined,
    thumbnail: input.thumbnail,
    engagement: input.engagement,
  };
}

export async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "SecondBrain/1.0",
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status} for ${url}`);
  }
  return response.text();
}
