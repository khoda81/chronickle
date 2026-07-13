import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";

export type CoverageState = "ready" | "empty" | "pending" | "failed";

export interface ResolutionSegment {
  readonly range: Range;
  readonly resolutionMs: number;
  readonly state: CoverageState;
  readonly message?: string;
}

/**
 * Evidence-backed coverage indexed by observed spacing.
 *
 * Ready ranges come only from adjacent stored observations (plus the expected
 * lifetime of the last observation). Empty ranges are request-quality-local:
 * an empty 5-minute lookup does not say anything about a 1-minute lookup and
 * never dominates another resolution.
 */
export class CoverageIndex {
  private readonly ready = new Map<number, RangeSet>();
  private readonly empty = new Map<number, RangeSet>();
  private sortedReady: readonly (readonly [number, RangeSet])[] | null = null;

  clear(): void {
    this.ready.clear();
    this.empty.clear();
    this.sortedReady = null;
  }

  addReady(resolutionMs: number, range: Range): void {
    this.readyLevel(resolutionMs).add(range);
    // New observations supersede older request-local empty evidence whenever
    // they are at least as fine as that request required.
    for (const [requestResolutionMs, empty] of this.empty) {
      if (resolutionMs <= requestResolutionMs) empty.remove(range);
    }
  }

  addEmpty(requestResolutionMs: number, range: Range): void {
    this.level(this.empty, requestResolutionMs).add(range);
  }

  /** Add every ready interval acceptable for `maxResolutionMs` to `out`. */
  addReadyBlockers(out: RangeSet, maxResolutionMs: number, range: Range): void {
    for (const [resolutionMs, ranges] of this.ready) {
      if (resolutionMs > maxResolutionMs) continue;
      for (const overlap of ranges.intersections(range)) out.add(overlap);
    }
  }

  /** Empty evidence blocks only an equivalent request quality. */
  addEmptyBlockers(out: RangeSet, requestResolutionMs: number, range: Range): void {
    const ranges = this.empty.get(requestResolutionMs);
    if (ranges === undefined) return;
    for (const overlap of ranges.intersections(range)) out.add(overlap);
  }

  /**
   * Resolve one source resolution per evaluation time without performing a
   * range lookup for every (pixel × level) pair.
   *
   * The first pass writes the finest acceptable ready level. The second pass
   * fills only still-unresolved points from the closest coarser levels. This is
   * exactly equivalent to `finestReadyAt() ?? closestCoarserAt()`, but sweeps
   * each covered interval over the sorted evaluation grid.
   */
  resolve(evalTime: Float64Array, maxResolutionMs: number, reuse?: Float64Array): Float64Array {
    if (!(maxResolutionMs > 0) || !Number.isFinite(maxResolutionMs)) {
      throw new Error(`CoverageIndex.resolve: invalid resolution ${maxResolutionMs}`);
    }
    const out = reuse?.length === evalTime.length ? reuse : new Float64Array(evalTime.length);
    out.fill(NaN);
    if (evalTime.length === 0) return out;

    let unresolved = evalTime.length;
    const levels = this.readyLevels();

    // Finest acceptable observation wins.
    for (const [resolutionMs, ranges] of levels) {
      if (resolutionMs > maxResolutionMs) break;
      unresolved -= fillUnresolved(evalTime, out, ranges, resolutionMs);
      if (unresolved === 0) return out;
    }

    // Otherwise use the closest coarser observation available at that time.
    for (const [resolutionMs, ranges] of levels) {
      if (resolutionMs <= maxResolutionMs) continue;
      unresolved -= fillUnresolved(evalTime, out, ranges, resolutionMs);
      if (unresolved === 0) break;
    }
    return out;
  }

  /** True when one ready level or exact-quality empty level covers all of `range`. */
  answers(range: Range, requestResolutionMs: number): boolean {
    for (const [resolutionMs, ranges] of this.readyLevels()) {
      if (resolutionMs > requestResolutionMs) break;
      if (ranges.covers(range)) return true;
    }
    return this.empty.get(requestResolutionMs)?.covers(range) ?? false;
  }

  /** Finest observed ready resolution at `t`, optionally bounded by quality. */
  finestReadyAt(t: number, maxResolutionMs = Infinity): number | null {
    let best = Infinity;
    for (const [resolutionMs, ranges] of this.ready) {
      if (resolutionMs <= maxResolutionMs && resolutionMs < best && ranges.contains(t)) {
        best = resolutionMs;
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  /** Closest coarser fallback when the requested quality is not ready. */
  closestCoarserAt(t: number, minResolutionMs: number): number | null {
    let best = Infinity;
    for (const [resolutionMs, ranges] of this.ready) {
      if (resolutionMs > minResolutionMs && resolutionMs < best && ranges.contains(t)) {
        best = resolutionMs;
      }
    }
    return Number.isFinite(best) ? best : null;
  }

  segments(range: Range, requestResolutionMs: number): ResolutionSegment[] {
    const out: ResolutionSegment[] = [];
    for (const [resolutionMs, ranges] of this.ready) {
      for (const overlap of ranges.intersections(range)) {
        out.push({ range: overlap, resolutionMs, state: "ready" });
      }
    }
    const empty = this.empty.get(requestResolutionMs);
    if (empty !== undefined) {
      for (const overlap of empty.intersections(range)) {
        out.push({ range: overlap, resolutionMs: requestResolutionMs, state: "empty" });
      }
    }
    return out;
  }

  private readyLevel(resolutionMs: number): RangeSet {
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`CoverageIndex: invalid resolution ${resolutionMs}`);
    }
    let ranges = this.ready.get(resolutionMs);
    if (ranges !== undefined) return ranges;
    ranges = new RangeSet();
    this.ready.set(resolutionMs, ranges);
    this.sortedReady = null;
    return ranges;
  }

  private readyLevels(): readonly (readonly [number, RangeSet])[] {
    let levels = this.sortedReady;
    if (levels !== null) return levels;
    levels = [...this.ready.entries()].sort((a, b) => a[0] - b[0]);
    this.sortedReady = levels;
    return levels;
  }

  private level(levels: Map<number, RangeSet>, resolutionMs: number): RangeSet {
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`CoverageIndex: invalid resolution ${resolutionMs}`);
    }
    let ranges = levels.get(resolutionMs);
    if (ranges === undefined) {
      ranges = new RangeSet();
      levels.set(resolutionMs, ranges);
    }
    return ranges;
  }
}

/** Fill unresolved eval points covered by `ranges`; return the number written. */
function fillUnresolved(
  evalTime: Float64Array,
  out: Float64Array,
  ranges: RangeSet,
  resolutionMs: number,
): number {
  const firstTime = evalTime[0]!;
  const lastTime = evalTime[evalTime.length - 1]!;
  let written = 0;
  for (const range of ranges.view()) {
    if (range.max < firstTime) continue;
    if (range.min > lastTime) break;
    const start = lowerBound(evalTime, range.min);
    const end = upperBound(evalTime, range.max);
    for (let index = start; index < end; index++) {
      if (!Number.isNaN(out[index]!)) continue;
      out[index] = resolutionMs;
      written++;
    }
  }
  return written;
}

function lowerBound(values: Float64Array, target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(values: Float64Array, target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
