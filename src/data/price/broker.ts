/** Evidence-backed, resolution-aware price broker. */

import { PriceSeries, type PricePoint } from "../../domain.ts";
import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";
import { FetchedCoverageIndex, type ResolutionSegment } from "./coverage.ts";
import type { AdapterActivity, AdapterDelivery, AdapterSession, PriceAdapter } from "./fetcher.ts";
import { PriceSpanStore, type PriceSpanInput } from "./store.ts";

export type QueryStatus = "complete" | "partial" | "empty";

export interface QueryResult {
  readonly value: Float64Array;
  readonly leadingNaN: number;
  readonly trailingNaN: number;
  readonly status: QueryStatus;
  /** Renderer-requested maximum sample spacing. */
  readonly targetResolutionMs: number;
  readonly resolution: readonly ResolutionSegment[];
  readonly revision: number;
}

export interface QueryOptions {
  readonly evalTime: Float64Array;
  readonly maxDeltaTMs: number;
}

/** Fetch/cache demand independent of a particular sampling grid. */
export interface BrokerDemand {
  readonly range: Range;
  readonly maxDeltaTMs: number;
}

/** Mutable viewport interest. Updating it does not allocate a new subscription. */
export interface BrokerSubscription {
  update(demand: BrokerDemand): void;
  dispose(): void;
}

export interface BrokerOptions {
  /** Injectable wall clock for deterministic tests. */
  readonly now?: () => number;
  readonly onError?: (message: string, error?: unknown) => void;
  readonly onWarning?: (message: string) => void;
}

interface DemandSubscription {
  demand: BrokerDemand;
  readonly fn: () => void;
  disposed: boolean;
}

export class Broker {
  private readonly store = new PriceSpanStore();
  private readonly fetchedCoverage = new FetchedCoverageIndex();
  private readonly demandSubscriptions = new Set<DemandSubscription>();
  private readonly adapterSession: AdapterSession;
  private readonly now: () => number;
  private readonly onError: (message: string, error?: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private revision = 0;
  private adapterActivities: readonly AdapterActivity[] = [];
  private valueBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private resolutionBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);

  constructor(adapter: PriceAdapter, opts: BrokerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? ((message, error) => console.error(message, error));
    this.onWarning = opts.onWarning ?? ((message) => console.warn(message));
    this.adapterSession = adapter.connect({
      next: (batch) => {
        this.ingest(batch);
        this.revision++;
        this.notify();
      },
      status: (activities) => {
        this.adapterActivities = activities;
        this.revision++;
        this.notify();
      },
      error: (error, activity) => {
        this.onError(
          `[Broker] adapter failed for ${activity.range.min}..${activity.range.max}; retry scheduled`,
          error,
        );
      },
    });
  }

  /**
   * Read currently cached data. This method is deliberately side-effect-free:
   * it never starts requests or changes broker demand.
   */
  read(opts: QueryOptions): QueryResult {
    const { evalTime, maxDeltaTMs } = opts;
    if (!(maxDeltaTMs > 0) || !Number.isFinite(maxDeltaTMs)) {
      throw new Error(`Broker.read: invalid maxDeltaTMs ${maxDeltaTMs}`);
    }

    if (evalTime.length < 2) {
      const value =
        this.valueBuffer.length === evalTime.length
          ? this.valueBuffer
          : (this.valueBuffer = new Float64Array(evalTime.length));
      value.fill(NaN);
      return {
        value,
        leadingNaN: evalTime.length,
        trailingNaN: 0,
        status: "empty",
        targetResolutionMs: maxDeltaTMs,
        resolution: [],
        revision: this.revision,
      };
    }

    const queryRange = Range.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
    const wallNow = this.now();
    const historicalRange = clampToNow(queryRange, wallNow);
    const sampled = this.store.sample(evalTime, wallNow, this.valueBuffer, this.resolutionBuffer);
    this.valueBuffer = sampled.value;
    this.resolutionBuffer = sampled.resolutionMs;
    const value = sampled.value;

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
    for (let index = 0; index < value.length; index++) {
      if (Number.isFinite(value[index]!)) finiteCount++;
    }

    const resolved = historicalRange === null || this.isResolved(historicalRange, maxDeltaTMs);
    const status: QueryStatus = finiteCount === 0 ? "empty" : resolved ? "complete" : "partial";
    const readyCoverage = new RangeSet();
    if (historicalRange !== null) {
      this.store.addReadyBlockers(readyCoverage, maxDeltaTMs, historicalRange);
    }
    const resolution =
      historicalRange === null
        ? []
        : [
            ...this.readySegments(evalTime, wallNow),
            ...this.fetchedCoverage.emptySegments(historicalRange, maxDeltaTMs, readyCoverage),
            ...this.transientSegments(historicalRange),
          ].sort(
            (a, b) =>
              a.range.min - b.range.min ||
              coverageLabelRank(b.state) - coverageLabelRank(a.state) ||
              a.range.max - b.range.max,
          );

    return {
      value,
      leadingNaN,
      trailingNaN,
      status,
      targetResolutionMs: maxDeltaTMs,
      resolution,
      revision: this.revision,
    };
  }

