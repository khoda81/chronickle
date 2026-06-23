/**
 * A closed numeric range [min, max] with min < max.
 *
 * Used as the single representation of a time (or screen) interval across
 * the codebase — replacing the previous `Viewport` type. The same type serves
 * both the time domain (epoch ms) and the screen domain (CSS pixels), which
 * keeps the data model minimal and lets `DataTransform` treat both uniformly.
 *
 * Invariants are enforced at construction: `min < max` is the only rule, and
 * it is checked loudly. All operations return new immutable ranges; nothing
 * mutates in place.
 */

export interface Range {
  /** Inclusive lower bound. */
  readonly min: number;
  /** Inclusive upper bound. */
  readonly max: number;
}

export const Range = {
  /** Create a range. Throws if `min >= max`. */
  create(min: number, max: number): Range {
    if (!(min < max)) {
      throw new Error(`Invalid range: min (${min}) must be < max (${max})`);
    }
    return { min, max };
  },

  /** Span: max - min. Always positive for a valid range. */
  span(r: Range): number {
    return r.max - r.min;
  },

  /** True if `v` lies within [min, max]. */
  contains(r: Range, v: number): boolean {
    return v >= r.min && v <= r.max;
  },

  /**
   * Pan by `delta` (positive shifts toward larger values).
   * Returns a new Range.
   */
  pan(r: Range, delta: number): Range {
    return { min: r.min + delta, max: r.max + delta };
  },

  /**
   * Zoom around a focal point `f` by `factor` (>1 zooms in, <1 zooms out).
   * The focal point stays anchored to the same relative position.
   * Returns a new Range. Throws if the result is degenerate.
   */
  zoom(r: Range, f: number, factor: number): Range {
    if (!(factor > 0)) {
      throw new Error(`Zoom factor must be positive, got ${factor}`);
    }
    const leftRatio = (f - r.min) / (r.max - r.min);
    const newSpan = (r.max - r.min) / factor;
    const newMin = f - leftRatio * newSpan;
    const newMax = newMin + newSpan;
    if (!(newMin < newMax)) {
      throw new Error(`Zoom produced invalid range: ${newMin}..${newMax}`);
    }
    return { min: newMin, max: newMax };
  },

  /**
   * Fit a range around [a, b] with optional padding ratio (applied symmetrically).
   * Throws if `a >= b`.
   */
  fit(a: number, b: number, padRatio = 0.05): Range {
    if (!(a < b)) {
      throw new Error(`Cannot fit to degenerate range: ${a}..${b}`);
    }
    const span = b - a;
    const pad = span * padRatio;
    return { min: a - pad, max: b + pad };
  },
};
