import type { RadarSource, SignalItem } from "@/lib/types";
import {
  clip,
  extractOutboundUrls,
  fetchText,
  htmlToText,
  isWithinDays,
  toIsoDate,
  toSignalItem,
  xmlBlocks,
  xmlText,
} from "./text";

export interface FeedSourceRef {
  id: string;
  label: string;
  url: string;
}

function itemUrl(block: string): string {
  const textLink = xmlText(block, "link").trim();
  if (/^https?:\/\//i.test(textLink)) return textLink;
  const atom = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  let fallback = "";
  for (const link of atom) {
    const href = link[1].match(/href="([^"]+)"/i)?.[1] ?? "";
    if (!href) continue;
    const rel = link[1].match(/\brel="([^"]+)"/i)?.[1] ?? "alternate";
    if (rel === "alternate") return href;
    if (!fallback) fallback = href;
  }
  if (fallback) return fallback;
  const guid = xmlText(block, "guid").trim();
  if (/^https?:\/\//i.test(guid)) return guid;
  return xmlText(block, "comments").trim();
}

function richBody(block: string): string {
  return xmlText(block, "content:encoded")
    || xmlText(block, "content")
    || xmlText(block, "summary")
    || xmlText(block, "description");
}

function parseBlocks(xml: string, source: FeedSourceRef, nowIso: string): SignalItem[] {
  const blocks = xmlBlocks(xml, "item");
  const entries = blocks.length > 0 ? blocks : xmlBlocks(xml, "entry");
  const items: SignalItem[] = [];
  for (const block of entries) {
    const url = itemUrl(block);
    const title = htmlToText(xmlText(block, "title"));
    if (!url || !title) continue;
    const body = richBody(block);
    const author = htmlToText(xmlText(block, "dc:creator") || xmlText(block, "author") || xmlText(block, "name"));
    const published = xmlText(block, "pubDate") || xmlText(block, "published") || xmlText(block, "updated");
    items.push(toSignalItem({
      channel: "rss",
      sourceId: source.id,
      sourceName: author || source.label,
      title,
      url,
      publishedAt: toIsoDate(published, nowIso),
      capturedAt: nowIso,
      snippet: clip(htmlToText(body)),
      outboundUrls: extractOutboundUrls(body, url),
    }));
  }
  return items;
}

export function parseRssFeed(xml: string, source: FeedSourceRef, now = Date.now()): SignalItem[] {
  return parseBlocks(xml, source, new Date(now).toISOString());
}

export async function fetchRssSignals(source: RadarSource, windowDays = 3, now = Date.now()): Promise<SignalItem[]> {
  const xml = await fetchText(source.url, 10_000);
  return parseRssFeed(xml, source, now).filter((item) => isWithinDays(item.publishedAt, windowDays, now));
}
