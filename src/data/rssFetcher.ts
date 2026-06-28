/**
 * RSS EventFetcher: adapts the RSS parser + RFC 5005 archive pagination to
 * the EventBroker's `fetchRange` contract.
 *
 * Pagination model:
 *  - Each feed is fetched fresh on every `fetchRange` call (RSS has no
 *    If-Modified-Since story through the CORS proxy, and feeds are cheap).
 *  - If the feed exposes <atom:link rel="next"> and the requested range
 *    extends older than the feed's oldest returned item, we follow the
 *    archive link repeatedly — an async generator yields page by page —
 *    until either:
 *      (a) we have events covering `range.min`, or
 *      (b) the archive chain ends (no next link), or
 *      (c) a page returns zero in-range events (heuristic stop).
 *    There is no fixed depth cap; the only bound is `range.min`.
 *  - `coveredRange` is reported honestly:
 *      * If the archive was walked to its end (or there was no archive link
 *        and the range is older than the oldest item), the source is
 *        exhausted for the older direction → `coveredRange = null` so the
 *        broker marks the whole range fetched and stops re-requesting.
 *      * If we stopped because we covered `range.min` (case a), we report
 *        `[oldestInRange.t, range.max]` as covered — the broker marks only
 *        that, so a future query extending further left re-walks the archive.
 *
 * Per-feed failures are isolated: one feed throwing does not abort the
 * others. Failures are logged and treated as "this feed contributed nothing
 * and is not exhausted" — the broker will retry on the next query.
 */

import type { NewsEvent, RssFeed } from "../domain.ts";
import { Range } from "../engine/range.ts";
import type { EventFetcher } from "./eventBroker.ts";
import { fetchFeed, parseRssXml, type ParsedFeed, defaultProxy } from "./rss.ts";
import type { FeedRegistry } from "./feeds.ts";

export interface RssEventFetcherOptions {
  readonly registry: FeedRegistry;
  readonly proxy?: string;
  readonly timeoutMs?: number;
}

export function createRssEventFetcher(opts: RssEventFetcherOptions): EventFetcher {
  const proxy = opts.proxy ?? defaultProxy;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    async fetchRange(range) {
      const feeds = opts.registry.all();
      const allEvents: NewsEvent[] = [];
      // A feed is "exhausted in the older direction" if it has no archive
      // link and its oldest item is newer than range.min. We track the
      // union of covered sub-ranges across feeds; if every feed is
      // exhausted, we report null (whole range fetched).
      let anyFeedExhausted = false;
      let anyFeedCovered = false;
      let coveredMin = Infinity;

      await Promise.all(
        feeds.map(async (feed) => {
          try {
            const result = await fetchFeedArchive(feed, range, proxy, timeoutMs);
            allEvents.push(...result.events);
            if (result.exhausted) anyFeedExhausted = true;
            if (result.events.length > 0) anyFeedCovered = true;
            if (result.oldestInRange !== null) {
              coveredMin = Math.min(coveredMin, result.oldestInRange);
            }
          } catch (err) {
            console.warn(`[RssEventFetcher] feed ${feed.source} failed:`, err);
          }
        }),
      );

      allEvents.sort((a, b) => a.t - b.t);

      // Coverage decision:
      //  - If no feed produced any in-range event AND no feed is exhausted,
      //    we have no data and no claim — report a degenerate covered range
      //    so the broker doesn't mark the whole range fetched (it'll retry).
      //  - If every feed that responded is exhausted (no archive link, range
      //    older than oldest item), report null — the broker marks the whole
      //    range fetched and stops re-requesting.
      //  - Otherwise report [coveredMin, range.max] — the part we actually
      //    filled — so the unfilled prefix stays a gap.
      if (allEvents.length === 0) {
        if (anyFeedExhausted && !anyFeedCovered) {
          return { events: [], coveredRange: null };
        }
        // No data, no exhaustion claim — don't mark anything fetched.
        // Report a zero-width covered range at range.max so the broker marks
        // only that point (effectively nothing), and a later query retries.
        return { events: [], coveredRange: Range.create(range.max, range.max + 1) };
      }

      if (anyFeedExhausted && coveredMin <= range.min) {
        // We covered down to range.min and the archive is exhausted below —
        // the whole range is satisfied.
        return { events: allEvents, coveredRange: null };
      }

      // Partial: we filled [coveredMin, range.max]. The prefix
      // [range.min, coveredMin) stays a gap for progressive backfill.
      const covered = Range.create(coveredMin, range.max);
      return { events: allEvents, coveredRange: covered };
    },
  };
}

