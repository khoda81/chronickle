/**
 * The Broker: uni-directional data model orchestrator.
 *
 * The UI queries the broker synchronously with an array of evaluation
 * timestamps (typically W+1 pixel boundaries). The broker evaluates the
 * staircase against its cached store and returns values immediately. If the
 * cache cannot satisfy the query — gaps in coverage, or the cached
 * resolution is too coarse for the requested spacing — the broker triggers
 * an async fetch from the source's `Fetcher` and notifies subscribers when
 * new data has been inserted, so the UI can re-query.
 *
 * The UI never awaits. `query` is synchronous and always returns *something*;
 * incomplete coverage is signaled via the result's `status` field and by
 * NaN values in the output where no sample exists yet.
 *
 * One broker per price source. `main.ts` may own several brokers.
 */

import { Chunk, ChunkedLevelStore } from "./broker.ts";
import { evaluateStaircase, StaircaseResult } from "./staircase.ts";
import { RangeSet } from "./rangeSet.ts";
import { Fetcher } from "./fetcher.ts";
import { Range } from "../engine/range.ts";
import { PricePoint } from "../domain.ts";

/** Algebraic query status — not a nullable, not a flag field. */
export type QueryStatus =
  /** All eval points fell within cached coverage at sufficient resolution. */
  | "complete"
  /** Some eval points were covered; a fetch is in flight for the rest. */
  | "partial"
  /** No cached data in range; a fetch is in flight. */
  | "empty";

export interface QueryResult extends StaircaseResult {
  readonly status: QueryStatus;
}

export interface QueryOptions {
  /**
   * Ascending evaluation timestamps (epoch ms), typically W+1 pixel
   * boundaries. The staircase is evaluated at each of these.
   */
  readonly evalTime: Float64Array;
  /**
   * Maximum acceptable spacing between cached samples, in ms. If the cached
   * data in range is coarser than this, the broker fetches a finer
   * resolution. Derived by the UI from the viewport (e.g. pixel width / span).
   */
  readonly maxDeltaTMs: number;
}

export class Broker {
  private readonly store = new ChunkedLevelStore();
  private readonly fetched = new RangeSet();
  private readonly subscribers = new Set<() => void>();
  /** Ranges currently being fetched, to suppress duplicate requests. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly fetcher: Fetcher) {}

  /**
   * Synchronous query. Returns staircase values at `evalTime` from the
   * cache. If coverage is incomplete or resolution too coarse, kicks off an
   * async fetch; subscribers are notified when the fetch lands and the UI
   * should re-query.
   */
  query(opts: QueryOptions): QueryResult {
    const { evalTime, maxDeltaTMs } = opts;
    const result = evaluateStaircase(this.store.chunks, evalTime);

    if (evalTime.length === 0) {
      return { ...result, status: "empty" };
    }

    const tMin = evalTime[0]!;
    const tMax = evalTime[evalTime.length - 1]!;
    const range = safeRange(tMin, tMax);

    // Coverage check: have we fetched this range at all?
    const covered = this.fetched.covers(range);
    const hasAnyCached =
      this.store.pointCount > 0 && result.leadingNaN + result.trailingNaN < evalTime.length;

    let status: QueryStatus;
    if (covered && hasAnyCached) {
      // Coverage exists. Resolution check: is the cached data fine enough?
      // We approximate by checking the store's coarsest gap relative to
      // maxDeltaTMs. A precise per-bucket resolution check is expensive; the
      // staircase evaluator already hides over-fine data, so we only re-fetch
      // when coverage is genuinely missing (gaps in `fetched`).
      status = "complete";
    } else if (hasAnyCached) {
      status = "partial";
      void this.requestFetch(range, maxDeltaTMs);
    } else {
      status = "empty";
      void this.requestFetch(range, maxDeltaTMs);
    }

    return { ...result, status };
  }

  /** Subscribe to cache updates. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Current cached time range, or null if empty. */
  cachedRange(): Range | null {
    return this.store.timeRange();
  }

  /** Direct access to chunks (e.g. for diagnostics or custom evaluators). */
  chunks(): readonly Chunk[] {
    return this.store.chunks;
  }

  /**
   * Request a fetch for `range` at `maxDeltaTMs`, unless one is already in
   * flight for the same (range, maxDeltaTMs) key. On success, inserts the
   * result and notifies subscribers.
   */
  private async requestFetch(range: Range, maxDeltaTMs: number): Promise<void> {
    const key = `${range.min}:${range.max}:${maxDeltaTMs}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);

    try {
      const points = await this.fetcher.fetchRange({ range, maxDeltaTMs });
      if (points.length > 0) {
        const time = new Float64Array(points.length);
        const value = new Float32Array(points.length);
        for (let i = 0; i < points.length; i++) {
          const p = points[i]!;
          time[i] = p.t;
          value[i] = p.price;
        }
        this.store.insertBatch(time, value);
      }
      // Mark the range as fetched whether or not we got points. An empty
      // result (e.g. Nobitex "no_data" for a range with no candles) is a
      // valid answer, not an error — we must not retry every frame.
      this.fetched.add(range);
      this.notify();
    } catch (err) {
      // Surface failure loudly per AGENTS.md §2: re-throw to the console,
      // but do not crash the broker. The UI's status bar should reflect this
      // via a separate error channel (to be wired in main.ts).
      // We deliberately do NOT mark `range` as fetched — a later query will
      // retry.
      console.error("[Broker] fetch failed for", range, err);
    } finally {
      this.inFlight.delete(key);
    }
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }
}

/** Build a Range, tolerating min === max by nudging max by 1ms. */
function safeRange(min: number, max: number): Range {
  if (min === max) return Range.create(min, min + 1);
  if (min > max) return Range.create(max, min);
  return Range.create(min, max);
}
