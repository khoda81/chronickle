/**
 * EventBroker: the events-side analog of the price `Broker`.
 *
 * The UI queries synchronously with a visible time range. The broker returns
 * the cached events in that range immediately and, if coverage is incomplete,
 * kicks off an async backfill from the `EventFetcher`. Subscribers are
 * notified when new events land so the UI can re-query.
 *
 * Storage: a single sorted array of `NewsEvent` (events are sparse — a few
 * thousand at most — so the chunked level store used for prices is overkill).
 * Insertion merges new events into the sorted array, deduplicating by
 * (feedId, t, link) to avoid duplicates when a feed is re-fetched.
 *
 * Coverage tracking reuses `RangeSet`: a range is "fetched" once the fetcher
 * has reported it exhausted (either the feed had no archive link and the
 * requested range is older than the feed's oldest item, or the archive was
 * walked to the end). This prevents re-requesting ranges the source cannot
 * satisfy.
 */

import type { NewsEvent } from "../domain.ts";
import { Range } from "../engine/range.ts";
import { RangeSet } from "./rangeSet.ts";

/** Algebraic query status — mirrors the price broker's contract. */
export type EventQueryStatus =
  | "complete"
  | "partial"
  | "empty";

export interface EventQueryResult {
  /** Events in the queried range, sorted ascending by t. A snapshot. */
  readonly events: readonly NewsEvent[];
  readonly status: EventQueryStatus;
}

export interface EventFetcher {
  /**
   * Fetch events for `range`. Returns the events that fall within the range
   * and a `coveredRange`:
   *  - `null` means the source asserts the entire range is exhausted (no
   *    archive link and the range is older than the feed's oldest item, or
   *    the archive was walked to its end). The broker marks the whole range
   *    as fetched.
   *  - A non-null `Range` means only a sub-range was filled (e.g. the fetch
   *    was depth-capped mid-archive). The broker marks only that sub-range,
   *    leaving the unfilled prefix as a gap for progressive backfill.
   */
  fetchRange(range: Range): Promise<{ events: NewsEvent[]; coveredRange: Range | null }>;
}

export class EventBroker {
  private events: NewsEvent[] = [];
  private readonly fetched = new RangeSet();
  private readonly subscribers = new Set<() => void>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly fetcher: EventFetcher) {}

  /**
   * Synchronous query. Returns cached events in `range` and kicks off an
   * async backfill for any unfilled sub-ranges. Subscribers are notified
   * when the backfill lands; the UI should re-query then.
   */
  query(range: Range): EventQueryResult {
    const gaps = this.fetched.gaps(range);
    const inRange = sliceByTime(this.events, range.min, range.max);

    let status: EventQueryStatus;
    if (gaps.length === 0) {
      status = "complete";
    } else if (inRange.length > 0) {
      status = "partial";
      for (const g of gaps) void this.requestFetch(g);
    } else {
      status = "empty";
      for (const g of gaps) void this.requestFetch(g);
    }

    return { events: inRange, status };
  }

  /** Subscribe to cache updates. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** All cached events, sorted ascending by t. For hit-testing. */
  all(): readonly NewsEvent[] {
    return this.events;
  }

  /** Covered time range, or null if empty. */
  cachedRange(): Range | null {
    if (this.events.length === 0) return null;
    return Range.create(this.events[0]!.t, this.events[this.events.length - 1]!.t);
  }

  /**
   * Request a fetch for `range`, deduplicated by range key. On success,
   * merges the returned events into the store and marks coverage.
   */
  private async requestFetch(range: Range): Promise<void> {
    const key = `${range.min}:${range.max}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);

    try {
      const { events, coveredRange } = await this.fetcher.fetchRange(range);
      if (events.length > 0) this.merge(events);
      this.fetched.add(coveredRange ?? range);
      this.notify();
    } catch (err) {
      // Surface loudly; do not mark as fetched so a later query retries.
      console.error("[EventBroker] fetch failed for", range, err);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }

  /**
   * Merge `incoming` (sorted ascending by t) into the store, deduplicating
   * by (feedId, t, link). Re-sorts once at the end. Events are sparse enough
   * that an O(n+m) merge is fine; we avoid per-insert binary searches.
   */
  private merge(incoming: NewsEvent[]): void {
    if (incoming.length === 0) return;
    const seen = new Set(this.events.map(keyOf));
    const fresh: NewsEvent[] = [];
    for (const e of incoming) {
      const k = keyOf(e);
      if (!seen.has(k)) {
        seen.add(k);
        fresh.push(e);
      }
    }
    if (fresh.length === 0) return;
    this.events = [...this.events, ...fresh].sort((a, b) => a.t - b.t);
  }
}

/** Dedup key: same feed, same timestamp, same link ⇒ same event. */
function keyOf(e: NewsEvent): string {
  return `${e.feedId}|${e.t}|${e.link}`;
}

/**
 * Slice a time-sorted event array to [tMin, tMax] inclusive, via two binary
 * searches. Returns a new array (snapshot); callers must not mutate.
 */
function sliceByTime(events: readonly NewsEvent[], tMin: number, tMax: number): NewsEvent[] {
  if (events.length === 0) return [];
  const lo = lowerBound(events, tMin);
  const hi = upperBound(events, tMax, lo);
  return events.slice(lo, hi);
}

function lowerBound(xs: readonly { readonly t: number }[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(xs: readonly { readonly t: number }[], t: number, from: number): number {
  let lo = from;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
