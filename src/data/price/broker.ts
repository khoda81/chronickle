/**
 * Resolution-aware price broker.
 *
 * One store is maintained per native source period. Observations are converted
 * to natural-log price at ingestion, preserving precision and making the
 * renderer's derivative operation a subtraction rather than a log ratio.
 * Coverage is tracked independently at each period, so a coarse fetch can
 * never suppress the finer fetch required after zooming in.
 */

import { PriceSeries } from "../../domain.ts";
import { Range } from "../../engine/range.ts";
import { ChunkedLevelStore } from "./store.ts";
import { evaluateStaircase, type StaircaseResult } from "./staircase.ts";
import { CoverageIndex, type ResolutionSegment } from "./coverage.ts";
import type { Fetcher } from "./fetcher.ts";
import { pickResolution } from "./resolution.ts";
import { RangeSet } from "../rangeSet.ts";

export type QueryStatus = "complete" | "partial" | "empty";

export interface QueryResult extends StaircaseResult {
  readonly status: QueryStatus;
  /** Native period requested for the current viewport. */
  readonly targetResolutionMs: number;
  /** Actual ready/pending/failed/empty resolution spans used for diagnostics/UI. */
  readonly resolution: readonly ResolutionSegment[];
  /** Monotonic cache revision; stable across read-only queries. */
  readonly revision: number;
}

export interface QueryOptions {
  /** Ascending evaluation timestamps in epoch milliseconds. */
  readonly evalTime: Float64Array;
  /** Maximum acceptable source period in milliseconds. */
  readonly maxDeltaTMs: number;
}

interface InFlightRequest {
  readonly range: Range;
  readonly resolutionMs: number;
}

