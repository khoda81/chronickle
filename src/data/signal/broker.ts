/** Evidence-backed cache and subscription boundary for a sampled signal. */

import { Interval, IntervalSet } from "../../core/interval.ts";
import { SettledCoverageIndex, type CoverageSegment } from "./coverage.ts";
import type {
  AcquisitionActivity,
  AdapterDelivery,
  AdapterSession,
  SignalAdapter,
} from "./fetcher.ts";
import { normalizeSamples, type MutableSample, type Sample } from "./sample.ts";
import { SignalSegmentStore, type HeldSignalSegment } from "./store.ts";

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

export interface BrokerDemand {
  readonly range: Interval;
  /** Maximum acceptable native sample spacing requested by the consumer. */
  readonly maxDeltaTMs: number;
}

/** Mutable viewport interest. Updating it does not allocate a new subscription. */
export interface Subscription {
  update(demand: BrokerDemand): void;
}

export interface BrokerOptions {
  /** The broker and its acquisition session cannot outlive this signal. */
  readonly signal: AbortSignal;
  /** Injectable wall clock for deterministic tests. */
  readonly now?: () => number;
  readonly onError?: (message: string, error?: unknown) => void;
  readonly onWarning?: (message: string) => void;
}

interface DemandSubscription {
  demand: BrokerDemand;
  readonly fn: () => void;
}

export class Broker {
  private readonly store = new SignalSegmentStore();
  private readonly fetchedCoverage = new SettledCoverageIndex();
  private readonly demandSubscriptions = new Set<DemandSubscription>();
  private readonly adapterSession: AdapterSession;
  private readonly signal: AbortSignal;
  private readonly now: () => number;
  private readonly onError: (message: string, error?: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private sampleRevision = 0;
  private adapterActivities: readonly AcquisitionActivity[] = [];
  private valueBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);

  constructor(adapter: SignalAdapter, opts: BrokerOptions) {
    this.signal = opts.signal;
    this.signal.throwIfAborted();
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? ((message, error) => console.error(message, error));
    this.onWarning = opts.onWarning ?? (message => console.warn(message));
    this.adapterSession = adapter.connect(
      {
        next: batch => {
          if (this.ingest(batch)) this.sampleRevision++;
          this.notify();
        },
        status: activities => {
          this.adapterActivities = activities;
          this.notify();
        },
        error: (error, activity) => {
          this.onError(
            `[Broker] adapter failed for ${activity.range.start}..${activity.range.end}; retry scheduled`,
            error,
          );
        },
      },
      this.signal,
    );
    this.signal.addEventListener("abort", () => this.demandSubscriptions.clear(), { once: true });
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
      return { value, coverage: [], sampleRevision: this.sampleRevision };
    }

    const queryInterval = Interval.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
    const wallNow = this.now();
    const historicalInterval = clampToNow(queryInterval, wallNow);
    const value = this.store.sample(evalTime, wallNow, this.valueBuffer);
    this.valueBuffer = value;

    const readyCoverage = new IntervalSet();
    if (!Interval.isEmpty(historicalInterval)) {
      this.store.addReadyBlockers(readyCoverage, maxDeltaTMs, historicalInterval);
    }
    const coverage = [
      ...this.readySegments(evalTime, wallNow),
      ...(Interval.isEmpty(historicalInterval)
        ? []
        : this.fetchedCoverage.emptySegments(historicalInterval, maxDeltaTMs, readyCoverage)),
      ...this.transientSegments(queryInterval),
      ...this.futureSegments(queryInterval, wallNow, maxDeltaTMs),
    ].sort(
      (a, b) =>
        a.range.start - b.range.start ||
        coverageLabelRank(b.state) - coverageLabelRank(a.state) ||
        a.range.end - b.range.end,
    );

