/**
 * The fetcher contract: a single price source's ability to serve history
 * and (optionally) live ticks.
 *
 * The broker never reasons about native resolution strings ("1", "5", "D",
 * "1m", etc.). It asks for a `maxDeltaTMs` — "give me points spaced at most
 * this far apart" — and the fetcher internally picks the coarsest native
 * resolution whose period is `<= maxDeltaTMs`. If the returned data is
 * finer than asked, that's fine: the staircase evaluator samples it at the
 * UI's pixel-boundary timestamps regardless of sample density.
 *
 * Timestamps are epoch milliseconds everywhere. Fetchers that consume
 * second-precision APIs (e.g. Nobitex OHLC) convert at the boundary.
 */

import { Range } from "../../engine/range.ts";
import { PricePoint } from "../../domain.ts";

export interface FetchRangeOptions {
  /** Visible time range, inclusive. */
  readonly range: Range;
  /**
   * Maximum acceptable spacing between consecutive returned samples, in ms.
   * The fetcher picks the finest native resolution whose period is <= this.
   */
  readonly maxDeltaTMs: number;
}

/**
 * Result of a range fetch.
 *
 * `coverage` tells the broker whether the request was completely answered,
 * partially answered because of a source cap, or known to contain no data.
 * The tagged union avoids the old overloaded `null` convention.
 */
export type FetchCoverage =
  | { readonly kind: "complete"; readonly range: Range }
  | { readonly kind: "partial"; readonly range: Range }
  | { readonly kind: "empty"; readonly range: Range };

export interface FetchRangeResult {
  /** Points actually returned, sorted ascending by t. May be empty. */
  readonly points: readonly PricePoint[];
  /** Actual native period selected by the adapter for this response. */
  readonly resolutionMs: number;
  readonly coverage: FetchCoverage;
}

export interface Fetcher {
  /** Native sample periods this source can serve, ascending (finest→coarsest), in ms. */
  readonly nativePeriodsMs: readonly number[];

  /**
   * Fetch history for `range` at a resolution satisfying `maxDeltaTMs`.
   * When data exists before `range.min`, the returned points must include the
   * immediately preceding observation so ZOH is anchored at the left edge.
   */
  fetchRange(opts: FetchRangeOptions): Promise<FetchRangeResult>;

  /**
   * Open a live tick stream. Each incoming print calls `onPoint`. Returns
   * an unsubscribe function. Optional — sources without a ws/trades stream
   * omit this.
   */
  streamTick?(onPoint: (p: PricePoint) => void): () => void;
}
