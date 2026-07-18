import { Interval } from "../../core/interval.ts";

export type SignalReportKind = "info" | "warn" | "error";

/** Optional adapter commentary. Reports never affect acquisition or cached data. */
export interface SignalReport {
  readonly range: Interval;
  readonly kind: SignalReportKind;
  readonly message: string;
}

export interface SignalReportFragment {
  readonly range: Interval;
  readonly report: SignalReport;
}

/**
 * Resolve reports into a non-overlapping visible frontier. Reports are painted
 * in snapshot order, so a later entry wins wherever intervals overlap.
 */
export function signalReportFrontier(
  reports: readonly SignalReport[],
  visibleRange: Interval,
): readonly SignalReportFragment[] {
  const candidates = reports.flatMap((report, index) => {
    const range = Interval.intersection(report.range, visibleRange);
    return Interval.isEmpty(range) ? [] : [{ report, range, index }];
  });
  if (candidates.length === 0) return [];

  const boundaries = [
    ...new Set(candidates.flatMap(candidate => [candidate.range.start, candidate.range.end])),
  ].sort((a, b) => a - b);
  const fragments: { range: Interval; report: SignalReport; index: number }[] = [];

  for (let boundary = 1; boundary < boundaries.length; boundary++) {
    const range = Interval.create(boundaries[boundary - 1]!, boundaries[boundary]!);
    let winner: (typeof candidates)[number] | undefined;
    for (const candidate of candidates) {
      if (!Interval.overlaps(candidate.range, range)) continue;
      if (winner === undefined || candidate.index > winner.index) {
        winner = candidate;
      }
    }
    if (winner === undefined) continue;

    const previous = fragments[fragments.length - 1];
    if (previous?.index === winner.index && previous.range.end === range.start) {
      previous.range = Interval.create(previous.range.start, range.end);
    } else {
      fragments.push({ range, report: winner.report, index: winner.index });
    }
  }

  return fragments;
}

export function sameSignalReports(a: readonly SignalReport[], b: readonly SignalReport[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (report, index) =>
        report.kind === b[index]!.kind &&
        report.message === b[index]!.message &&
        Interval.equals(report.range, b[index]!.range),
    )
  );
}