interface FailedRequest extends InFlightRequest {
  readonly message: string;
  readonly retryAt: number;
  readonly timer: number;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export class Broker {
  private readonly stores = new Map<number, ChunkedLevelStore>();
  private readonly coverage = new CoverageIndex();
  private readonly subscribers = new Set<() => void>();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly failures = new Map<string, FailedRequest>();
  private readonly failureAttempts = new Map<string, number>();
  private revision = 0;

  constructor(private readonly fetcher: Fetcher) {}

  query(opts: QueryOptions): QueryResult {
    const { evalTime, maxDeltaTMs } = opts;
    const targetResolutionMs = pickResolution(this.fetcher.nativePeriodsMs, maxDeltaTMs);
    const value = new Float64Array(evalTime.length);
    value.fill(NaN);

    if (evalTime.length === 0) {
      return {
        value,
        leadingNaN: 0,
        trailingNaN: 0,
        status: "empty",
        targetResolutionMs,
        resolution: [],
        revision: this.revision,
      };
    }

    const range = Range.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
    const gaps = this.coverage.gaps(targetResolutionMs, range);
    for (const gap of gaps) {
      const blocked = new RangeSet();
      for (const request of this.inFlight.values()) {
        if (request.resolutionMs !== targetResolutionMs) continue;
        const overlap = intersect(request.range, gap);
        if (overlap !== null) blocked.add(overlap);
      }
      for (const failure of this.failures.values()) {
        if (failure.resolutionMs !== targetResolutionMs || failure.retryAt <= Date.now()) continue;
        const overlap = intersect(failure.range, gap);
        if (overlap !== null) blocked.add(overlap);
      }
      for (const requestRange of blocked.gaps(gap)) {
        void this.requestFetch(requestRange, maxDeltaTMs, targetResolutionMs);
      }
    }

    // Prefer the requested level, then progressively finer cached levels. A
    // coarser level is allowed only as a provisional visual fallback while the
    // requested level is loading, and keeps status="partial".
    const available = [...this.stores.keys()];
    available.sort(
      (a, b) => candidateRank(a, targetResolutionMs) - candidateRank(b, targetResolutionMs),
    );

    const usedResolution = new Float64Array(evalTime.length);
    usedResolution.fill(NaN);
    for (const periodMs of available) {
      const store = this.stores.get(periodMs)!;
      const sampled = evaluateStaircase(store.chunks, evalTime).value;
      for (let i = 0; i < evalTime.length; i++) {
        if (Number.isFinite(value[i]!)) continue;
        if (!this.coverage.hasDataAt(periodMs, evalTime[i]!)) continue;
        const v = sampled[i]!;
        if (!Number.isFinite(v)) continue;
        value[i] = v;
        usedResolution[i] = periodMs;
      }
    }

    let finiteCount = 0;
    let leadingNaN = 0;
    while (leadingNaN < value.length && !Number.isFinite(value[leadingNaN]!)) leadingNaN++;
    let trailingNaN = 0;
    while (
      trailingNaN < value.length - leadingNaN &&
      !Number.isFinite(value[value.length - 1 - trailingNaN]!)
    ) {
      trailingNaN++;
    }
    for (const v of value) if (Number.isFinite(v)) finiteCount++;

    const status: QueryStatus =
      finiteCount === 0 ? "empty" : gaps.length === 0 ? "complete" : "partial";
    const resolution = [
      ...readySegments(evalTime, usedResolution),
      ...this.coverage.segments(targetResolutionMs, range).filter((s) => s.state === "empty"),
      ...this.gapSegments(gaps, targetResolutionMs),
    ].sort((a, b) => a.range.min - b.range.min || a.resolutionMs - b.resolutionMs);

    return {
      value,
      leadingNaN,
      trailingNaN,
      status,
      targetResolutionMs,
      resolution,
      revision: this.revision,
    };
  }

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Release retry timers and observers (primarily useful for tests/teardown). */
  dispose(): void {
    for (const failure of this.failures.values()) clearTimeout(failure.timer);
    this.failures.clear();
    this.subscribers.clear();
  }

  cachedRange(): Range | null {
    let min = Infinity;
    let max = -Infinity;
    for (const store of this.stores.values()) {
      const range = store.timeRange();
      if (range === null) continue;
      if (range.min < min) min = range.min;
      if (range.max > max) max = range.max;
    }
    return min < max ? Range.create(min, max) : null;
  }

  private async requestFetch(range: Range, maxDeltaTMs: number, target: number): Promise<void> {
    const key = `${range.min}:${range.max}:${target}`;
    if (this.inFlight.has(key) || this.failures.has(key)) return;
    this.inFlight.set(key, { range, resolutionMs: target });

    try {
      const result = await this.fetcher.fetchRange({ range, maxDeltaTMs });
      if (result.resolutionMs !== target) {
        throw new Error(
          `Broker: fetcher returned ${result.resolutionMs}ms for requested native period ${target}ms`,
        );
      }

      const points = PriceSeries.from(result.points).observations;
      if (points.length > 0) {
        const time = new Float64Array(points.length);
        const logPrice = new Float64Array(points.length);
        for (let i = 0; i < points.length; i++) {
          const p = points[i]!;
          time[i] = p.t;
          logPrice[i] = Math.log(p.price);
        }
        this.store(result.resolutionMs).insertBatch(time, logPrice);
      }
      this.coverage.add(result.resolutionMs, result.coverage);
      this.clearFailures(result.resolutionMs, result.coverage.range);
      this.failureAttempts.delete(key);
      this.revision++;
      this.notify();
    } catch (err) {
      // Keep the range uncovered, but expose the failure and use bounded
      // backoff so a redraw loop cannot hammer an unhealthy API.
      console.error("[Broker] fetch failed for", range, err);
      const attempt = (this.failureAttempts.get(key) ?? 0) + 1;
      this.failureAttempts.set(key, attempt);
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
      const message = err instanceof Error ? err.message : String(err);
      const retryAt = Date.now() + delay;
      const timer = setTimeout(() => {
        const failure = this.failures.get(key);
        if (failure === undefined || failure.retryAt !== retryAt) return;
        this.failures.delete(key);
        this.revision++;
        this.notify();
      }, delay) as unknown as number;
      this.failures.set(key, { range, resolutionMs: target, message, retryAt, timer });
      this.revision++;
      this.notify();
    } finally {
      this.inFlight.delete(key);
    }
  }

  private gapSegments(gaps: readonly Range[], resolutionMs: number): ResolutionSegment[] {
    const out: ResolutionSegment[] = [];
    for (const gap of gaps) {
      const boundaries = [gap.min, gap.max];
      for (const request of this.inFlight.values()) {
        if (request.resolutionMs !== resolutionMs) continue;
        const overlap = intersect(request.range, gap);
        if (overlap !== null) boundaries.push(overlap.min, overlap.max);
      }
      for (const failure of this.failures.values()) {
        if (failure.resolutionMs !== resolutionMs || failure.retryAt <= Date.now()) continue;
        const overlap = intersect(failure.range, gap);
        if (overlap !== null) boundaries.push(overlap.min, overlap.max);
      }
      boundaries.sort((a, b) => a - b);
      for (let i = 0; i + 1 < boundaries.length; i++) {
        const min = boundaries[i]!;
        const max = boundaries[i + 1]!;
        if (!(min < max)) continue;
        const middle = min + (max - min) / 2;
        const failure = [...this.failures.values()].find(
          (entry) =>
            entry.resolutionMs === resolutionMs &&
            entry.retryAt > Date.now() &&
            entry.range.min <= middle &&
            entry.range.max >= middle,
        );
        out.push({
          range: Range.create(min, max),
          resolutionMs,
          state: failure === undefined ? "pending" : "failed",
          ...(failure === undefined ? {} : { message: failure.message }),
        });
      }
    }
    return out;
  }

  private clearFailures(resolutionMs: number, range: Range): void {
    for (const [key, failure] of this.failures) {
      if (failure.resolutionMs !== resolutionMs || intersect(failure.range, range) === null)
        continue;
      clearTimeout(failure.timer);
      this.failures.delete(key);
      this.failureAttempts.delete(key);
    }
  }

  private store(resolutionMs: number): ChunkedLevelStore {
    let store = this.stores.get(resolutionMs);
    if (store === undefined) {
      store = new ChunkedLevelStore();
      this.stores.set(resolutionMs, store);
    }
    return store;
  }

  private notify(): void {
    for (const fn of this.subscribers) fn();
  }
}

function intersect(a: Range, b: Range): Range | null {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min < max ? Range.create(min, max) : null;
}

function candidateRank(periodMs: number, targetMs: number): number {
  if (periodMs === targetMs) return 0;
  if (periodMs < targetMs) return 1 + (targetMs - periodMs) / targetMs;
  return 10 + (periodMs - targetMs) / targetMs;
}

function readySegments(evalTime: Float64Array, usedResolution: Float64Array): ResolutionSegment[] {
  const out: ResolutionSegment[] = [];
  let i = 0;
  while (i < usedResolution.length) {
    const resolutionMs = usedResolution[i]!;
    if (!Number.isFinite(resolutionMs)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < usedResolution.length && usedResolution[end] === resolutionMs) end++;
    const min = evalTime[i]!;
    const max = end < evalTime.length ? evalTime[end]! : evalTime[end - 1]!;
    if (min < max) {
      out.push({ range: Range.create(min, max), resolutionMs, state: "ready" });
    }
    i = end;
  }
  return out;
}
