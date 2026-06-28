/**
 * Shared domain types for Chronicle.
 *
 * Invariants are encoded structurally:
 *  - All timestamps are epoch milliseconds (number).
 *  - PriceSeries observations are sorted ascending by `t` (duplicates allowed).
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
 * A sorted price time-series. Observations are stored as-received (never
 * compressed or resampled). The series exposes `maxRate` — the maximum
 * per-observation log-return rate — as a zoom-invariant normalization bound
 * for the renderer.
 */
export class PriceSeries {
  static readonly EMPTY: PriceSeries = new PriceSeries([]);

  private constructor(readonly observations: readonly PricePoint[]) {}

  /**
   * Build a PriceSeries from unsorted points. Sorts ascending by `t`
   * (duplicates kept), validates prices, and precomputes `maxRate`.
   * @throws if any price is non-finite or non-positive.
   */
  static from(points: readonly PricePoint[]): PriceSeries {
    if (points.length === 0) return PriceSeries.EMPTY;

    const sorted = [...points].sort((a, b) => a.t - b.t);

    return new PriceSeries(sorted);
  }
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