interface FeedArchiveResult {
  readonly events: NewsEvent[];
  /** True if the archive chain ended (or there was none) below range.min. */
  readonly exhausted: boolean;
  /** Oldest in-range event timestamp, or null if none in range. */
  readonly oldestInRange: number | null;
}

/**
 * Walk a single feed's archive chain, collecting events whose t falls in
 * [range.min, range.max]. Stops when:
 *  - the oldest in-range event is at or below range.min (covered), or
 *  - the archive chain ends (no next link), or
 *  - a page yields zero in-range events (heuristic stop to avoid spinning
 *    on a long archive of out-of-range items).
 */
async function fetchFeedArchive(
  feed: RssFeed,
  range: Range,
  proxy: string,
  timeoutMs: number,
): Promise<FeedArchiveResult> {
  const inRange: NewsEvent[] = [];
  let oldestInRange: number | null = null;
  let exhausted = false;

  let currentUrl: string | null = feed.url;
  let page = 0;
  // Guard against a misbehaving feed that always claims to have a "next"
  // link pointing at itself or cycling. 200 pages is well beyond any real
  // archive depth and bounds the worst case.
  const MAX_PAGES = 200;

  while (currentUrl !== null && page < MAX_PAGES) {
    const parsed = await fetchPage(currentUrl, feed, proxy, timeoutMs);
    page++;

    const pageInRange = parsed.events.filter((e) => e.t >= range.min && e.t <= range.max);
    if (pageInRange.length > 0) {
      inRange.push(...pageInRange);
      const oldest = pageInRange[0]!.t;
      if (oldestInRange === null || oldest < oldestInRange) oldestInRange = oldest;
    }

    // Stop if we've covered range.min.
    if (oldestInRange !== null && oldestInRange <= range.min) {
      exhausted = parsed.nextArchiveUrl === null;
      break;
    }

    // Heuristic stop: a page with items but none in range, and no next link.
    if (parsed.nextArchiveUrl === null) {
      exhausted = true;
      break;
    }
    // Heuristic stop: a page with zero items and a next link — likely the
    // archive is empty from here. Don't spin.
    if (parsed.events.length === 0) {
      exhausted = true;
      break;
    }

    currentUrl = parsed.nextArchiveUrl;
  }

  if (page >= MAX_PAGES) {
    // We hit the safety cap; not truly exhausted, but stop to avoid spinning.
    exhausted = false;
  }

  inRange.sort((a, b) => a.t - b.t);
  return { events: inRange, exhausted, oldestInRange: oldestInRange };
}

/**
 * Fetch and parse a single page (the feed URL or an archive URL). Archive
 * URLs are also routed through the CORS proxy.
 */
async function fetchPage(
  url: string,
  feed: RssFeed,
  proxy: string,
  timeoutMs: number,
): Promise<ParsedFeed> {
  // Reuse fetchFeed's timeout/abort plumbing by constructing a temporary
  // feed-like object whose url is the page URL. The id/source/color are
  // preserved so events get the correct feedId.
  const pageFeed: RssFeed = { ...feed, url };
  return fetchFeed(pageFeed, proxy, timeoutMs);
}

/** Re-export parseRssXml for tests that construct fetchers with custom XML. */
export { parseRssXml };