  subscribe(demand: BrokerDemand, fn: () => void): BrokerSubscription {
    const entry: DemandSubscription = {
      demand: validateDemand(demand),
      fn,
      disposed: false,
    };
    this.demandSubscriptions.add(entry);
    this.syncAdapterDemands();
    return {
      update: (demand) => {
        if (entry.disposed) throw new Error("Broker subscription is disposed");
        const next = validateDemand(demand);
        if (sameDemand(entry.demand, next)) return;
        entry.demand = next;
        this.syncAdapterDemands();
      },
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        this.demandSubscriptions.delete(entry);
        this.syncAdapterDemands();
      },
    };
  }

  dispose(): void {
    this.adapterSession.dispose();
    this.demandSubscriptions.clear();
  }

  /** Drop observations and adapter scheduling evidence, then reacquire current demands. */
  clearCache(): void {
    this.store.clear();
    this.fetchedCoverage.clear();
    this.adapterActivities = [];
    this.valueBuffer = new Float64Array(0);
    this.resolutionBuffer = new Float64Array(0);
    this.adapterSession.clearCache();
    this.revision++;
    this.notify();
  }

  cachedRange(): Range | null {
    return this.store.timeRange();
  }

  /** Latest cached log price at or before `time`, clamped to the live wall clock. */
  logPriceAtOrBefore(time: number): number | null {
    if (!Number.isFinite(time)) {
      throw new Error(`Broker.logPriceAtOrBefore: invalid time ${time}`);
    }
    return this.store.logPriceAtOrBefore(Math.min(time, this.now()));
  }

  private syncAdapterDemands(): void {
    const requestedAtMs = this.now();
    this.adapterSession.setDemands(
      [...this.demandSubscriptions]
        .filter((subscription) => !subscription.disposed)
        .map((subscription) => ({ ...subscription.demand, requestedAtMs })),
    );
  }

  private isResolved(range: Range, maxDeltaTMs: number): boolean {
    if (
      this.store.answers(range, maxDeltaTMs) ||
      this.fetchedCoverage.answers(range, maxDeltaTMs)
    ) {
      return true;
    }
    const answered = new RangeSet();
    this.store.addReadyBlockers(answered, maxDeltaTMs, range);
    this.fetchedCoverage.addBlockers(answered, maxDeltaTMs, range);
    return answered.covers(range);
  }

  private ingest(result: AdapterDelivery): void {
    const clipped = clipPoints(PriceSeries.from(result.points).observations, result.searchedRange);
    const points = clipped.points;
    if (clipped.discardedFutureCount > 0) {
      this.onWarning(
        `[Broker] discarded ${clipped.discardedFutureCount} future point(s); ` +
          `searched range ended at ${result.searchedRange.max}, ` +
          `latest returned timestamp was ${clipped.latestFutureT}`,
      );
    }
    if (points.length > 0) {
      // A sample represents its zero-order-held value for one native sample
      // period. In particular, an OHLC candle open is already known at the
      // candle boundary and remains the displayed value until the next open.
      // Extending that final step to its expected lifetime prevents the moving
      // wall clock from manufacturing millisecond-sized "uncovered" tails.
      this.ingestObserved(points, result.resolutionMs, result.searchedRange.max, true);
    }
    this.fetchedCoverage.add(result.requestedMaxDeltaTMs, result.searchedRange);
  }

  private ingestObserved(
    points: readonly PricePoint[],
    nominalResolutionMs: number,
    observedThroughMs: number,
    searchedThroughRequestEnd: boolean,
  ): void {
    const spans: PriceSpanInput[] = [];
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      const observedDelta = current.t - previous.t;
      if (!(observedDelta > 0)) continue;
      const range = Range.create(previous.t, current.t);
      spans.push({
        startTime: previous.t,
        endTime: current.t,
        startLogPrice: Math.log(previous.price),
        endLogPrice: Math.log(current.price),
        // Quality describes the cadence that was searched, not the wall-clock
        // distance to the next returned candle. Otherwise every overnight or
        // weekend closure becomes a fake coarse interval and an intermediate
        // zoom produces thousands of alternating ready/missing fragments.
        resolutionMs: nominalResolutionMs,
      });
    }

    const last = points[points.length - 1];
    if (last !== undefined) {
      const expectedUntil = last.t + nominalResolutionMs;
      const heldUntil = searchedThroughRequestEnd
        ? expectedUntil
        : Math.min(expectedUntil, observedThroughMs);
      if (last.t < heldUntil) {
        const range = Range.create(last.t, heldUntil);
        const logPrice = Math.log(last.price);
        spans.push({
          startTime: last.t,
          endTime: heldUntil,
          startLogPrice: logPrice,
          endLogPrice: logPrice,
          resolutionMs: nominalResolutionMs,
        });
      }
    }

    this.store.insertBatch(spans);
  }

  private readySegments(evalTime: Float64Array, wallNow: number): ResolutionSegment[] {
    return this.store.segments(evalTime, wallNow).map((span) => ({
      range: Range.create(span.startTime, span.endTime),
      resolutionMs: span.resolutionMs,
      state: "ready" as const,
    }));
  }

  private transientSegments(range: Range): ResolutionSegment[] {
    const out: ResolutionSegment[] = [];
    for (const activity of this.adapterActivities) {
      const overlap = intersect(activity.range, range);
      if (overlap === null) continue;
      out.push({
        range: overlap,
        resolutionMs: activity.resolutionMs,
        state:
          activity.state === "failed"
            ? "failed"
            : activity.state === "watching"
              ? "watching"
              : "pending",
        ...(activity.message === undefined ? {} : { message: activity.message }),
        ...(activity.retryAtMs === undefined ? {} : { retryAtMs: activity.retryAtMs }),
      });
    }
    return out;
  }

  private notify(): void {
    for (const subscription of this.demandSubscriptions) {
      try {
        subscription.fn();
      } catch (error) {
        this.onError("[Broker] subscriber failed", error);
      }
    }
  }
}

