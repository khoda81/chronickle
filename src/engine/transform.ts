/**
 * Pure linear transform between a time domain and a screen domain.
 *
 * Both domains are represented as `Range`s. The screen domain is typically
 * `{0, width}` but is not required to be — this leaves room for moving the
 * plot around on screen (e.g. insets, margins) without changing the time
 * mapping. The y domain is also carried so that vertical layout (heatmap
 * strip, event row, axis) can be derived from a single transform object
 * instead of passing `height` around separately.
 *
 * The transform is a pure value: given the same three ranges, the same
 * `DataTransform` is produced. It performs no allocation in its mapping
 * functions. It is constructed fresh each frame from the plot state.
 */

import type { Range } from "./range.ts";

export interface DataTransform {
  /** Visible time window (epoch ms). */
  readonly timeDomain: Range;
  /** Horizontal screen window (CSS px). Usually {0, width}. */
  readonly screenDomain: Range;
  /** Vertical screen window (CSS px). Usually {0, height}. */
  readonly yDomain: Range;
}

export const DataTransform = {
  create(
    timeDomain: Range,
    screenDomain: Range,
    yDomain: Range,
  ): DataTransform {
    return { timeDomain, screenDomain, yDomain };
  },

  /** Map a time value to a screen x pixel. */
  timeToX(tx: DataTransform, t: number): number {
    const td = tx.timeDomain;
    const sd = tx.screenDomain;
    return sd.min + ((t - td.min) / (td.max - td.min)) * (sd.max - sd.min);
  },

  /** Inverse of `timeToX`: screen x pixel to time. */
  xToTime(tx: DataTransform, x: number): number {
    const td = tx.timeDomain;
    const sd = tx.screenDomain;
    return td.min + ((x - sd.min) / (sd.max - sd.min)) * (td.max - td.min);
  },

  /** True if `t` is within the visible time window (inclusive). */
  containsTime(tx: DataTransform, t: number): boolean {
    const td = tx.timeDomain;
    return t >= td.min && t <= td.max;
  },
};
