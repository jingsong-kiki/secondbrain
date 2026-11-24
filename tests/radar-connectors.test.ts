import { describe, expect, it } from "vitest";
import { parsePodcastFeed } from "@/lib/connectors/podcast";
import { parseRssFeed } from "@/lib/connectors/rss";
import { extractYoutubeChannelId, inspectYoutubeInput, parseYoutubeAtom } from "@/lib/connectors/youtube";

const source = { id: "src", label: "Example", url: "https://example.com/feed" };

describe("RSS connector", () => {
  it("prefers encoded content, strips HTML, and extracts external links", () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Big models</title>
          <link>https://example.com/post</link>
          <pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate>
          <dc:creator>Ada</dc:creator>
          <description>short description</description>
          <content:encoded><![CDATA[<p>Hello &amp; welcome. Read <a href="https://other.com/a">this</a> and <a href="https://other.com/a?utm_source=rss">dup</a> and <a href="https://example.com/self">self</a>.</p>]]></content:encoded>
        </item>
      </channel></rss>`;

    const [item] = parseRssFeed(xml, source, Date.parse("2026-11-17T00:00:00.000Z"));
    expect(item.sourceName).toBe("Ada");
    expect(item.snippet.startsWith("Hello & welcome")).toBe(true);
    expect(item.snippet).not.toContain("short description");
    expect(item.snippet.length).toBeLessThanOrEqual(1500);
    expect(item.outboundUrls).toEqual(["https://other.com/a"]);
    expect(item.canonicalUrl).toBe("https://example.com/post");
  });

  it("reads Atom content when there is no RSS item", () => {
    const xml = `<?xml version="1.0"?>
      <feed>
        <entry>
          <title>Atom title</title>
          <link href="https://blog.example.com/a"/>
          <published>2026-11-16T00:00:00Z</published>
          <content type="html">&lt;p&gt;Body text&lt;/p&gt;</content>
        </entry>
      </feed>`;
    const [item] = parseRssFeed(xml, source);
    expect(item.title).toBe("Atom title");
    expect(item.snippet).toBe("Body text");
    expect(item.url).toBe("https://blog.example.com/a");
  });
});

describe("YouTube connector", () => {
  it("parses Atom entries", () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
        <entry>
          <yt:videoId>dQw4w9WgXcQ</yt:videoId>
          <title>Talk</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
          <published>2026-11-16T00:00:00+00:00</published>
          <author><name>Andrej</name></author>
          <media:group>
            <media:description>A description of the talk</media:description>
            <media:thumbnail url="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480"/>
          </media:group>
        </entry>
      </feed>`;
    const [item] = parseYoutubeAtom(xml, { ...source, label: "Channel" });
    expect(item.channel).toBe("youtube");
    expect(item.sourceName).toBe("Andrej");
    expect(item.snippet).toBe("A description of the talk");
    expect(item.thumbnail).toContain("hqdefault.jpg");
    expect(item.canonicalUrl).toBe("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(item.publishedAt.startsWith("2026-11-16")).toBe(true);
  });

  it("normalizes channel and Atom URLs without fetching", () => {
    expect(inspectYoutubeInput("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv")).toMatchObject({
      channelId: "UCabcdefghijklmnopqrstuv",
      atomUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
    });
    expect(inspectYoutubeInput("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv").atomUrl)
      .toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv");
    expect(inspectYoutubeInput("@karpathy")).toMatchObject({
      fetchUrl: "https://www.youtube.com/@karpathy",
      handle: "karpathy",
    });
  });

  it("reads a channel id out of channel HTML", () => {
    const html = `<html><head><meta itemprop="channelId" content="UCzyx1234567890abcdef"></head></html>`;
    expect(extractYoutubeChannelId(html)).toBe("UCzyx1234567890abcdef");
    expect(extractYoutubeChannelId(`{"externalId":"UCzyx1234567890abcdef"}`)).toBe("UCzyx1234567890abcdef");
  });
});

describe("Podcast connector", () => {
  it("reads duration, show notes, and the enclosure", () => {
    const notes = `${"Chapter one. ".repeat(20)} Guest notes at <a href="https://guest.example/bio">bio</a>. ${"More. ".repeat(400)}`;
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Episode 12</title>
          <enclosure url="https://cdn.example/ep12.mp3" type="audio/mpeg"/>
          <itunes:duration>48:00</itunes:duration>
          <itunes:author>Host</itunes:author>
          <content:encoded><![CDATA[${notes}]]></content:encoded>
        </item>
      </channel></rss>`;
    const [episode] = parsePodcastFeed(xml, { id: "pod:1", label: "Latent Space", url: "https://example.com/podcast.xml" });
    expect(episode.channel).toBe("podcast");
    expect(episode.sourceName).toBe("Latent Space");
    expect(episode.rawLengthHint).toBe("48 min");
    expect(episode.url).toBe("https://cdn.example/ep12.mp3");
    expect(episode.snippet.length).toBeLessThanOrEqual(1500);
    expect(episode.snippet.startsWith("Chapter one.")).toBe(true);
    expect(episode.outboundUrls).toEqual(["https://guest.example/bio"]);
  });
});