    return { value, coverage, sampleRevision: this.sampleRevision };
  }

  subscribe(demand: BrokerDemand, fn: () => void, signal: AbortSignal): Subscription {
    const lifetime = AbortSignal.any([this.signal, signal]);
    lifetime.throwIfAborted();
    const entry: DemandSubscription = { demand: validateDemand(demand), fn };
    this.demandSubscriptions.add(entry);
    this.syncAdapterDemands();
    lifetime.addEventListener(
      "abort",
      () => {
        if (!this.demandSubscriptions.delete(entry) || this.signal.aborted) return;
        this.syncAdapterDemands();
      },
      { once: true },
    );
    return {
      update: demand => {
        lifetime.throwIfAborted();
        const next = validateDemand(demand);
        if (sameDemand(entry.demand, next)) return;
        entry.demand = next;
        this.syncAdapterDemands();
      },
    };
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

  cachedInterval(): Interval | null {
    return this.store.timeInterval();
  }

  /** Write the latest selected observation at or before `time`, clamped to now. */
  readPointAtOrBefore(time: number, out: MutableSample): boolean {
    return this.store.readPointAtOrBefore(Math.min(time, this.now()), out);
  }

  private syncAdapterDemands(): void {
    this.adapterSession.setDemands(
      [...this.demandSubscriptions].map(subscription => subscription.demand),
    );
  }

  private ingest(result: AdapterDelivery): boolean {
    const clipped = clipSamples(normalizeSamples(result.samples), result.searchedInterval);
    const samples = clipped.samples;
    if (clipped.discardedFutureCount > 0) {
      this.onWarning(
        `[Broker] discarded ${clipped.discardedFutureCount} future point(s); ` +
          `searched range ended at ${result.searchedInterval.end}, ` +
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
    this.fetchedCoverage.add(result.resolutionMs, result.searchedInterval);
    return changed;
  }

  private ingestObserved(samples: readonly Sample[], nominalResolutionMs: number): boolean {
    const segments: HeldSignalSegment[] = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]!;
      const next = samples[index + 1];
      const rangeEnd = next?.t ?? sample.t + nominalResolutionMs;
      if (!(sample.t < rangeEnd)) continue;

      segments.push({
        range: Interval.create(sample.t, rangeEnd),
        sampleTime: sample.t,
        value: sample.value,
        // Quality describes the cadence that was searched, not the wall-clock
        // distance to the next returned candle. Otherwise every overnight or
        // weekend closure becomes a fake coarse interval and an intermediate
        // zoom produces thousands of alternating ready/missing fragments.
        resolutionMs: nominalResolutionMs,
      });
    }

    return this.store.insertBatch(segments);
  }

  private readySegments(evalTime: Float64Array, wallNow: number): CoverageSegment[] {
    return this.store
      .segments(evalTime, wallNow)
      .map(span => ({
        range: span.range,
        samplePeriodMs: span.resolutionMs,
        state: "ready" as const,
      }));
  }

  private transientSegments(range: Interval): CoverageSegment[] {
    const out: CoverageSegment[] = [];
    for (const activity of this.adapterActivities) {
      const overlap = Interval.intersection(activity.range, range);
      if (Interval.isEmpty(overlap)) continue;
      if (activity.state === "failed") {
        out.push({
          range: overlap,
          samplePeriodMs: activity.resolutionMs,
          state: "failed",
          message: activity.message,
          retryAtMs: activity.retryAtMs,
        });
      } else {
        out.push({
          range: overlap,
          samplePeriodMs: activity.resolutionMs,
          state: activity.state === "watching" ? "watching" : "pending",
        });
      }
    }
    return out;
  }

  private futureSegments(
    range: Interval,
    wallNow: number,
    maxSampleGapMs: number,
  ): CoverageSegment[] {
    const min = Math.max(range.start, wallNow);
    if (!(min < range.end)) return [];
    return [
      {
        range: Interval.create(min, range.end),
        samplePeriodMs: maxSampleGapMs,
        state: this.adapterActivities.some(activity => activity.state === "watching")
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
  return Interval.equals(a.range, b.range) && a.maxDeltaTMs === b.maxDeltaTMs;
}

function clampToNow(range: Interval, now: number): Interval {
  if (!Number.isFinite(now)) throw new Error(`Broker: invalid wall clock ${now}`);
  return Interval.clampEnd(range, now);
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

function clipSamples(samples: readonly Sample[], range: Interval): ClippedPoints {
  let predecessor: Sample | undefined;
  const inside: Sample[] = [];
  let discardedFutureCount = 0;
  let latestFutureT: number | null = null;
  for (const sample of samples) {
    if (sample.t < range.start) predecessor = sample;
    // A sample exactly at `end` is valid boundary evidence: it closes the
    // preceding hold and begins its own native-resolution hold. Searched
    // coverage remains half-open independently of observation lifetimes.
    else if (sample.t <= range.end) inside.push(sample);
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
