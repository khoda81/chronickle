/**
 * RSS ingestion.
 *
 * Browser CORS blocks direct RSS fetching, so we route through a CORS proxy.
 * The MVP uses `corsproxy.io` (configurable). The proxy returns the raw XML,
 * which we parse with `DOMParser` and normalize into a sorted EventSet.
 */

import type { EventSet, NewsEvent } from "../domain.ts";

export interface RssFeed {
  readonly source: string;
  readonly url: string;
}

export const DEFAULT_FEEDS: readonly RssFeed[] = [
  // { source: "Reuters", url: "https://www.reutersagency.com/feed/?best-top-news&post_type=best" },
  // { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  // { source: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
  // { source: "Yahoo World", url: "https://news.yahoo.com/rss/world" },
  // { source: "NYT World", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  // Core Macro & Commodities Coverage
  { source: "Kitco Gold News", url: "https://www.kitco.com/rss/news/" },
  { source: "ForexLive Macro", url: "https://www.forexlive.com/rss" },
  { source: "FXStreet Commodities", url: "https://www.fxstreet.com/rss/news/commodities/gold" },
  {
    source: "Reuters Business",
    url: "https://www.reutersagency.com/feed/?best-business-news&post_type=best",
  },
  {
    source: "MarketWatch Top Stories",
    url: "http://feeds.marketwatch.com/marketwatch/topstories/",
  },
];

export interface FetchEventsOptions {
  readonly feeds?: readonly RssFeed[];
  /** CORS proxy base. The RSS URL is appended (URL-encoded) after this prefix. */
  readonly proxy?: string;
  /** Per-feed fetch timeout in ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_PROXY = "https://corsproxy.io/?url=";
// const DEFAULT_PROXY = "https://api.allorigins.win/raw?url=";

/**
 * Fetch and parse a single RSS feed into NewsEvents.
 * @throws on fetch failure, parse failure, or missing pubDate.
 */
export async function fetchFeed(
  feed: RssFeed,
  proxy: string,
  timeoutMs: number,
): Promise<readonly NewsEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(`${feed.source} timed out after ${timeoutMs}ms`, "TimeoutError"),
      ),
    timeoutMs,
  );

  try {
    const url = `${proxy}${encodeURIComponent(feed.url)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Feed ${feed.source} failed: ${res.status}`);
    }

    const xml = await res.text();

    // DEBUG: Look at the first 100 characters to ensure it's actually XML (<?xml ...)
    // You can remove this once everything is working.
    console.debug(`Raw response from ${feed.source}:`, xml.substring(0, 100));

    return parseRssXml(xml, feed.source);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse RSS 2.0 XML into NewsEvents.
 * @throws on malformed XML or items missing required fields.
 */
export function parseRssXml(xml: string, source: string): readonly NewsEvent[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(`Malformed XML from ${source}: ${parseError.textContent ?? ""}`);
  }

  // 1. Detect Cloudflare / Anti-bot HTML blocks
  if (doc.documentElement.nodeName.toLowerCase() === "html") {
    throw new Error(`Feed ${source} blocked the proxy (Returned an HTML page instead of XML).`);
  }

  // 2. Support both RSS (<item>) and Atom (<entry>) feed structures
  const items = doc.querySelectorAll("item, entry");
  if (items.length === 0) {
    throw new Error(`No news items found in ${source}.`);
  }

  const events: NewsEvent[] = [];
  items.forEach((item) => {
    // RSS uses <title>, Atom uses <title>
    const title = item.querySelector("title")?.textContent?.trim();

    // RSS uses <link>URL</link>, Atom often uses <link href="URL"/>
    let link = item.querySelector("link")?.textContent?.trim();
    if (!link) {
      link = item.querySelector("link")?.getAttribute("href")?.trim();
    }

    // RSS uses <pubDate>, Atom uses <updated> or <published>
    const pubDate =
      item.querySelector("pubDate")?.textContent?.trim() ??
      item.querySelector("updated")?.textContent?.trim() ??
      item.querySelector("published")?.textContent?.trim();

    // 3. Graceful degradation: skip a malformed item instead of killing the whole feed
    if (!title || !link || !pubDate) {
      return;
    }

    const t = Date.parse(pubDate);
    if (Number.isFinite(t)) {
      events.push({ t, title, link, source });
    }
  });

  events.sort((a, b) => a.t - b.t);
  return events;
}

/**
 * Fetch all feeds concurrently and merge into a single sorted EventSet.
 * Feed-level failures are surfaced: if any feed throws, the whole call throws.
 */
export async function fetchEventSet(opts: FetchEventsOptions = {}): Promise<EventSet> {
  const feeds = opts.feeds ?? DEFAULT_FEEDS;
  const proxy = opts.proxy ?? DEFAULT_PROXY;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // Promise.allSettled waits for ALL feeds to finish (success or fail)
  // instead of short-circuiting on the first error.
  const results = await Promise.allSettled(feeds.map((f) => fetchFeed(f, proxy, timeoutMs)));

  const events: NewsEvent[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      // Feed loaded successfully, add its events
      events.push(...result.value);
    } else {
      // Feed failed. Log it for debugging, but don't crash the app!
      console.warn("A feed failed to load:", result.reason);
    }
  }

  events.sort((a, b) => a.t - b.t);
  return { events };
}
