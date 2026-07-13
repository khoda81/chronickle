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

  addReady(resolutionMs: number, range: Range): void {
    this.level(this.ready, resolutionMs).add(range);
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
