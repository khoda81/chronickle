import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";

export type CoverageState = "ready" | "empty" | "pending" | "watching" | "failed";

export interface ResolutionSegment {
  readonly range: Range;
  readonly resolutionMs: number;
  readonly state: CoverageState;
  readonly message?: string;
  readonly retryAtMs?: number;
}

/** Request-quality-local evidence that an adapter definitively searched a range. */
export class FetchedCoverageIndex {
  private readonly fetched = new Map<number, RangeSet>();

  clear(): void {
    this.fetched.clear();
  }

  add(requestResolutionMs: number, range: Range): void {
    this.level(requestResolutionMs).add(range);
  }

  answers(range: Range, requestResolutionMs: number): boolean {
    const covered = new RangeSet();
    this.addBlockers(covered, requestResolutionMs, range);
    return covered.covers(range);
  }

  addBlockers(out: RangeSet, requestResolutionMs: number, range: Range): void {
    // A finer completed search is also valid evidence for a coarser viewport.
    // Exact floating-point zoom resolutions must not create distinct islands.
    for (const [evidenceResolutionMs, ranges] of this.fetched) {
      if (evidenceResolutionMs > requestResolutionMs) continue;
      for (const overlap of ranges.intersections(range)) out.add(overlap);
    }
  }

  /** Completed search ranges not already supported by ready sample data. */
  emptySegments(range: Range, requestResolutionMs: number, ready: RangeSet): ResolutionSegment[] {
    const fetched = new RangeSet();
    this.addBlockers(fetched, requestResolutionMs, range);
    const out: ResolutionSegment[] = [];
    for (const searched of fetched.intersections(range)) {
      for (const gap of ready.gaps(searched)) {
        out.push({ range: gap, resolutionMs: requestResolutionMs, state: "empty" });
      }
    }
    return out;
  }

  private level(resolutionMs: number): RangeSet {
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`FetchedCoverageIndex: invalid resolution ${resolutionMs}`);
    }
    let ranges = this.fetched.get(resolutionMs);
    if (ranges === undefined) {
      ranges = new RangeSet();
      this.fetched.set(resolutionMs, ranges);
    }
    return ranges;
  }
}
