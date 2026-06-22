/**
 * Timeline viewport.
 *
 * The viewport maps a continuous time domain [tStart, tEnd] to canvas pixels.
 * It is the single source of truth for pan/zoom state; the renderer is a pure
 * function of (viewport, series, events, canvas size).
 *
 * State is mutated only through the helpers below, each of which returns a new
 * immutable Viewport. This keeps the render loop free of mutation surprises
 * and lets requestAnimationFrame read consistently.
 */

export interface Viewport {
  /** Left edge of the visible window, epoch ms. */
  readonly tStart: number;
  /** Right edge of the visible window, epoch ms. */
  readonly tEnd: number;
}

export const Viewport = {
  /** Create a viewport. tStart must be < tEnd. */
  create(tStart: number, tEnd: number): Viewport {
    if (!(tStart < tEnd)) {
      throw new Error(`Invalid viewport: tStart (${tStart}) must be < tEnd (${tEnd})`);
    }
    return { tStart, tEnd };
  },

  /** Span in ms. */
  span(v: Viewport): number {
    return v.tEnd - v.tStart;
  },

  /**
   * Pan by `dtMs` (positive = pan right / later in time).
   * Returns a new Viewport.
   */
  pan(v: Viewport, dtMs: number): Viewport {
    return { tStart: v.tStart + dtMs, tEnd: v.tEnd + dtMs };
  },

  /**
   * Zoom around a focal time `tFocus` by `factor` (>1 zooms in, <1 zooms out).
   * The focal point stays anchored to the same screen position.
   * Returns a new Viewport.
   */
  zoom(v: Viewport, tFocus: number, factor: number): Viewport {
    if (!(factor > 0)) {
      throw new Error(`Zoom factor must be positive, got ${factor}`);
    }
    const leftRatio = (tFocus - v.tStart) / (v.tEnd - v.tStart);
    const newSpan = (v.tEnd - v.tStart) / factor;
    const newStart = tFocus - leftRatio * newSpan;
    const newEnd = newStart + newSpan;
    if (!(newStart < newEnd)) {
      throw new Error(`Zoom produced invalid viewport: ${newStart}..${newEnd}`);
    }
    return { tStart: newStart, tEnd: newEnd };
  },

  /**
   * Fit the viewport to a data range with optional padding ratio.
   */
  fit(tMin: number, tMax: number, padRatio = 0.05): Viewport {
    if (!(tMin < tMax)) {
      throw new Error(`Cannot fit to empty/degenerate range: ${tMin}..${tMax}`);
    }
    const span = tMax - tMin;
    const pad = span * padRatio;
    return { tStart: tMin - pad, tEnd: tMax + pad };
  },
};

/**
 * Linear transform from time (ms) to canvas x-pixel.
 * Pure function; cheap to construct per frame.
 */
export function timeToX(v: Viewport, width: number, t: number): number {
  return ((t - v.tStart) / (v.tEnd - v.tStart)) * width;
}

/** Inverse of timeToX. */
export function xToTime(v: Viewport, width: number, x: number): number {
  return v.tStart + (x / width) * (v.tEnd - v.tStart);
}
