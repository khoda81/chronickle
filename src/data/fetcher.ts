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

import { Range } from "../engine/range.ts";
import { PricePoint } from "../domain.ts";

export interface FetchRangeOptions {
  /** Visible time range, inclusive. */
  readonly range: Range;
  /**
   * Maximum acceptable spacing between consecutive returned samples, in ms.
   * The fetcher picks the finest native resolution whose period is <= this.
   */
  readonly maxDeltaTMs: number;
}

export interface Fetcher {
  /** Native sample periods this source can serve, ascending (finest→coarsest), in ms. */
  readonly nativePeriodsMs: readonly number[];

  /** Fetch history for `range` at a resolution satisfying `maxDeltaTMs`. */
  fetchRange(opts: FetchRangeOptions): Promise<PricePoint[]>;

  /**
   * Open a live tick stream. Each incoming print calls `onPoint`. Returns
   * an unsubscribe function. Optional — sources without a ws/trades stream
   * omit this.
   */
  streamTick?(onPoint: (p: PricePoint) => void): () => void;
}
