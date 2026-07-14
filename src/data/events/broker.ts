/**
 * EventBroker: the events-side analog of the price `Broker`.
 *
 * The timeline queries synchronously every frame with the visible time
 * range. The broker returns cached events in that range immediately and, per
 * feed, kicks off an async backfill via that feed's `FeedWalker` when the
 * viewport's left edge is not yet covered.
 *
 * Per-feed state is a tagged union (`FeedState`) — invalid combinations like
 * "fetching and exhausted" are unrepresentable. Transitions:
 *
 *   idle ──needs more──► fetching
 *   fetching ──progress──► idle (oldestT updated)            [coverage reached]
 *   fetching ──exhausted──► exhausted
 *   fetching ──failed──► failed
 *   fetching ──backoff──► backoff (nextAttemptAt = now + 2^attempt s, cap 60s)
 *   backoff ──now >= nextAttemptAt + needs more──► fetching
 *   backoff ──success──► idle (attempt reset)
 *
 * Failure handling:
 *  - Terminal failures (`failed`) are never retried. The feed is dead.
 *  - Transient failures (`backoff`) use exponential backoff capped at 60s.
 *  - Mid-walk events are committed incrementally via the walker's `onEvents`
 *    callback, so a failure on page N does not lose pages 1..N-1.
 *
 * Storage: a single sorted array of `NewsEvent` (events are sparse — a few
 * thousand at most — so the chunked level store used for prices is overkill).
 * Insertion merges new events into the sorted array, deduplicating by
 * (feedId, t, link).
 */

import type { NewsEvent, RssFeed } from "../../domain.ts";
import { Range } from "../../engine/range.ts";
import { FeedWalker, type FeedWalkerOptions, type WalkOutcome } from "./walker.ts";

/** Algebraic query status — mirrors the price broker's contract. */
export type EventQueryStatus = "complete" | "partial" | "empty";

export interface EventQueryResult {
  /** Events in the queried range, sorted ascending by t. A snapshot. */
  readonly events: readonly NewsEvent[];
  readonly status: EventQueryStatus;
}

/**
 * Per-feed state machine. Tagged union — invalid combinations are
 * unrepresentable.
 *
 *  - `idle`:      not fetching, not terminal. `oldestT` is the oldest event
 *                 timestamp seen for this feed (Infinity if none yet).
 *  - `fetching`:  a walk is in flight. Blocks new walks until it resolves.
 *  - `exhausted`: the feed's archive chain ended. Never re-requested.
 *  - `failed`:    a terminal failure occurred. Never re-requested.
 *  - `backoff`:   a transient failure occurred. Retry after `nextAttemptAt`.
 */
type FeedState =
  | { readonly kind: "idle"; readonly oldestT: number }
  | { readonly kind: "fetching" }
  | { readonly kind: "exhausted"; readonly oldestT: number }
  | { readonly kind: "failed"; readonly reason: string }
  | {
      readonly kind: "backoff";
      readonly oldestT: number;
      readonly nextAttemptAt: number;
      readonly attempt: number;
    };

