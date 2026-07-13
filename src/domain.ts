/**
 * Shared domain types for chronickle.
 *
 * Invariants are encoded structurally:
 *  - All timestamps are epoch milliseconds (number).
 *  - PriceSeries observations are sorted strictly ascending by `t`.
 *  - All prices are finite and positive (validated at construction).
 *  - Events are pre-sorted ascending by `t`.
 */

export interface PricePoint {
  /** Epoch milliseconds. */
  readonly t: number;
  /** Price at time `t`. Always finite and > 0. */
  readonly price: number;
}

/**
 * A validated, sorted price time-series. Duplicate timestamps are collapsed
 * with the last observation winning. This matches the price-store overwrite
 * rule and makes the strictly-ascending invariant explicit at the boundary.
 */
export class PriceSeries {
  static readonly EMPTY: PriceSeries = new PriceSeries([]);

  private constructor(readonly observations: readonly PricePoint[]) {}

  /**
   * Build a PriceSeries from unsorted points. Sorts ascending by `t`, validates
   * timestamps and prices, and collapses duplicates with the last value winning.
   * @throws if a timestamp is non-finite or a price is non-finite/non-positive.
   */
  static from(points: readonly PricePoint[]): PriceSeries {
    if (points.length === 0) return PriceSeries.EMPTY;

    const sorted = [...points];
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]!;
      if (!Number.isFinite(p.t)) {
        throw new Error(`PriceSeries.from: non-finite timestamp at index ${i}: ${p.t}`);
      }
      if (!Number.isFinite(p.price) || !(p.price > 0)) {
        throw new Error(
          `PriceSeries.from: price must be finite and positive at index ${i}: ${p.price}`,
        );
      }
    }
    sorted.sort((a, b) => a.t - b.t);

    const deduped: PricePoint[] = [];
    for (const p of sorted) {
      const last = deduped[deduped.length - 1];
      if (last?.t === p.t) deduped[deduped.length - 1] = p;
      else deduped.push(p);
    }

    return new PriceSeries(deduped);
  }
}

/** A validated observation in logarithmic price space. */
export interface LogPricePoint {
  /** Epoch milliseconds. */
  readonly t: number;
  /** Natural logarithm of price. Always finite. */
  readonly logPrice: number;
}

/**
 * A registered RSS/Atom feed.
 *
 * `id` is a stable unique key (hash of URL) used to correlate events to
 * their feed and to look up the feed's color. `color` is derived once at
 * registration via golden-angle oklch (see `data/color.ts`) and is immutable
 * thereafter — colors never get renumbered, so removing a feed does not
 * shift the colors of the remaining ones.
 */
export interface RssFeed {
  /** Stable unique id (hash of URL). */
  readonly id: string;
  /** Display name — from the feed's <title> or a user override. */
  readonly source: string;
  readonly url: string;
  /** Derived at registration via golden-angle oklch. Immutable. */
  readonly color: string;
  /** Whether the feed contributes events to the timeline. Toggled via UI. */
  readonly enabled: boolean;
}

export interface NewsEvent {
  /** Epoch milliseconds. */
  readonly t: number;
  readonly title: string;
  readonly link: string;
  /** Optional summary/description for tooltip enrichment. May be empty. */
  readonly summary: string;
  /** Stable feed id; color resolved via FeedRegistry at render time. */
  readonly feedId: string;
}

/** A sorted set of news events. */
export interface EventSet {
  /** Sorted ascending by t. */
  readonly events: readonly NewsEvent[];
}
