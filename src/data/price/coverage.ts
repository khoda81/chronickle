import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";
import type { FetchCoverage } from "./fetcher.ts";

export type CoverageState = "ready" | "empty" | "loading";

export interface ResolutionSegment {
  readonly range: Range;
  readonly resolutionMs: number;
  readonly state: CoverageState;
}

interface CoverageLevel {
  readonly known: RangeSet;
  readonly data: RangeSet;
  readonly empty: RangeSet;
}

/**
 * Resolution-aware source coverage.
 *
 * Coverage is deliberately kept separate from observations: a last price can
 * be held only where the source has answered the request, while a known-empty
 * market interval must not be retried indefinitely.
 */
export class CoverageIndex {
  private readonly levels = new Map<number, CoverageLevel>();

  add(resolutionMs: number, coverage: FetchCoverage): void {
    const level = this.level(resolutionMs);
    level.known.add(coverage.range);
    if (coverage.kind === "empty") level.empty.add(coverage.range);
    else level.data.add(coverage.range);
  }

  gaps(resolutionMs: number, range: Range): readonly Range[] {
    return this.level(resolutionMs).known.gaps(range);
  }

  hasDataAt(resolutionMs: number, t: number): boolean {
    return this.levels.get(resolutionMs)?.data.contains(t) ?? false;
  }

  dataRanges(resolutionMs: number): readonly Range[] {
    return this.levels.get(resolutionMs)?.data.ranges() ?? [];
  }

  segments(resolutionMs: number, range: Range): readonly ResolutionSegment[] {
    const level = this.levels.get(resolutionMs);
    if (level === undefined) return [];
    const out: ResolutionSegment[] = [];
    for (const r of level.data.intersections(range)) {
      out.push({ range: r, resolutionMs, state: "ready" });
    }
    for (const r of level.empty.intersections(range)) {
      out.push({ range: r, resolutionMs, state: "empty" });
    }
    out.sort((a, b) => a.range.min - b.range.min);
    return out;
  }

  private level(resolutionMs: number): CoverageLevel {
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`CoverageIndex: invalid resolution ${resolutionMs}`);
    }
    let level = this.levels.get(resolutionMs);
    if (level === undefined) {
      level = { known: new RangeSet(), data: new RangeSet(), empty: new RangeSet() };
      this.levels.set(resolutionMs, level);
    }
    return level;
  }
}
