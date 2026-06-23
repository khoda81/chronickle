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
  static readonly EMPTY: PriceSeries = new PriceSeries([], 0);

  private constructor(
    readonly observations: readonly PricePoint[],
    /** Max |log(p[k+1]/p[k])| / (t[k+1]-t[k]) over pairs where dt > 0. */
    readonly maxRate: number,
  ) {}

  /**
   * Build a PriceSeries from unsorted points. Sorts ascending by `t`
   * (duplicates kept), validates prices, and precomputes `maxRate`.
   * @throws if any price is non-finite or non-positive.
   */
  static from(points: readonly PricePoint[]): PriceSeries {
    if (points.length === 0) return PriceSeries.EMPTY;

    const sorted = [...points].sort((a, b) => a.t - b.t);

    let maxRate = 0;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (!Number.isFinite(a.price) || a.price <= 0) {
        throw new Error(`Invalid price at t=${a.t}: ${a.price}`);
      }
      const dt = b.t - a.t;
      if (dt > 0) {
        const rate = Math.abs(Math.log(b.price / a.price)) / dt;
        if (rate > maxRate) maxRate = rate;
      }
    }
    // Validate last point's price (loop above checks all but the last).
    const last = sorted[sorted.length - 1]!;
    if (!Number.isFinite(last.price) || last.price <= 0) {
      throw new Error(`Invalid price at t=${last.t}: ${last.price}`);
    }

    return new PriceSeries(sorted, maxRate);
  }
}

export interface NewsEvent {
  /** Epoch milliseconds. */
  readonly t: number;
  readonly title: string;
  readonly link: string;
  /** Source label, e.g. "Reuters". */
  readonly source: string;
}

/** A sorted set of news events. */
export interface EventSet {
  /** Sorted ascending by t. */
  readonly events: readonly NewsEvent[];
}
