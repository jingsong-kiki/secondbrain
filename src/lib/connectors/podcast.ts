import type { RadarSource, SignalItem } from "@/lib/types";
import {
  clip,
  extractOutboundUrls,
  fetchText,
  formatDuration,
  htmlToText,
  isWithinDays,
  tagAttributes,
  toIsoDate,
  toSignalItem,
  xmlBlocks,
  xmlText,
} from "./text";

function episodeUrl(block: string): string {
  const link = xmlText(block, "link").trim();
  if (/^https?:\/\//i.test(link)) return link;
  const enclosure = tagAttributes(block, "enclosure");
  if (enclosure?.url) return enclosure.url;
  const guid = xmlText(block, "guid").trim();
  return /^https?:\/\//i.test(guid) ? guid : "";
}

function showNotes(block: string): string {
  return xmlText(block, "content:encoded")
    || xmlText(block, "itunes:summary")
    || xmlText(block, "description");
}

export function parsePodcastFeed(xml: string, source: { id: string; label: string; url: string }, now = Date.now()): SignalItem[] {
  const nowIso = new Date(now).toISOString();
  const items: SignalItem[] = [];
  for (const block of xmlBlocks(xml, "item")) {
    const url = episodeUrl(block);
    const title = htmlToText(xmlText(block, "title"));
    if (!url || !title) continue;
    const notes = showNotes(block);
    const author = htmlToText(xmlText(block, "itunes:author") || xmlText(block, "dc:creator"));
    items.push(toSignalItem({
      channel: "podcast",
      sourceId: source.id,
      sourceName: source.label,
      authorHandle: author || undefined,
      title,
      url,
      publishedAt: toIsoDate(xmlText(block, "pubDate") || xmlText(block, "published"), nowIso),
      capturedAt: nowIso,
      rawLengthHint: formatDuration(xmlText(block, "itunes:duration")),
      snippet: clip(htmlToText(notes)),
      outboundUrls: extractOutboundUrls(notes, url),
    }));
  }
  return items;
}

export async function fetchPodcastSignals(source: RadarSource, windowDays = 3, now = Date.now()): Promise<SignalItem[]> {
  const xml = await fetchText(source.url, 10_000);
  return parsePodcastFeed(xml, source, now).filter((item) => isWithinDays(item.publishedAt, windowDays, now));
}
