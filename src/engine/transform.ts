/**
 * Pure linear transform between a time domain and a screen domain.
 *
 * Both domains are represented as `Interval`s. The screen domain is typically
 * `{0, width}` but is not required to be — this leaves room for moving the
 * plot around on screen (e.g. insets, margins) without changing the time
 * mapping. The y domain is also carried so that vertical layout (heatmap
 * strip, event row, axis) can be derived from a single transform object
 * instead of passing `height` around separately.
 *
 * The transform is a pure value: given the same three ranges, the same
 * `DataTransform` is produced. Its mapping methods perform no allocation.
 * It is constructed fresh each frame from the plot state.
 */

import { Interval } from "../core/interval.ts";

export class DataTransform {
  private readonly timeSpan: number;
  private readonly screenSpan: number;

  constructor(
    /** Visible time window (epoch ms). */
    readonly timeDomain: Interval,
    /** Horizontal screen window (CSS px). Usually {0, width}. */
    readonly screenDomain: Interval,
    /** Vertical screen window (CSS px). Usually {0, height}. */
    readonly yDomain: Interval,
  ) {
    this.timeSpan = timeDomain.end - timeDomain.start;
    this.screenSpan = screenDomain.end - screenDomain.start;
  }

  /** Map a time value to a screen x pixel. */
  timeToX(t: number): number {
    const td = this.timeDomain;
    const sd = this.screenDomain;
    return sd.start + ((t - td.start) / this.timeSpan) * this.screenSpan;
  }

  /** Inverse of `timeToX`: screen x pixel to time. */
  xToTime(x: number): number {
    const td = this.timeDomain;
    const sd = this.screenDomain;
    return td.start + ((x - sd.start) / this.screenSpan) * this.timeSpan;
  }

  /** True if `t` is within the half-open visible time interval. */
  containsTime(t: number): boolean {
    return Interval.contains(this.timeDomain, t);
  }
}
