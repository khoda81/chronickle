/**
 * EventBroker: the events-side analog of the price `Broker`.
 *
 * The timeline queries synchronously every frame with the visible time
 * range. The broker returns cached events in that range immediately and, per
 * feed, kicks off an async backfill if:
 *   - the feed is not already being fetched (pending), and
 *   - the feed's archive is not known to be exhausted, and
 *   - the oldest cached event from that feed is newer than `range.min`
 *     (i.e. we don't yet have coverage down to the left edge of the viewport).
 *
 * When a fetch lands, the broker merges the new events, updates the feed's
 * oldest-seen timestamp and exhausted flag, and notifies subscribers — the
 * timeline re-queries on the next frame and picks up the new data.
 *
 * This mirrors the price broker's contract: synchronous query, async
 * backfill, subscriber notification. The dedup unit is the **feed id**, not
 * the range — panning around does not spawn duplicate fetches for the same
 * feed, because a feed has at most one in-flight fetch at a time.
 *
 * Storage: a single sorted array of `NewsEvent` (events are sparse — a few
 * thousand at most — so the chunked level store used for prices is overkill).
 * Insertion merges new events into the sorted array, deduplicating by
 * (feedId, t, link).
 */

import type { NewsEvent, RssFeed } from "../../domain.ts";
import { Range } from "../../engine/range.ts";

/** Algebraic query status — mirrors the price broker's contract. */
export type EventQueryStatus = "complete" | "partial" | "empty";

export interface EventQueryResult {
  /** Events in the queried range, sorted ascending by t. A snapshot. */
  readonly events: readonly NewsEvent[];
  readonly status: EventQueryStatus;
}

/**
 * Per-feed fetch state. The broker reasons about feeds, not ranges, because
 * RSS has no range-query API — you can only walk a feed's archive forward.
 *
 *  - `pending`: a fetch is in flight for this feed. Blocks new requests until
 *    it resolves (success or failure), at which point it is cleared.
 *  - `oldestT`: the oldest event timestamp seen from this feed so far, or
 *    null if no events have been fetched yet. Used to decide whether the
 *    viewport's left edge (`range.min`) is already covered.
 *  - `exhausted`: the feed's archive chain ended (no more pages). Once true,
 *    the broker never re-requests this feed — there is nothing more to fetch.
 */
interface FeedFetchState {
  pending: boolean;
  oldestT: number | null;
  exhausted: boolean;
}

export interface FeedFetchResult {
  /** Events fetched for this feed (any timestamp; the broker filters by range). */
  readonly events: NewsEvent[];
  /** True if the feed's archive chain ended — no more pages to walk. */
  readonly exhausted: boolean;
}

export interface EventFetcher {
  /**
   * Fetch events for a single feed, walking its archive until the oldest
   * returned event is at or before `targetMin`, or the archive ends. The
   * fetcher may cache already-walked pages and reuse them across calls for
   * the same feed — only newly-needed pages are fetched.
   */
  fetchFeed(feed: RssFeed, targetMin: number): Promise<FeedFetchResult>;
}

export class EventBroker {
  private events: NewsEvent[] = [];
  private readonly feedState = new Map<string, FeedFetchState>();
  private readonly subscribers = new Set<() => void>();
  /** Callback returning the currently enabled feeds — toggles are live. */
  private readonly activeFeeds: () => readonly RssFeed[];

  constructor(fetcher: EventFetcher, activeFeeds: () => readonly RssFeed[]) {
    this.fetcher = fetcher;
    this.activeFeeds = activeFeeds;
  }

  private readonly fetcher: EventFetcher;

  /**
   * Synchronous query. Returns cached events in `range` (filtered to enabled
   * feeds) and kicks off per-feed backfill for any enabled feed whose oldest
   * cached event is newer than `range.min`. Safe to call every frame — the
   * per-feed `pending` flag dedups in-flight requests.
   */
  query(range: Range): EventQueryResult {
    const enabledIds = new Set(this.activeFeeds().map((f) => f.id));
    const inRange = sliceByTime(this.events, range.min, range.max).filter((e) =>
      enabledIds.has(e.feedId),
    );

    // Kick backfill for enabled feeds that don't yet cover range.min.
    let allCovered = true;
    for (const feed of this.activeFeeds()) {
      const st = this.stateOf(feed.id);
      if (st.pending || st.exhausted) {
        if (!st.exhausted) allCovered = false;
        continue;
      }
      if (st.oldestT !== null && st.oldestT <= range.min) continue;
      allCovered = false;
      void this.requestFetch(feed, range.min);
    }

    let status: EventQueryStatus;
    if (allCovered && inRange.length > 0) status = "complete";
    else if (inRange.length > 0) status = "partial";
    else status = "empty";

    return { events: inRange, status };
  }

  /** Subscribe to cache updates. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** All cached events, sorted ascending by t. For diagnostics. */
  all(): readonly NewsEvent[] {
    return this.events;
  }

  /** Covered time range, or null if empty. */
  cachedRange(): Range | null {
    if (this.events.length === 0) return null;
    return Range.create(this.events[0]!.t, this.events[this.events.length - 1]!.t);
  }

  /** Get or create the fetch state for a feed. */
  private stateOf(feedId: string): FeedFetchState {
    let st = this.feedState.get(feedId);
    if (st === undefined) {
      st = { pending: false, oldestT: null, exhausted: false };
      this.feedState.set(feedId, st);
    }
    return st;
  }

  /**
   * Request a fetch for `feed` walking its archive toward `targetMin`. Sets
   * `pending` for the duration; on resolution, merges events, updates
   * `oldestT`/`exhausted`, and notifies subscribers. On failure, clears
   * `pending` without marking exhausted (a later query will retry).
   */
  private async requestFetch(feed: RssFeed, targetMin: number): Promise<void> {
    const st = this.stateOf(feed.id);
    if (st.pending) return;
    st.pending = true;

    try {
      const { events, exhausted } = await this.fetcher.fetchFeed(feed, targetMin);
      if (events.length > 0) this.merge(events);
      // Update oldestT to the oldest event we now know about for this feed
      // (across all fetches, not just this one).
      if (events.length > 0) {
        const oldest = events[0]!.t;
        if (st.oldestT === null || oldest < st.oldestT) st.oldestT = oldest;
      }
      st.exhausted = exhausted;
      this.notify();
    } catch (err) {
      // Surface loudly; do not mark exhausted so a later query retries.
      console.error(`[EventBroker] fetch failed for feed ${feed.source}:`, err);
    } finally {
      st.pending = false;
    }
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }

  /**
   * Merge `incoming` into the sorted store, deduplicating by (feedId, t, link).
   * Events are sparse enough that an O(n+m) merge is fine.
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
