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
 * `coveredRange` tells the broker what part of the request was actually
 * populated with data, so it can avoid marking unfilled regions as fetched.
 *
 * - `null` means the source asserts the **entire** requested range is
 *   exhausted — either no data exists there ("no_data"), or every available
 *   candle was returned (the response was not truncated by a server-side
 *   cap). The broker marks the whole `range` as fetched.
 *
 * - A non-null `Range` means the source only filled a sub-range (e.g. an API
 *   that caps results at the most recent N points). The broker marks only
 *   `coveredRange` as fetched, leaving the unfilled prefix as a gap to be
 *   re-requested on the next query — progressive backfill.
 */
export interface FetchRangeResult {
  /** Points actually returned, sorted ascending by t. May be empty. */
  readonly points: PricePoint[];
  /** The time range this fetch populated, or `null` if the request is exhausted. */
  readonly coveredRange: Range | null;
}

export interface Fetcher {
  /** Native sample periods this source can serve, ascending (finest→coarsest), in ms. */
  readonly nativePeriodsMs: readonly number[];

  /** Fetch history for `range` at a resolution satisfying `maxDeltaTMs`. */
  fetchRange(opts: FetchRangeOptions): Promise<FetchRangeResult>;

  /**
   * Open a live tick stream. Each incoming print calls `onPoint`. Returns
   * an unsubscribe function. Optional — sources without a ws/trades stream
   * omit this.
   */
  streamTick?(onPoint: (p: PricePoint) => void): () => void;
}
