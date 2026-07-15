/** Evidence-backed cache and subscription boundary for a sampled signal. */

import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";
import { SettledCoverageIndex, type CoverageSegment } from "./coverage.ts";
import type { AcquisitionActivity, AdapterDelivery as SignalDelivery, AdapterSession, SignalAdapter, } from "./fetcher.ts";
import { normalizeSamples, type Sample } from "./sample.ts";
import { SignalSpanStore, type SignalSpan } from "./store.ts";

export interface SignalView {
  readonly value: Float64Array;
  readonly coverage: readonly CoverageSegment[];
  /** Changes only when cached sample values change, never for status-only updates. */
  readonly sampleRevision: number;
}

export interface ReadRequest {
  readonly evalTime: Float64Array;
  readonly maxSampleGapMs: number;
}

/** Fetch/cache demand independent of a particular sampling grid. */
export interface BrokerDemand {
  readonly range: Range;
  readonly maxDeltaTMs: number;
}

/** Mutable viewport interest. Updating it does not allocate a new subscription. */
export interface Subscription {
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
  private readonly store = new SignalSpanStore();
  private readonly fetchedCoverage = new SettledCoverageIndex();
  private readonly demandSubscriptions = new Set<DemandSubscription>();
  private readonly adapterSession: AdapterSession;
  private readonly now: () => number;
  private readonly onError: (message: string, error?: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private sampleRevision = 0;
  private adapterActivities: readonly AcquisitionActivity[] = [];
  private valueBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);

