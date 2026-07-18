/** Evidence-backed cache and subscription boundary for a sampled signal. */

import { Interval } from "../../core/interval.ts";
import type { RequestSegment } from "./requests.ts";
import type {
  AcquisitionActivity,
  AdapterDelivery,
  AdapterSession,
  SignalAdapter,
} from "./fetcher.ts";
import { normalizeSamples, type MutableSample, type Sample } from "./sample.ts";
import { NumericSeriesStore } from "./store.ts";

export interface SignalView {
  readonly value: Float64Array;
  /** Observation identity selected for each value; `-Infinity` where unavailable. */
  readonly sampleTime: Float64Array;
  readonly requests: readonly RequestSegment[];
  /** Changes only when the selected reconstruction changes, never for status-only updates. */
  readonly sampleRevision: number;
}

export interface ReadRequest {
  readonly evalTime: Float64Array;
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
  readonly onError?: (message: string, error?: unknown) => void;
  readonly onWarning?: (message: string) => void;
}

interface DemandSubscription {
  demand: BrokerDemand;
  readonly fn: () => void;
}

export class Broker {
  private readonly store = new NumericSeriesStore();
  private readonly demandSubscriptions = new Set<DemandSubscription>();
  private readonly adapterSession: AdapterSession;
  private readonly signal: AbortSignal;
  private readonly onError: (message: string, error?: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private sampleRevision = 0;
  private adapterActivities: readonly AcquisitionActivity[] = [];
  private syncingAdapterDemands = false;
  private valueBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private sampleTimeBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);

  constructor(adapter: SignalAdapter, opts: BrokerOptions) {
    this.signal = opts.signal;
    this.signal.throwIfAborted();
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
          // A synchronous status update caused by setDemands already belongs to
          // the render/update flowing into the broker. Feeding it back to the
          // same subscriber would create a demand -> status -> demand loop.
          if (!this.syncingAdapterDemands) this.notify();
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
    const { evalTime } = opts;
    if (this.valueBuffer.length !== evalTime.length) {
      this.valueBuffer = new Float64Array(evalTime.length);
    }
    if (this.sampleTimeBuffer.length !== evalTime.length) {
      this.sampleTimeBuffer = new Float64Array(evalTime.length);
    }

    this.store.findBatchAtOrBefore(evalTime, this.valueBuffer, this.sampleTimeBuffer);
    const requests =
      evalTime.length < 2
        ? []
        : this.transientSegments(
            Interval.create(evalTime[0]!, evalTime[evalTime.length - 1]!),
          ).sort(
            (a, b) =>
              a.range.start - b.range.start ||
              requestLabelRank(b) - requestLabelRank(a) ||
              a.range.end - b.range.end,
          );

    return {
      value: this.valueBuffer,
      sampleTime: this.sampleTimeBuffer,
      requests,
      sampleRevision: this.sampleRevision,
    };
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
    this.adapterActivities = [];
    this.valueBuffer = new Float64Array(0);
    this.sampleTimeBuffer = new Float64Array(0);
    this.adapterSession.clearCache();
    this.sampleRevision++;
    this.notify();
  }

  /** Write the latest selected observation at or before `time`. */
  readPointAtOrBefore(time: number, out: MutableSample): boolean {
    return this.store.findAtOrBefore(time, out);
  }

  private syncAdapterDemands(): void {
    this.syncingAdapterDemands = true;
    try {
      this.adapterSession.setDemands(
        [...this.demandSubscriptions].map(subscription => subscription.demand),
      );
    } finally {
      this.syncingAdapterDemands = false;
    }
  }

  private ingest(result: AdapterDelivery): boolean {
    const clipped = clipSamples(normalizeSamples(result.samples), result.searchedInterval);
    const samples = clipped.samples;
    if (clipped.discardedAfterRangeCount > 0) {
      this.onWarning(
        `[Broker] discarded ${clipped.discardedAfterRangeCount} point(s) after the searched range; ` +
          `searched range ended at ${result.searchedInterval.end}, ` +
          `latest returned timestamp was ${clipped.latestAfterRangeT}`,
      );
    }
    return this.store.upsertBatch(samples);
  }

  private transientSegments(range: Interval): RequestSegment[] {
    const out: RequestSegment[] = [];
    for (const activity of this.adapterActivities) {
      const overlap = Interval.intersection(activity.range, range);
      if (Interval.isEmpty(overlap)) continue;
      if (activity.state === "retrying") {
        out.push({
          range: overlap,
          samplePeriodMs: activity.resolutionMs,
          state: "retrying",
          attempt: activity.attempt,
          message: activity.message,
          retryAtMs: activity.retryAtMs,
        });
      } else {
        out.push({ range: overlap, samplePeriodMs: activity.resolutionMs, state: "pending" });
      }
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
  return Interval.equals(a.range, b.range) && a.maxDeltaTMs === b.maxDeltaTMs;
}

function requestLabelRank(segment: RequestSegment): number {
  return segment.state === "retrying" ? 1 : 0;
}

interface ClippedPoints {
  readonly samples: readonly Sample[];
  readonly discardedAfterRangeCount: number;
  readonly latestAfterRangeT: number | null;
}

function clipSamples(samples: readonly Sample[], range: Interval): ClippedPoints {
  let predecessor: Sample | undefined;
  const inside: Sample[] = [];
  let discardedAfterRangeCount = 0;
  let latestAfterRangeT: number | null = null;
  for (const sample of samples) {
    if (sample.t < range.start) predecessor = sample;
    // A sample exactly at `end` is valid boundary evidence: it closes the
    // preceding hold and begins its own native-resolution hold. Searched
    // coverage remains half-open independently of observation lifetimes.
    else if (sample.t <= range.end) inside.push(sample);
    else {
      discardedAfterRangeCount++;
      latestAfterRangeT = sample.t;
    }
  }
  return {
    samples: predecessor === undefined ? inside : [predecessor, ...inside],
    discardedAfterRangeCount,
    latestAfterRangeT,
  };
}
