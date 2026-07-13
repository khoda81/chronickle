/**
 * A set of disjoint, sorted closed ranges [min, max].
 *
 * Used by the broker to track which time ranges have been fetched (at any
 * resolution) so it can detect gaps and avoid re-issuing in-flight requests.
 *
 * Invariant: `intervals` is ascending by `min`, and consecutive intervals
 * are *non-overlapping and non-adjacent* (adjacent ranges are merged on
 * insert). `min < max` for every interval, enforced by `Range.create`.
 */

import { Range } from "../engine/range.ts";

// TODO:‌ This should keep the ranges sorted and use binary search
export class RangeSet {
  private readonly intervals: Range[] = [];

  /** Currently covered intervals, ascending. Defensive copy. */
  ranges(): readonly Range[] {
    return this.intervals.slice();
  }

  /** True if every point in `r` lies inside some covered interval. */
  covers(r: Range): boolean {
    for (const iv of this.intervals) {
      if (iv.min <= r.min && iv.max >= r.max) return true;
    }
    return false;
  }

  /** True when `t` belongs to one of the covered intervals. */
  contains(t: number): boolean {
    let lo = 0;
    let hi = this.intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const iv = this.intervals[mid]!;
      if (t < iv.min) hi = mid - 1;
      else if (t > iv.max) lo = mid + 1;
      else return true;
    }
    return false;
  }

  /** Covered portions of `r`, clipped to `r`, in ascending order. */
  intersections(r: Range): readonly Range[] {
    const out: Range[] = [];
    for (const iv of this.intervals) {
      if (iv.max <= r.min) continue;
      if (iv.min >= r.max) break;
      const min = Math.max(iv.min, r.min);
      const max = Math.min(iv.max, r.max);
      if (min < max) out.push(Range.create(min, max));
    }
    return out;
  }

  /**
   * Add a covered range, merging overlaps/adjacencies.
   * Mutates this set in place; the set is internal to the broker and not
   * exposed observably, so wholesale replacement is unnecessary here.
   */
  add(r: Range): void {
    // Merge all intervals that overlap or touch `r` into a single span.
    let lo = r.min;
    let hi = r.max;
    const kept: Range[] = [];
    for (const iv of this.intervals) {
      const overlapsOrTouches = iv.max >= lo - 1 && iv.min <= hi + 1;
      if (overlapsOrTouches) {
        if (iv.min < lo) lo = iv.min;
        if (iv.max > hi) hi = iv.max;
      } else {
        kept.push(iv);
      }
    }
    kept.push(Range.create(lo, hi));
    kept.sort((a, b) => a.min - b.min);
    this.intervals.splice(0, this.intervals.length, ...kept);
  }

  /**
   * Return the sub-ranges of `r` that are NOT covered, ascending.
   * Empty array means `r` is fully covered.
   */
  gaps(r: Range): Range[] {
    const out: Range[] = [];
    let cursor = r.min;
    for (const iv of this.intervals) {
      if (iv.max < cursor) continue;
      if (iv.min > r.max) break;
      if (iv.min > cursor) {
        out.push(Range.create(cursor, Math.min(iv.min, r.max)));
      }
      cursor = Math.max(cursor, iv.max);
      if (cursor >= r.max) break;
    }
    if (cursor < r.max) {
      out.push(Range.create(cursor, r.max));
    }
    return out;
  }
}
