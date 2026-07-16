/**
 * A finite half-open numeric interval `[start, end)`.
 *
 * Invariants:
 * - both bounds are finite;
 * - `start <= end`;
 * - `start === end` represents an empty interval.
 *
 * Construction normalizes an inverted end to `start`, matching the useful
 * semantics of Rust ranges: `10..5` is empty rather than reversed.
 */
declare const intervalBrand: unique symbol;

export interface Interval {
  readonly start: number;
  readonly end: number;
  /** Nominal marker: only this module can construct a validated Interval. */
  readonly [intervalBrand]: true;
}

export const Interval = {
  create(start: number, requestedEnd: number): Interval {
    if (!Number.isFinite(start) || !Number.isFinite(requestedEnd)) {
      throw new Error(`Interval bounds must be finite: ${start}..${requestedEnd}`);
    }
    return { start, end: Math.max(start, requestedEnd) } as Interval;
  },

  empty(at: number): Interval {
    return this.create(at, at);
  },

  isEmpty(interval: Interval): boolean {
    return interval.start === interval.end;
  },

  span(interval: Interval): number {
    return interval.end - interval.start;
  },

  contains(interval: Interval, value: number): boolean {
    return value >= interval.start && value < interval.end;
  },

  pan(interval: Interval, delta: number): Interval {
    if (!Number.isFinite(delta)) throw new Error(`Pan delta must be finite: ${delta}`);
    return this.create(interval.start + delta, interval.end + delta);
  },

  zoom(interval: Interval, focus: number, factor: number): Interval {
    if (!(factor > 0) || !Number.isFinite(factor)) {
      throw new Error(`Zoom factor must be finite and positive: ${factor}`);
    }
    if (this.isEmpty(interval)) return interval;

    const span = this.span(interval);
    const leftRatio = (focus - interval.start) / span;
    const nextSpan = span / factor;
    const start = focus - leftRatio * nextSpan;
    return this.create(start, start + nextSpan);
  },

  fit(interval: Interval, padRatio = 0.05): Interval {
    if (!(padRatio >= 0) || !Number.isFinite(padRatio)) {
      throw new Error(`Padding ratio must be finite and non-negative: ${padRatio}`);
    }
    if (this.isEmpty(interval)) return interval;

    const pad = this.span(interval) * padRatio;
    return this.create(interval.start - pad, interval.end + pad);
  },

  intersection(a: Interval, b: Interval): Interval {
    const start = Math.max(a.start, b.start);
    return this.create(start, Math.min(a.end, b.end));
  },
} as const;

/**
 * A sorted set of non-empty, disjoint, non-touching half-open intervals.
 * Touching intervals are merged on insertion.
 */
export class IntervalSet {
  private readonly items: Interval[] = [];

  /** Currently covered intervals, ascending. Defensive copy. */
  intervals(): readonly Interval[] {
    return this.items.slice();
  }

  /** Allocation-free internal view. Callers must not mutate or retain it. */
  view(): readonly Interval[] {
    return this.items;
  }

  /** True if the complete interval is covered. Empty intervals are covered. */
  covers(interval: Interval): boolean {
    if (Interval.isEmpty(interval)) return true;

    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.items[mid]!.start <= interval.start) lo = mid + 1;
      else hi = mid;
    }
    const candidate = this.items[lo - 1];
    return candidate !== undefined && candidate.end >= interval.end;
  }

  contains(value: number): boolean {
    let lo = 0;
    let hi = this.items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const interval = this.items[mid]!;
      if (value < interval.start) hi = mid - 1;
      else if (value >= interval.end) lo = mid + 1;
      else return true;
    }
    return false;
  }

  intersections(target: Interval): readonly Interval[] {
    if (Interval.isEmpty(target)) return [];

    const out: Interval[] = [];
    for (const interval of this.items) {
      if (interval.end <= target.start) continue;
      if (interval.start >= target.end) break;
      const overlap = Interval.intersection(interval, target);
      if (!Interval.isEmpty(overlap)) out.push(overlap);
    }
    return out;
  }

  add(interval: Interval): void {
    if (Interval.isEmpty(interval)) return;

    let start = interval.start;
    let end = interval.end;
    const intervals = this.items;
    const last = intervals[intervals.length - 1];

    if (last === undefined) {
      intervals.push(interval);
      return;
    }
    if (last.end < start) {
      intervals.push(interval);
      return;
    }
    if (last.start <= end) {
      let mergeStart = intervals.length - 1;
      while (mergeStart > 0 && intervals[mergeStart - 1]!.end >= start) mergeStart--;
      for (let index = mergeStart; index < intervals.length; index++) {
        const current = intervals[index]!;
        start = Math.min(start, current.start);
        end = Math.max(end, current.end);
      }
      intervals.splice(mergeStart, intervals.length - mergeStart, Interval.create(start, end));
      return;
    }

    let lo = 0;
    let hi = intervals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (intervals[mid]!.end < start) lo = mid + 1;
      else hi = mid;
    }
    const insertAt = lo;
    if (insertAt === intervals.length || intervals[insertAt]!.start > end) {
      intervals.splice(insertAt, 0, interval);
      return;
    }

    let mergeEnd = insertAt;
    while (mergeEnd < intervals.length && intervals[mergeEnd]!.start <= end) {
      const current = intervals[mergeEnd]!;
      start = Math.min(start, current.start);
      end = Math.max(end, current.end);
      mergeEnd++;
    }
    intervals.splice(insertAt, mergeEnd - insertAt, Interval.create(start, end));
  }

  remove(target: Interval): void {
    if (Interval.isEmpty(target)) return;

    const kept: Interval[] = [];
    for (const interval of this.items) {
      if (interval.end <= target.start || interval.start >= target.end) {
        kept.push(interval);
        continue;
      }
      if (interval.start < target.start) {
        kept.push(Interval.create(interval.start, target.start));
      }
      if (interval.end > target.end) {
        kept.push(Interval.create(target.end, interval.end));
      }
    }
    this.items.splice(0, this.items.length, ...kept);
  }

  gaps(target: Interval): Interval[] {
    if (Interval.isEmpty(target)) return [];

    const out: Interval[] = [];
    let cursor = target.start;
    for (const interval of this.items) {
      if (interval.end <= cursor) continue;
      if (interval.start >= target.end) break;
      if (interval.start > cursor) {
        out.push(Interval.create(cursor, Math.min(interval.start, target.end)));
      }
      cursor = Math.max(cursor, interval.end);
      if (cursor >= target.end) break;
    }
    if (cursor < target.end) out.push(Interval.create(cursor, target.end));
    return out;
  }
}
