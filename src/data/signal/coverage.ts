import { Interval, IntervalSet } from "../../core/interval.ts";

interface CoverageSegmentBase {
  readonly range: Interval;
  readonly samplePeriodMs: number;
}

export type CoverageSegment =
  | (CoverageSegmentBase & {
      readonly kind: "data";
      /** `held` carries an older observation beyond its expected native lifetime. */
      readonly state: "ready" | "held" | "empty";
    })
  | (CoverageSegmentBase & { readonly kind: "request"; readonly state: "pending" })
  | (CoverageSegmentBase & {
      readonly kind: "request";
      readonly state: "fetching";
      readonly attempt: number;
    })
  | (CoverageSegmentBase & {
      readonly kind: "request";
      readonly state: "retrying";
      readonly attempt: number;
      readonly message: string;
      readonly retryAtMs: number;
    });

export type CoverageState = CoverageSegment["state"];

/** Request-quality-local evidence that an adapter definitively searched a range. */
export class SettledCoverageIndex {
  private readonly fetched = new Map<number, IntervalSet>();

  clear(): void {
    this.fetched.clear();
  }

  add(requestResolutionMs: number, range: Interval): void {
    this.level(requestResolutionMs).add(range);
  }

  addBlockers(out: IntervalSet, requestResolutionMs: number, range: Interval): void {
    // A finer completed search is also valid evidence for a coarser viewport.
    // Exact floating-point zoom resolutions must not create distinct islands.
    for (const [evidenceResolutionMs, ranges] of this.fetched) {
      if (evidenceResolutionMs > requestResolutionMs) continue;
      for (const overlap of ranges.intersections(range)) out.add(overlap);
    }
  }

  /** Completed search ranges not already supported by ready sample data. */
  emptySegments(
    range: Interval,
    requestResolutionMs: number,
    ready: IntervalSet,
  ): CoverageSegment[] {
    const fetched = new IntervalSet();
    this.addBlockers(fetched, requestResolutionMs, range);
    const out: CoverageSegment[] = [];
    for (const searched of fetched.intersections(range)) {
      for (const gap of ready.gaps(searched)) {
        out.push({ kind: "data", range: gap, samplePeriodMs: requestResolutionMs, state: "empty" });
      }
    }
    return out;
  }

  private level(resolutionMs: number): IntervalSet {
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`FetchedCoverageIndex: invalid resolution ${resolutionMs}`);
    }
    let ranges = this.fetched.get(resolutionMs);
    if (ranges === undefined) {
      ranges = new IntervalSet();
      this.fetched.set(resolutionMs, ranges);
    }
    return ranges;
  }
}
