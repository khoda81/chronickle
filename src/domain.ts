/**
 * Shared domain types for Chronicle.
 *
 * Invariants are encoded structurally:
 *  - All timestamps are epoch milliseconds (number).
 *  - Heatmap samples are pre-sorted ascending by `t` and uniformly spaced.
 *  - Events are pre-sorted ascending by `t`.
 */

export interface HeatSample {
  /** Epoch milliseconds. */
  readonly t: number;
  /** Absolute log-return |log(P_t) - log(P_{t-dt})|. Always >= 0. */
  readonly dI: number;
}

export interface NewsEvent {
  /** Epoch milliseconds. */
  readonly t: number;
  readonly title: string;
  readonly link: string;
  /** Source label, e.g. "Reuters". */
  readonly source: string;
}

/** A contiguous, uniformly-sampled heatmap series. */
export interface HeatSeries {
  /** Sorted ascending, uniform spacing. */
  readonly samples: readonly HeatSample[];
  /** Spacing in milliseconds between consecutive samples. */
  readonly dt: number;
  /** Max dI across samples, used for normalization. 0 if empty. */
  readonly maxDI: number;
}

/** A sorted set of news events. */
export interface EventSet {
  /** Sorted ascending by t. */
  readonly events: readonly NewsEvent[];
}
