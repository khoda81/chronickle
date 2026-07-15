import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";

export type CoverageState = "ready" | "empty" | "pending" | "failed";

export interface ResolutionSegment {
  readonly range: Range;
  readonly resolutionMs: number;
  readonly state: CoverageState;
  readonly message?: string;
}

/** Request-quality-local evidence that a remote lookup searched but found no data. */
export class EmptyCoverageIndex {
  private readonly empty = new Map<number, RangeSet>();

  clear(): void {
    this.empty.clear();
  }

  add(requestResolutionMs: number, range: Range): void {
    this.level(requestResolutionMs).add(range);
  }

  /** Finer ready evidence invalidates overlapping empty evidence for coarser requests. */
  removeSatisfied(readyResolutionMs: number, range: Range): void {
    for (const [requestResolutionMs, empty] of this.empty) {
      if (readyResolutionMs <= requestResolutionMs) empty.remove(range);
    }
  }

  answers(range: Range, requestResolutionMs: number): boolean {
    const covered = new RangeSet();
    this.addBlockers(covered, requestResolutionMs, range);
    return covered.covers(range);
  }

  addBlockers(out: RangeSet, requestResolutionMs: number, range: Range): void {
    // A finer search that found no observations is also valid evidence for a
    // coarser viewport. Exact floating-point zoom resolutions must not create
    // distinct islands of otherwise identical empty coverage.
    for (const [evidenceResolutionMs, ranges] of this.empty) {
      if (evidenceResolutionMs > requestResolutionMs) continue;
      for (const overlap of ranges.intersections(range)) out.add(overlap);
    }
  }

  segments(range: Range, requestResolutionMs: number): ResolutionSegment[] {
    const covered = new RangeSet();
    this.addBlockers(covered, requestResolutionMs, range);
    return covered.intersections(range).map((overlap) => ({
      range: overlap,
      resolutionMs: requestResolutionMs,
      state: "empty" as const,
    }));
  }

  private level(resolutionMs: number): RangeSet {
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`EmptyCoverageIndex: invalid resolution ${resolutionMs}`);
    }
    let ranges = this.empty.get(resolutionMs);
    if (ranges === undefined) {
      ranges = new RangeSet();
      this.empty.set(resolutionMs, ranges);
    }
    return ranges;
  }
}
