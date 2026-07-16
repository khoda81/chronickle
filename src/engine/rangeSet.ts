/**
 * A set of disjoint, sorted half-open ranges [min, max).
 *
 * Used by the broker to track which time ranges have been fetched (at any
 * resolution) so it can detect gaps and avoid re-issuing in-flight requests.
 *
 * Invariant: `intervals` is ascending by `min`, and consecutive intervals
 * are *non-overlapping and non-touching* (touching ranges are merged on
 * insert). `min < max` for every interval, enforced by `Range.create`.
 */

import { Range } from "./range.ts";

export class RangeSet {
  private readonly intervals: Range[] = [];

  /** Currently covered intervals, ascending. Defensive copy. */
  ranges(): readonly Range[] {
    return this.intervals.slice();
  }

  /**
   * Allocation-free read-only view for internal sweep algorithms. Callers must
   * never retain and mutate the backing array. Individual Range values are
   * immutable, and RangeSet preserves the array identity across updates.
   */
  view(): readonly Range[] {
    return this.intervals;
  }

  /** True if the complete half-open interval `r` is covered. */
  covers(r: Range): boolean {
    let lo = 0;
    let hi = this.intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.intervals[mid]!.min <= r.min) lo = mid + 1;
      else hi = mid;
    }
    const candidate = this.intervals[lo - 1];
    return candidate !== undefined && candidate.max >= r.max;
  }

  /** True when `t` belongs to one of the covered intervals. */
  contains(t: number): boolean {
    let lo = 0;
    let hi = this.intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const iv = this.intervals[mid]!;
      if (t < iv.min) hi = mid - 1;
      else if (t >= iv.max) lo = mid + 1;
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
    let min = r.min;
    let max = r.max;
    const intervals = this.intervals;
    const last = intervals[intervals.length - 1];

    // Coverage producers sweep forward in time. Keep that overwhelmingly
    // common path allocation-free and O(1), rather than rebuilding/sorting the
    // complete set for every accepted signal segment.
    if (last === undefined) {
      intervals.push(r);
      return;
    }
    if (last.max < min) {
      intervals.push(r);
      return;
    }
    if (last.min <= max) {
      // The new range reaches the tail. It can only merge with a suffix, but
      // may bridge several suffix intervals as its bounds expand.
      let start = intervals.length - 1;
      while (start > 0 && intervals[start - 1]!.max >= min) start--;
      for (let index = start; index < intervals.length; index++) {
        const interval = intervals[index]!;
        min = Math.min(min, interval.min);
        max = Math.max(max, interval.max);
      }
      intervals.splice(start, intervals.length - start, Range.create(min, max));
      return;
    }

    // Find the first interval that could overlap or touch the new range.
    let lo = 0;
    let hi = intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (intervals[mid]!.max < min) lo = mid + 1;
      else hi = mid;
    }
    const start = lo;
    if (start === intervals.length || intervals[start]!.min > max) {
      intervals.splice(start, 0, r);
      return;
    }

    let end = start;
    while (end < intervals.length && intervals[end]!.min <= max) {
      const interval = intervals[end]!;
      min = Math.min(min, interval.min);
      max = Math.max(max, interval.max);
      end++;
    }
    intervals.splice(start, end - start, Range.create(min, max));
  }

  /** Remove `r`, splitting existing intervals when necessary. */
  remove(r: Range): void {
    const kept: Range[] = [];
    for (const iv of this.intervals) {
      if (iv.max <= r.min || iv.min >= r.max) {
        kept.push(iv);
        continue;
      }
      if (iv.min < r.min) kept.push(Range.create(iv.min, r.min));
      if (iv.max > r.max) kept.push(Range.create(r.max, iv.max));
    }
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
