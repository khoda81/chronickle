/** Public signal-adapter contracts and stateless helpers for regular sources. */

import { Interval, IntervalSet } from "../../core/interval.ts";
import type { SignalReport } from "./reports.ts";
import type { Sample } from "./sample.ts";

/** Regular query geometry. Each adapter decides how, or whether, to satisfy it. */
export interface SignalDemand {
  readonly range: Interval;
  readonly sampleCount: number;
}

export interface ResolvedSignalDemand {
  readonly range: Interval;
  readonly resolutionMs: number;
}

export interface SignalSink {
  next(samples: readonly Sample[]): void;
  /** Replace the adapter's current diagnostic report snapshot. */
  setReports(reports: readonly SignalReport[]): void;
  error(error: unknown): void;
}

/** One long-lived acquisition session per broker/source. */
export interface AdapterSession {
  setDemands(demands: readonly SignalDemand[]): void;
  clearCache(): void;
}

/**
 * The broker describes current interest. The adapter owns every decision about
 * requests, computation, coverage, cancellation, retries, and live transports.
 */
export interface SignalAdapter {
  connect(sink: SignalSink, signal: AbortSignal): AdapterSession;
}

export function demandSampleSpacingMs(demand: SignalDemand): number {
  return Interval.span(demand.range) / (demand.sampleCount - 1);
}

/** Resolve and de-duplicate a complete demand snapshot, finest and newest first. */
export function resolveSignalDemands(
  demands: readonly SignalDemand[],
  resolve: (demand: SignalDemand) => number,
): readonly ResolvedSignalDemand[] {
  const plans = demands.map(demand => {
    if (Interval.isEmpty(demand.range)) throw new Error("SignalAdapter: empty demand range");
    if (!Number.isInteger(demand.sampleCount) || demand.sampleCount < 2) {
      throw new Error(`SignalAdapter: invalid demand sample count ${demand.sampleCount}`);
    }
    const resolutionMs = resolve(demand);
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`SignalAdapter: invalid native resolution ${resolutionMs}`);
    }
    return { range: demand.range, resolutionMs };
  });

  plans.sort(
    (a, b) =>
      a.resolutionMs - b.resolutionMs || b.range.end - a.range.end || b.range.start - a.range.start,
  );
  return plans.filter(
    (plan, index) =>
      index === 0 ||
      plan.resolutionMs !== plans[index - 1]!.resolutionMs ||
      !Interval.equals(plan.range, plans[index - 1]!.range),
  );
}

/**
 * Return gaps not covered at the requested quality. The coverage map belongs
 * to the calling adapter; this helper neither retains nor interprets it.
 */
export function resolutionGaps(
  coverage: ReadonlyMap<number, IntervalSet>,
  resolutionMs: number,
  target: Interval,
  extraBlockers: readonly Interval[] = [],
): Interval[] {
  const blockers = new IntervalSet();
  for (const [availableResolutionMs, ranges] of coverage) {
    if (availableResolutionMs > resolutionMs) continue;
    for (const overlap of ranges.intersections(target)) blockers.add(overlap);
  }
  for (const interval of extraBlockers) blockers.add(Interval.intersection(interval, target));
  return blockers.gaps(target);
}

/** Expand and align a source request without retaining any scheduling state. */
export function expandSignalRequest(
  required: Interval,
  resolutionMs: number,
  wallNow: number,
  minFetchPoints: number,
): Interval {
  const minSpan = minFetchPoints * resolutionMs;
  let start = Math.floor(required.start / resolutionMs) * resolutionMs;
  let end = Math.min(wallNow, Math.ceil(required.end / resolutionMs) * resolutionMs);
  if (!(start < end)) end = Math.min(wallNow, Math.max(required.end, start + resolutionMs));

  if (end - start < minSpan) {
    if (required.end >= wallNow - 2 * resolutionMs) {
      start = end - minSpan;
    } else {
      const missing = minSpan - (end - start);
      start -= Math.ceil(missing / 2 / resolutionMs) * resolutionMs;
      end = Math.min(wallNow, start + minSpan);
      if (end < required.end) {
        end = required.end;
        start = end - minSpan;
      }
    }
  }

  return Interval.create(start, end);
}

export function signalWorkIsWanted(
  demands: readonly ResolvedSignalDemand[],
  requiredRange: Interval,
  resolutionMs: number,
): boolean {
  return demands.some(
    demand => demand.resolutionMs >= resolutionMs && Interval.overlaps(demand.range, requiredRange),
  );
}

export function nextSignalFutureStart(
  demands: readonly ResolvedSignalDemand[],
  wallNow: number,
): number | null {
  let next: number | null = null;
  for (const demand of demands) {
    if (demand.range.start <= wallNow) continue;
    next = next === null ? demand.range.start : Math.min(next, demand.range.start);
  }
  return next;
}

export function signalPollDelay(resolutionMs: number): number {
  return Math.min(30_000, Math.max(1_000, resolutionMs / 10));
}
