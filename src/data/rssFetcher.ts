/**
 * RSS EventFetcher: adapts the RSS parser + RFC 5005 archive pagination to
 * the EventBroker's `fetchFeed(feed, targetMin)` contract.
 *
 * Pagination model:
 *  - Each feed is walked from its head URL through <atom:link rel="next">
 *    archive pages, collecting events until the oldest returned event is at
 *    or before `targetMin`, or the archive chain ends.
 *  - A per-feed in-memory page cache (`Map<pageUrl, ParsedFeed>`) remembers
 *    already-fetched pages. Re-walking toward an older `targetMin` reuses
 *    cached pages and only fetches newly-needed ones — so scrolling left
 *    incrementally does not re-fetch the feed head every time.
 *  - There is no fixed depth cap; the only bound is `targetMin` (with a
 *    200-page safety guard against cycling archives).
 *  - `exhausted` is reported true when the archive chain ends (no next link),
 *    so the broker stops re-requesting that feed.
 *
 * Per-feed failures are isolated: one feed throwing does not abort the
 * others. A failure surfaces as a rejected promise to the broker, which
 * clears `pending` without marking exhausted (retryable).
 */

import type { NewsEvent, RssFeed } from "../domain.ts";
import type { EventFetcher, FeedFetchResult } from "./eventBroker.ts";
import { fetchFeed, type ParsedFeed, defaultProxy } from "./rss.ts";

export interface RssEventFetcherOptions {
  readonly proxy?: string;
  readonly timeoutMs?: number;
}

/** Safety cap against a misbehaving feed whose "next" link cycles. */
const MAX_PAGES = 200;

export function createRssEventFetcher(opts: RssEventFetcherOptions = {}): EventFetcher {
  const proxy = opts.proxy ?? defaultProxy;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  // Per-feed page cache: pageUrl → parsed feed. Shared across all
  // fetchFeed calls for the same feed. In-memory only (cleared on reload);
  // RSS items are immutable once published, so staleness is not a concern.
  const pageCache = new Map<string, ParsedFeed>();

  return {
    async fetchFeed(feed, targetMin): Promise<FeedFetchResult> {
      const collected: NewsEvent[] = [];
      let oldestT: number | null = null;
      let exhausted = false;

      let currentUrl: string | null = feed.url;
      let page = 0;

      while (currentUrl !== null && page < MAX_PAGES) {
        // Cache lookup: avoid re-fetching pages we've already walked for this
        // feed (e.g. on a second fetchFeed call with an older targetMin).
        let parsed = pageCache.get(currentUrl);
        if (parsed === undefined) {
          parsed = await fetchPage(currentUrl, feed, proxy, timeoutMs);
          pageCache.set(currentUrl, parsed);
        }
        page++;

        collected.push(...parsed.events);

        // Track the oldest event we've seen across all pages.
        if (parsed.events.length > 0) {
          const oldest = parsed.events[0]!.t;
          if (oldestT === null || oldest < oldestT) oldestT = oldest;
        }

        // Stop if we've covered targetMin.
        if (oldestT !== null && oldestT <= targetMin) {
          exhausted = parsed.nextArchiveUrl === null;
          break;
        }

        // Archive ended — nothing older to fetch.
        if (parsed.nextArchiveUrl === null) {
          exhausted = true;
          break;
        }
        // Heuristic stop: a page with zero items and a next link — likely
        // the archive is empty from here. Don't spin.
        if (parsed.events.length === 0) {
          exhausted = true;
          break;
        }

        currentUrl = parsed.nextArchiveUrl;
      }

      if (page >= MAX_PAGES) {
        // Hit the safety cap; not truly exhausted, but stop to avoid spinning.
        exhausted = false;
      }

      collected.sort((a, b) => a.t - b.t);
      return { events: collected, exhausted };
    },
  };
}

/**
 * Fetch and parse a single page (the feed URL or an archive URL). Archive
 * URLs are also routed through the CORS proxy. The feed's id/source/color are
 * preserved so events get the correct feedId.
 */
async function fetchPage(
  url: string,
  feed: RssFeed,
  proxy: string,
  timeoutMs: number,
): Promise<ParsedFeed> {
  const pageFeed: RssFeed = { ...feed, url };
  return fetchFeed(pageFeed, proxy, timeoutMs);
}
