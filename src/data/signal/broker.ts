/** Numeric sample cache and asynchronous-to-synchronous signal boundary. */

import { Interval } from "../../core/interval.ts";
import type { AdapterSession, SignalAdapter, SignalDemand } from "./fetcher.ts";
import { sameSignalReports, type SignalReport } from "./reports.ts";
import { normalizeSamples, type MutableSample, type Sample } from "./sample.ts";
import { NumericSeriesStore } from "./store.ts";

export interface SignalView {
  readonly value: Float64Array;
  /** Observation identity selected for each value; `-Infinity` where unavailable. */
  readonly sampleTime: Float64Array;
  /** Changes only when the stored timestamp-to-value mapping changes. */
  readonly sampleRevision: number;
  /** Adapter commentary only; reports never affect the returned samples. */
  readonly reports: readonly SignalReport[];
}

/** One live consumer. Reading updates its adapter demand from the query grid. */
export interface Subscription {
  read(evalTime: Float64Array): SignalView;
}

export interface BrokerOptions {
  /** The broker and its adapter session cannot outlive this signal. */
  readonly signal: AbortSignal;
  readonly onError?: (message: string, error?: unknown) => void;
}

interface QueryState {
  demand: SignalDemand | null;
  value: Float64Array<ArrayBufferLike>;
  sampleTime: Float64Array<ArrayBufferLike>;
  readonly invalidate: () => void;
}

export class Broker {
  private readonly store = new NumericSeriesStore();
  private readonly queries = new Set<QueryState>();
  private readonly adapterSession: AdapterSession;
  private readonly signal: AbortSignal;
  private readonly onError: (message: string, error?: unknown) => void;
  private sampleRevision = 0;
  private reports: readonly SignalReport[] = [];
  private syncingQuery: QueryState | null = null;

  constructor(adapter: SignalAdapter, opts: BrokerOptions) {
    this.signal = opts.signal;
    this.signal.throwIfAborted();
    this.onError = opts.onError ?? ((message, error) => console.error(message, error));
    this.adapterSession = adapter.connect(
      {
        next: samples => this.ingest(samples),
        setReports: reports => this.publishReports(reports),
        error: error => this.onError("[Broker] adapter failed", error),
      },
      this.signal,
    );
    this.signal.addEventListener("abort", () => this.queries.clear(), { once: true });
  }

  subscribe(invalidate: () => void, signal: AbortSignal): Subscription {
    const lifetime = AbortSignal.any([this.signal, signal]);
    lifetime.throwIfAborted();
    const query: QueryState = {
      demand: null,
      value: new Float64Array(0),
      sampleTime: new Float64Array(0),
      invalidate,
    };
    this.queries.add(query);
    lifetime.addEventListener(
      "abort",
      () => {
        if (!this.queries.delete(query) || this.signal.aborted) return;
        this.syncDemands(null);
      },
      { once: true },
    );

    return { read: evalTime => this.readQuery(query, evalTime) };
  }

  clearCache(): void {
    this.store.clear();
    this.sampleRevision++;
    this.adapterSession.clearCache();
    this.notify();
  }

  /** Write the latest selected observation at or before `time`. */
  readPointAtOrBefore(time: number, out: MutableSample): boolean {
    return this.store.findAtOrBefore(time, out);
  }

  private readQuery(query: QueryState, evalTime: Float64Array): SignalView {
    this.updateDemand(query, evalTime);
    if (query.value.length !== evalTime.length) {
      query.value = new Float64Array(evalTime.length);
      query.sampleTime = new Float64Array(evalTime.length);
    }
    this.store.findBatchAtOrBefore(evalTime, query.value, query.sampleTime);
    return {
      value: query.value,
      sampleTime: query.sampleTime,
      sampleRevision: this.sampleRevision,
      reports: this.reports,
    };
  }

  private updateDemand(query: QueryState, evalTime: Float64Array): void {
    const demand = demandFrom(evalTime);
    if (sameDemand(query.demand, demand)) return;
    query.demand = demand;
    this.syncDemands(query);
  }

  private syncDemands(query: QueryState | null): void {
    this.syncingQuery = query;
    try {
      this.adapterSession.setDemands(
        [...this.queries].flatMap(entry => (entry.demand === null ? [] : [entry.demand])),
      );
    } finally {
      this.syncingQuery = null;
    }
  }

  private ingest(samples: readonly Sample[]): void {
    if (!this.store.upsertBatch(normalizeSamples(samples))) return;
    this.sampleRevision++;
    this.notify(this.syncingQuery);
  }

  private publishReports(reports: readonly SignalReport[]): void {
    if (sameSignalReports(reports, this.reports)) return;
    this.reports = [...reports];
    this.notify(this.syncingQuery);
  }

  private notify(except: QueryState | null = null): void {
    for (const query of this.queries) {
      if (query === except) continue;
      try {
        query.invalidate();
      } catch (error) {
        this.onError("[Broker] subscriber failed", error);
      }
    }
  }
}

function demandFrom(evalTime: Float64Array): SignalDemand | null {
  if (evalTime.length < 2) return null;
  const range = Interval.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
  return Interval.isEmpty(range) ? null : { range, sampleCount: evalTime.length };
}

function sameDemand(a: SignalDemand | null, b: SignalDemand | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.sampleCount === b.sampleCount &&
      Interval.equals(a.range, b.range))
  );
}
