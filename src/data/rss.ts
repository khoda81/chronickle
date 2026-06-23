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
  { source: "Reuters", url: "https://www.reutersagency.com/feed/?best-top-news&post_type=best" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
];

export interface FetchEventsOptions {
  readonly feeds?: readonly RssFeed[];
  /** CORS proxy base. The RSS URL is appended (URL-encoded) after this prefix. */
  readonly proxy?: string;
  /** Per-feed fetch timeout in ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_PROXY = "https://corsproxy.io/?url=";

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${proxy}${encodeURIComponent(feed.url)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Feed ${feed.source} failed: ${res.status}`);
    }
    const xml = await res.text();
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

  const items = doc.querySelectorAll("item");
  const events: NewsEvent[] = [];
  items.forEach((item) => {
    const title = item.querySelector("title")?.textContent?.trim();
    const link = item.querySelector("link")?.textContent?.trim();
    const pubDate = item.querySelector("pubDate")?.textContent?.trim();
    if (!title || !link || !pubDate) {
      throw new Error(`Incomplete RSS item in ${source}: title/link/pubDate missing`);
    }
    const t = Date.parse(pubDate);
    if (!Number.isFinite(t)) {
      throw new Error(`Unparseable pubDate in ${source}: ${pubDate}`);
    }
    events.push({ t, title, link, source });
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

  const results = await Promise.all(feeds.map((f) => fetchFeed(f, proxy, timeoutMs)));
  const merged = results.flat().sort((a, b) => a.t - b.t);
  return { events: merged };
}