/** Backoff cap: 60s. Base: 1s, doubling per attempt. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export interface EventWalker {
  readonly failureReason: string | null;
  walk(targetMin: number, onEvents: (events: readonly NewsEvent[]) => void): Promise<WalkOutcome>;
}

export type EventWalkerFactory = (feed: RssFeed, opts: FeedWalkerOptions) => EventWalker;

export interface EventBrokerDiagnostics {
  readonly onDebug?: (message: string) => void;
  readonly onError?: (message: string, error: unknown) => void;
}

export class EventBroker {
  private events: NewsEvent[] = [];
  private readonly feedState = new Map<string, FeedState>();
  private readonly walkers = new Map<string, EventWalker>();
  private readonly subscribers = new Set<() => void>();
  /** Callback returning the currently enabled feeds — toggles are live. */
  private readonly activeFeeds: () => readonly RssFeed[];
  private readonly walkerOpts: FeedWalkerOptions;
  private readonly walkerFactory: EventWalkerFactory;
  private readonly onDebug: (message: string) => void;
  private readonly onError: (message: string, error: unknown) => void;
  private generation = 0;

  constructor(
    walkerOpts: FeedWalkerOptions = {},
    activeFeeds: () => readonly RssFeed[],
    walkerFactory: EventWalkerFactory = (feed, opts) => new FeedWalker(feed, opts),
    diagnostics: EventBrokerDiagnostics = {},
  ) {
    this.walkerOpts = walkerOpts;
    this.activeFeeds = activeFeeds;
    this.walkerFactory = walkerFactory;
    this.onDebug = diagnostics.onDebug ?? ((message) => console.debug(message));
    this.onError = diagnostics.onError ?? ((message, error) => console.error(message, error));
  }

  /**
   * Synchronous query. Returns cached events in `range` (filtered to enabled
   * feeds) and kicks off per-feed backfill for any enabled feed whose oldest
   * cached event is newer than `range.min`. Safe to call every frame — the
   * `fetching` state dedups in-flight walks, and `backoff`/`failed`/`exhausted`
   * prevent redundant requests.
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
      const covered = this.kickIfNeeded(feed, st, range.min);
      if (!covered) allCovered = false;
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

  /** Clear event/page state and ignore callbacks from walks already in flight. */
  clearCache(): void {
    this.generation++;
    this.events = [];
    this.feedState.clear();
    this.walkers.clear();
    this.notify();
  }

  /**
   * Decide whether `feed` is covered for `range.min`, and kick a walk if not.
   * Returns true if the feed is covered (or terminal — nothing more to fetch).
   */
  private kickIfNeeded(feed: RssFeed, st: FeedState, rangeMin: number): boolean {
    switch (st.kind) {
      case "fetching":
        return false; // in flight; not yet covered
      case "exhausted":
      case "failed":
        return true; // terminal — nothing more to fetch, treat as covered
      case "idle":
        if (st.oldestT <= rangeMin) return true; // already covered
        void this.requestWalk(feed, rangeMin, 0);
        return false;
      case "backoff": {
        if (Date.now() < st.nextAttemptAt) return false; // waiting
        if (st.oldestT <= rangeMin) return true; // covered, no retry needed
        void this.requestWalk(feed, rangeMin, st.attempt);
        return false;
      }
    }
  }

  /** Get or create the feed state. New feeds start in `idle` with oldestT=∞. */
  private stateOf(feedId: string): FeedState {
    let st = this.feedState.get(feedId);
    if (st === undefined) {
      st = { kind: "idle", oldestT: Infinity };
      this.feedState.set(feedId, st);
    }
    return st;
  }

  /** Get or create the walker for a feed. */
  private walkerOf(feed: RssFeed): EventWalker {
    let w = this.walkers.get(feed.id);
    if (w === undefined) {
      w = this.walkerFactory(feed, this.walkerOpts);
      this.walkers.set(feed.id, w);
    }
    return w;
  }

  /**
   * Request a walk for `feed` toward `targetMin`. Transitions to `fetching`
   * for the duration. The walker commits events incrementally via `onEvents`,
   * which merges into the store and updates `oldestT`. On resolution,
   * transitions to `idle`/`exhausted`/`failed`/`backoff` and notifies.
   */
  private async requestWalk(feed: RssFeed, targetMin: number, attempt: number): Promise<void> {
    const st = this.stateOf(feed.id);
    if (st.kind === "fetching") return; // dedup

    this.feedState.set(feed.id, { kind: "fetching" });
    const walker = this.walkerOf(feed);
    const generation = this.generation;

    try {
      const outcome = await walker.walk(targetMin, (pageEvents) => {
        if (generation !== this.generation) return;
        this.merge(pageEvents);
        // Update oldestT from the store — the source of truth. We need the
        // current state's oldestT to compare, so recompute from the merged
        // store for this feed.
        this.updateOldestT(feed.id);
      });
      if (generation !== this.generation) return;

      // Transition based on outcome. Read current oldestT from the store.
      const oldestT = this.oldestTForFeed(feed.id);
      switch (outcome) {
        case "exhausted":
          this.feedState.set(feed.id, { kind: "exhausted", oldestT });
          this.onDebug(`Feed exhausted: ${feed.source}`);
          break;
        case "failed":
          this.feedState.set(feed.id, {
            kind: "failed",
            reason: walker.failureReason ?? "unknown",
          });
          this.onDebug(`Feed failed: ${feed.source}`);
          break;
        case "backoff": {
          const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
          this.feedState.set(feed.id, {
            kind: "backoff",
            oldestT,
            nextAttemptAt: Date.now() + delay,
            attempt: attempt + 1,
          });
          this.onDebug(`Backing off for ${feed.source}: delay=${delay}ms`);
          break;
        }
      }
      this.notify();
    } catch (err) {
      if (generation !== this.generation) return;
      // Should not happen — the walker catches and classifies its own errors.
      // If it does, treat as backoff so we retry rather than silently dying.
      this.onError(`[EventBroker] unexpected walk failure for ${feed.source}`, err);
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
      this.feedState.set(feed.id, {
        kind: "backoff",
        oldestT: this.oldestTForFeed(feed.id),
        nextAttemptAt: Date.now() + delay,
        attempt: attempt + 1,
      });
    }
  }

  /**
   * Merge `incoming` into the sorted store, deduplicating by (feedId, t, link).
   * Events are sparse enough that an O(n+m) merge is fine.
   */
  private merge(incoming: readonly NewsEvent[]): void {
    if (incoming.length === 0) return;
    const seen = new Set(this.events.map(keyOf));
    const fresh: NewsEvent[] = [];
    for (const e of incoming) {
      const k = keyOf(e);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(e);
    }
    if (fresh.length === 0) return;
    this.events = [...this.events, ...fresh].sort((a, b) => a.t - b.t);
  }

  /** Update the `oldestT` on the current `idle`/`backoff` state for a feed. */
  private updateOldestT(feedId: string): void {
    const oldestT = this.oldestTForFeed(feedId);
    const st = this.feedState.get(feedId);
    if (st === undefined) return;
    switch (st.kind) {
      case "idle":
        this.feedState.set(feedId, { kind: "idle", oldestT });
        break;
      case "backoff":
        this.feedState.set(feedId, { ...st, oldestT });
        break;
      // fetching/exhausted/failed: oldestT is set on transition, not here.
    }
  }

  /** The oldest event timestamp in the store for a given feed, or Infinity. */
  private oldestTForFeed(feedId: string): number {
    let oldest = Infinity;
    for (const e of this.events) {
      if (e.feedId === feedId && e.t < oldest) oldest = e.t;
    }
    return oldest;
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
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