function validateDemand(demand: BrokerDemand): BrokerDemand {
  if (!(demand.maxDeltaTMs > 0) || !Number.isFinite(demand.maxDeltaTMs)) {
    throw new Error(`Broker.subscribe: invalid maxDeltaTMs ${demand.maxDeltaTMs}`);
  }
  return demand;
}

function sameDemand(a: BrokerDemand, b: BrokerDemand): boolean {
  return (
    a.range.min === b.range.min && a.range.max === b.range.max && a.maxDeltaTMs === b.maxDeltaTMs
  );
}

function clampToNow(range: Range, now: number): Range | null {
  if (!Number.isFinite(now)) throw new Error(`Broker: invalid wall clock ${now}`);
  const max = Math.min(range.max, now);
  return range.min < max ? Range.create(range.min, max) : null;
}

function coverageLabelRank(state: ResolutionSegment["state"]): number {
  if (state === "failed") return 3;
  if (state === "pending") return 2;
  if (state === "watching") return 2;
  if (state === "ready") return 1;
  return 0;
}

interface ClippedPoints {
  readonly points: readonly PricePoint[];
  readonly discardedFutureCount: number;
  readonly latestFutureT: number | null;
}

function clipPoints(points: readonly PricePoint[], range: Range): ClippedPoints {
  let predecessor: PricePoint | undefined;
  const inside: PricePoint[] = [];
  let discardedFutureCount = 0;
  let latestFutureT: number | null = null;
  for (const point of points) {
    if (point.t < range.min) predecessor = point;
    else if (point.t <= range.max) inside.push(point);
    else {
      discardedFutureCount++;
      latestFutureT = point.t;
    }
  }
  return {
    points: predecessor === undefined ? inside : [predecessor, ...inside],
    discardedFutureCount,
    latestFutureT,
  };
}

function intersect(a: Range, b: Range): Range | null {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min < max ? Range.create(min, max) : null;
}