  constructor(adapter: SignalAdapter, opts: BrokerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? ((message, error) => console.error(message, error));
    this.onWarning = opts.onWarning ?? ((message) => console.warn(message));
    this.adapterSession = adapter.connect({
      next: (batch) => {
        if (this.ingest(batch)) this.sampleRevision++;
        this.notify();
      },
      status: (activities) => {
        this.adapterActivities = activities;
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
  read(opts: ReadRequest): SignalView {
    const { evalTime, maxSampleGapMs: maxDeltaTMs } = opts;
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
        coverage: [],
        sampleRevision: this.sampleRevision,
      };
    }

    const queryRange = Range.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
    const wallNow = this.now();
    const historicalRange = clampToNow(queryRange, wallNow);
    const sampled = this.store.sample(evalTime, wallNow, this.valueBuffer);
    this.valueBuffer = sampled.value;
    const value = sampled.value;

    const readyCoverage = new RangeSet();
    if (historicalRange !== null) {
      this.store.addReadyBlockers(readyCoverage, maxDeltaTMs, historicalRange);
    }
    const coverage = [
      ...this.readySegments(evalTime, wallNow),
      ...(historicalRange === null
        ? []
        : this.fetchedCoverage.emptySegments(historicalRange, maxDeltaTMs, readyCoverage)),
      ...this.transientSegments(queryRange),
      ...this.futureSegments(queryRange, wallNow, maxDeltaTMs),
    ].sort(
      (a, b) =>
        a.range.min - b.range.min ||
        coverageLabelRank(b.state) - coverageLabelRank(a.state) ||
        a.range.max - b.range.max,
    );

    return {
      value,
      coverage,
      sampleRevision: this.sampleRevision,
    };
  }

  subscribe(demand: BrokerDemand, fn: () => void): Subscription {
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
    this.adapterSession.clearCache();
    this.sampleRevision++;
    this.notify();
  }

  cachedRange(): Range | null {
    return this.store.timeRange();
  }

  /** Latest reconstructed signal value at or before `time`, clamped to now. */
  valueAtOrBefore(time: number): number | null {
    if (!Number.isFinite(time)) {
      throw new Error(`Broker.valueAtOrBefore: invalid time ${time}`);
    }
    return this.store.valueAtOrBefore(Math.min(time, this.now()));
  }

  private syncAdapterDemands(): void {
    this.adapterSession.setDemands(
      [...this.demandSubscriptions]
        .filter((subscription) => !subscription.disposed)
        .map((subscription) => ({ ...subscription.demand })),
    );
  }

  private ingest(result: SignalDelivery): boolean {
    const clipped = clipSamples(normalizeSamples(result.samples), result.searchedRange);
    const samples = clipped.samples;
    if (clipped.discardedFutureCount > 0) {
      this.onWarning(
        `[Broker] discarded ${clipped.discardedFutureCount} future point(s); ` +
        `searched range ended at ${result.searchedRange.max}, ` +
        `latest returned timestamp was ${clipped.latestFutureT}`,
      );
    }
    let changed = false;
    if (samples.length > 0) {
      // A sample represents its zero-order-held value for one native sample
      // period. In particular, an OHLC candle open is already known at the
      // candle boundary and remains the displayed value until the next open.
      // Extending that final step to its expected lifetime prevents the moving
      // wall clock from manufacturing millisecond-sized "uncovered" tails.
      changed = this.ingestObserved(samples, result.resolutionMs);
    }
    this.fetchedCoverage.add(result.requestedMaxDeltaTMs, result.searchedRange);
    return changed;
  }

  private ingestObserved(samples: readonly Sample[], nominalResolutionMs: number): boolean {
    const spans: SignalSpan[] = [];
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      const observedDelta = current.t - previous.t;
      if (!(observedDelta > 0)) continue;

      spans.push({
        startTime: previous.t,
        endTime: current.t,
        startValue: previous.value,
        endValue: current.value,
        // Quality describes the cadence that was searched, not the wall-clock
        // distance to the next returned candle. Otherwise every overnight or
        // weekend closure becomes a fake coarse interval and an intermediate
        // zoom produces thousands of alternating ready/missing fragments.
        resolutionMs: nominalResolutionMs,
      });
    }

    const last = samples[samples.length - 1];
    if (last !== undefined) {
      const expectedUntil = last.t + nominalResolutionMs;
      if (last.t < expectedUntil) {
        spans.push({
          startTime: last.t,
          endTime: expectedUntil,
          startValue: last.value,
          endValue: last.value,
          resolutionMs: nominalResolutionMs,
        });
      }
    }

    return this.store.insertBatch(spans);
  }

  private readySegments(evalTime: Float64Array, wallNow: number): CoverageSegment[] {
    return this.store.segments(evalTime, wallNow).map((span) => ({
      range: Range.create(span.startTime, span.endTime),
      samplePeriodMs: span.resolutionMs,
      state: "ready" as const,
    }));
  }

  private transientSegments(range: Range): CoverageSegment[] {
    const out: CoverageSegment[] = [];
    for (const activity of this.adapterActivities) {
      const overlap = intersect(activity.range, range);
      if (overlap === null) continue;
      out.push({
        range: overlap,
        samplePeriodMs: activity.resolutionMs,
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

  private futureSegments(range: Range, wallNow: number, maxSampleGapMs: number): CoverageSegment[] {
    const min = Math.max(range.min, wallNow);
    if (!(min < range.max)) return [];
    return [
      {
        range: Range.create(min, range.max),
        samplePeriodMs: maxSampleGapMs,
        state: this.adapterActivities.some((activity) => activity.state === "watching")
          ? "watching"
          : "pending",
      },
    ];
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

function coverageLabelRank(state: CoverageSegment["state"]): number {
  if (state === "failed") return 3;
  if (state === "pending") return 2;
  if (state === "watching") return 2;
  if (state === "ready") return 1;
  return 0;
}

interface ClippedPoints {
  readonly samples: readonly Sample[];
  readonly discardedFutureCount: number;
  readonly latestFutureT: number | null;
}

function clipSamples(samples: readonly Sample[], range: Range): ClippedPoints {
  let predecessor: Sample | undefined;
  const inside: Sample[] = [];
  let discardedFutureCount = 0;
  let latestFutureT: number | null = null;
  for (const sample of samples) {
    if (sample.t < range.min) predecessor = sample;
    else if (sample.t <= range.max) inside.push(sample);
    else {
      discardedFutureCount++;
      latestFutureT = sample.t;
    }
  }
  return {
    samples: predecessor === undefined ? inside : [predecessor, ...inside],
    discardedFutureCount,
    latestFutureT,
  };
}

function intersect(a: Range, b: Range): Range | null {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min < max ? Range.create(min, max) : null;
}
