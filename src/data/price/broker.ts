/** Evidence-backed, resolution-aware price broker. */

import { PriceSeries, type PricePoint } from "../../domain.ts";
import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";
import { EmptyCoverageIndex, type ResolutionSegment } from "./coverage.ts";
import type { Fetcher, FetchRangeResult } from "./fetcher.ts";
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
  readonly defaultRetryDelayMs?: (attempt: number) => number;
  readonly onError?: (message: string, error?: unknown) => void;
  readonly onWarning?: (message: string) => void;
}

interface RequestState {
  readonly range: Range;
  readonly maxDeltaTMs: number;
  readonly liveEdge: boolean;
}

interface FailedRequest extends RequestState {
  readonly message: string;
  readonly retryAt: number;
  readonly timer: number;
}

interface DemandSubscription {
  demand: BrokerDemand;
  readonly fn: () => void;
  disposed: boolean;
}

interface LiveRefresh {
  readonly through: number;
  readonly maxDeltaTMs: number;
  readonly at: number;
  timer: number | null;
}

const LIVE_EDGE_SLOP_MS = 1_000;
const LIVE_PUBLICATION_GRACE_MS = 250;
const DEFAULT_RETRY = (attempt: number): number => Math.min(30_000, 2_000 * 2 ** (attempt - 1));

export class Broker {
  private readonly store = new PriceSpanStore();
  private readonly emptyCoverage = new EmptyCoverageIndex();
  private readonly subscribers = new Set<() => void>();
  private readonly demandSubscriptions = new Set<DemandSubscription>();
  private readonly inFlight = new Map<string, RequestState>();
  private readonly failures = new Map<string, FailedRequest>();
  private readonly failureAttempts = new Map<string, number>();
  private liveRefresh: LiveRefresh | null = null;
  private readonly now: () => number;
  private readonly defaultRetryDelayMs: (attempt: number) => number;
  private readonly onError: (message: string, error?: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private generation = 0;
  private revision = 0;
  private valueBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);
  private resolutionBuffer: Float64Array<ArrayBufferLike> = new Float64Array(0);

  constructor(
    private readonly fetcher: Fetcher,
    opts: BrokerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.defaultRetryDelayMs = opts.defaultRetryDelayMs ?? DEFAULT_RETRY;
    this.onError = opts.onError ?? ((message, error) => console.error(message, error));
    this.onWarning = opts.onWarning ?? ((message) => console.warn(message));
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
    const resolution =
      historicalRange === null
        ? []
        : [
            ...this.readySegments(evalTime, wallNow),
            ...this.emptyCoverage.segments(historicalRange, maxDeltaTMs),
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

  /**
   * Compatibility helper for non-immediate callers. New UI code should pair
   * read() with subscribe(demand, fn), keeping reads pure.
   */
  query(opts: QueryOptions): QueryResult {
    if (opts.evalTime.length >= 2) {
      this.ensure({
        range: Range.create(opts.evalTime[0]!, opts.evalTime[opts.evalTime.length - 1]!),
        maxDeltaTMs: opts.maxDeltaTMs,
      });
    }
    return this.read(opts);
  }

  subscribe(demand: BrokerDemand, fn: () => void): BrokerSubscription;
  subscribe(fn: () => void): () => void;
  subscribe(
    demandOrFn: BrokerDemand | (() => void),
    maybeFn?: () => void,
  ): BrokerSubscription | (() => void) {
    // Legacy source-wide notification, retained for non-viewport callers.
    if (typeof demandOrFn === "function") {
      this.subscribers.add(demandOrFn);
      this.armLiveRefresh();
      return () => this.subscribers.delete(demandOrFn);
    }

    if (maybeFn === undefined) throw new Error("Broker.subscribe: callback is required");
    const entry: DemandSubscription = {
      demand: validateDemand(demandOrFn),
      fn: maybeFn,
      disposed: false,
    };
    this.demandSubscriptions.add(entry);
    this.ensure(entry.demand);
    this.armLiveRefresh();
    return {
      update: (demand) => {
        if (entry.disposed) throw new Error("Broker subscription is disposed");
        const next = validateDemand(demand);
        if (sameDemand(entry.demand, next)) return;
        entry.demand = next;
        this.ensure(next);
      },
      dispose: () => {
        if (entry.disposed) return;
        entry.disposed = true;
        this.demandSubscriptions.delete(entry);
        if (!this.hasSubscribers()) this.disarmLiveRefresh();
      },
    };
  }

  dispose(): void {
    this.generation++;
    for (const failure of this.failures.values()) clearTimeout(failure.timer);
    this.clearLiveRefresh();
    this.inFlight.clear();
    this.failures.clear();
    this.subscribers.clear();
    this.demandSubscriptions.clear();
  }

  /** Drop all observations/request state and ignore responses from the old generation. */
  clearCache(): void {
    this.generation++;
    this.fetcher.clearCache?.();
    this.store.clear();
    this.emptyCoverage.clear();
    this.valueBuffer = new Float64Array(0);
    this.resolutionBuffer = new Float64Array(0);
    this.inFlight.clear();
    for (const failure of this.failures.values()) clearTimeout(failure.timer);
    this.clearLiveRefresh();
    this.failures.clear();
    this.failureAttempts.clear();
    this.revision++;
    this.ensureAll();
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

  private ensure(demand: BrokerDemand): void {
    const historicalRange = clampToNow(demand.range, this.now());
    if (historicalRange !== null) this.planRequests(historicalRange, demand.maxDeltaTMs);
  }

  private ensureAll(): void {
    for (const subscription of this.demandSubscriptions) this.ensure(subscription.demand);
  }

  private planRequests(range: Range, maxDeltaTMs: number): void {
    // The overwhelmingly common steady-state path is already answered by one
    // ready level. Avoid constructing and merging a temporary RangeSet on
    // every animation frame in that case.
    if (
      this.store.answers(range, maxDeltaTMs) ||
      this.emptyCoverage.answers(range, maxDeltaTMs) ||
      this.transientlyBlocks(range, maxDeltaTMs)
    ) {
      return;
    }
    const blocked = this.blockers(range, maxDeltaTMs);
    for (const gap of blocked.gaps(range)) void this.requestFetch(gap, maxDeltaTMs);
  }

  private transientlyBlocks(range: Range, maxDeltaTMs: number): boolean {
    if (this.fetcher.serializeRequests === true && this.inFlight.size > 0) return true;
    for (const request of this.inFlight.values()) {
      if (request.maxDeltaTMs <= maxDeltaTMs && covers(request.range, range)) return true;
    }
    if (this.fetcher.sourceWideBackoff === true && this.failures.size > 0) return true;
    for (const failure of this.failures.values()) {
      if (covers(failure.range, range)) return true;
    }
    return false;
  }

  private blockers(range: Range, maxDeltaTMs: number): RangeSet {
    const blocked = new RangeSet();
    this.store.addReadyBlockers(blocked, maxDeltaTMs, range);
    this.emptyCoverage.addBlockers(blocked, maxDeltaTMs, range);
    const liveRefresh = this.liveRefresh;
    if (
      liveRefresh !== null &&
      liveRefresh.maxDeltaTMs <= maxDeltaTMs &&
      this.now() < liveRefresh.at
    ) {
      const min = Math.max(range.min, liveRefresh.through);
      if (min < range.max) blocked.add(Range.create(min, range.max));
    }

    // Finer ready/pending work satisfies a coarser query. A coarser request
    // deliberately does not suppress a new finer request.
    if (this.fetcher.serializeRequests === true && this.inFlight.size > 0) {
      blocked.add(range);
    } else {
      for (const request of this.inFlight.values()) {
        if (request.maxDeltaTMs > maxDeltaTMs) continue;
        const overlap = intersect(request.range, range);
        if (overlap !== null) blocked.add(overlap);
      }
    }
    // A failed exchange call suppresses all qualities briefly; the adapter
    // controls how long through retryDelayMs().
    if (this.fetcher.sourceWideBackoff === true && this.failures.size > 0) {
      blocked.add(range);
    } else {
      for (const failure of this.failures.values()) {
        const overlap = intersect(failure.range, range);
        if (overlap !== null) blocked.add(overlap);
      }
    }
    return blocked;
  }

  private isResolved(range: Range, maxDeltaTMs: number): boolean {
    if (this.store.answers(range, maxDeltaTMs) || this.emptyCoverage.answers(range, maxDeltaTMs)) {
      return true;
    }
    const answered = new RangeSet();
    this.store.addReadyBlockers(answered, maxDeltaTMs, range);
    this.emptyCoverage.addBlockers(answered, maxDeltaTMs, range);
    return answered.covers(range);
  }

  private async requestFetch(range: Range, maxDeltaTMs: number): Promise<void> {
    if (this.fetcher.serializeRequests === true && this.inFlight.size > 0) return;
    if (this.fetcher.sourceWideBackoff === true && this.failures.size > 0) return;
    const key = requestKey(range, maxDeltaTMs);
    if (this.inFlight.has(key) || this.failures.has(key)) return;
    const startedAt = this.now();
    const request = {
      range,
      maxDeltaTMs,
      liveEdge: startedAt >= range.max && startedAt - range.max <= LIVE_EDGE_SLOP_MS,
    };
    const generation = this.generation;
    this.inFlight.set(key, request);
    let notifyAfterRequest = false;

    try {
      const result = await this.fetcher.fetchRange(request);
      if (generation !== this.generation) return;
      const liveRefresh = this.ingest(request, result);
      if (liveRefresh !== null) this.setLiveRefresh(liveRefresh);
      this.failureAttempts.delete(key);
      this.revision++;
      notifyAfterRequest = true;
    } catch (error) {
      if (generation !== this.generation) return;
      this.onError(`[Broker] fetch failed for ${range.min}..${range.max}`, error);
      const attempt = (this.failureAttempts.get(key) ?? 0) + 1;
      this.failureAttempts.set(key, attempt);
      const proposed =
        this.fetcher.retryDelayMs?.(error, attempt) ?? this.defaultRetryDelayMs(attempt);
      const validPolicy = proposed >= 0 && Number.isFinite(proposed);
      if (!validPolicy) this.onError(`[Broker] invalid retry delay ${proposed}; using default`);
      const delay = Math.max(100, validPolicy ? proposed : DEFAULT_RETRY(attempt));
      const retryAt = this.now() + delay;
      const message = error instanceof Error ? error.message : String(error);
      const timer = setTimeout(() => {
        const failure = this.failures.get(key);
        if (failure === undefined || failure.retryAt !== retryAt) return;
        // "Empty" here means no transient request state, not known-empty
        // market coverage. The next render is allowed to retry.
        this.failures.delete(key);
        this.revision++;
        this.ensureAll();
        this.notify();
      }, delay) as unknown as number;
      this.failures.set(key, { ...request, message, retryAt, timer });
      this.revision++;
      notifyAfterRequest = true;
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      // Continue serialized/backfilled demand before notifying the UI. Reads
      // remain pure; subscriptions are the sole request-driving mechanism.
      if (notifyAfterRequest) {
        this.ensureAll();
        this.notify();
      }
    }
  }

  private ingest(request: RequestState, result: FetchRangeResult): LiveRefresh | null {
    const clipped = clipPoints(PriceSeries.from(result.points).observations, request.range);
    const points = clipped.points;
    if (clipped.discardedFutureCount > 0) {
      this.onWarning(
        `[Broker] discarded ${clipped.discardedFutureCount} future point(s); ` +
          `request ended at ${request.range.max}, latest returned timestamp was ${clipped.latestFutureT}`,
      );
    }
    const nominalResolutionMs = inferNominalResolution(
      points,
      result.resolutionHintMs,
      request.maxDeltaTMs,
    );

    const searched = searchedRange(request.range, result, points, nominalResolutionMs);
    if (points.length > 0) {
      // A sample represents its zero-order-held value for one native sample
      // period. In particular, an OHLC candle open is already known at the
      // candle boundary and remains the displayed value until the next open.
      // Extending that final step to its expected lifetime prevents the moving
      // wall clock from manufacturing millisecond-sized "uncovered" tails.
      this.ingestObserved(
        points,
        nominalResolutionMs,
        searched?.max ?? request.range.max,
        searched !== null && searched.max >= request.range.max,
      );
    }
    if (searched === null) {
      if (points.length === 0) {
        throw new Error("Fetcher returned no points and no searchedRange");
      }
      return this.liveRefreshAfter(request, points, nominalResolutionMs, false);
    }

    // Only portions not actually supported by observations are empty, and
    // only for this exact requested quality.
    const observed = new RangeSet();
    this.store.addReadyBlockers(observed, request.maxDeltaTMs, searched);
    for (const gap of observed.gaps(searched)) {
      this.emptyCoverage.add(request.maxDeltaTMs, gap);
    }
    return this.liveRefreshAfter(
      request,
      points,
      nominalResolutionMs,
      searched.max >= request.range.max,
    );
  }

  private liveRefreshAfter(
    request: RequestState,
    points: readonly PricePoint[],
    nominalResolutionMs: number,
    searchedThroughRequestEnd: boolean,
  ): LiveRefresh | null {
    if (!request.liveEdge || !searchedThroughRequestEnd) return null;
    const now = this.now();
    const last = points[points.length - 1];
    const expectedNext = last === undefined ? -Infinity : last.t + nominalResolutionMs;
    const fallbackDelay =
      this.fetcher.liveRetryDelayMs ?? Math.min(30_000, Math.max(1_000, nominalResolutionMs / 10));
    if (!(fallbackDelay > 0) || !Number.isFinite(fallbackDelay)) {
      throw new Error(`Fetcher has invalid liveRetryDelayMs ${fallbackDelay}`);
    }
    return {
      through: request.range.max,
      maxDeltaTMs: request.maxDeltaTMs,
      at: expectedNext > now ? expectedNext + LIVE_PUBLICATION_GRACE_MS : now + fallbackDelay,
      timer: null,
    };
  }

  private setLiveRefresh(refresh: LiveRefresh): void {
    this.clearLiveRefresh();
    this.liveRefresh = refresh;
    this.armLiveRefresh();
  }

  private armLiveRefresh(): void {
    const refresh = this.liveRefresh;
    if (refresh === null || refresh.timer !== null || !this.hasSubscribers()) return;
    const delay = Math.max(0, refresh.at - this.now());
    refresh.timer = setTimeout(() => {
      if (this.liveRefresh !== refresh) return;
      this.liveRefresh = null;
      this.ensureAll();
      this.notify();
    }, delay) as unknown as number;
  }

  private clearLiveRefresh(): void {
    const refresh = this.liveRefresh;
    if (refresh?.timer !== null && refresh?.timer !== undefined) clearTimeout(refresh.timer);
    this.liveRefresh = null;
  }

  private disarmLiveRefresh(): void {
    const refresh = this.liveRefresh;
    if (refresh?.timer !== null && refresh?.timer !== undefined) clearTimeout(refresh.timer);
    if (refresh !== null) refresh.timer = null;
  }

  private hasSubscribers(): boolean {
    return this.subscribers.size > 0 || this.demandSubscriptions.size > 0;
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
      this.emptyCoverage.removeSatisfied(nominalResolutionMs, range);
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
        this.emptyCoverage.removeSatisfied(nominalResolutionMs, range);
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
    for (const request of this.inFlight.values()) {
      const overlap = intersect(request.range, range);
      if (overlap !== null) {
        out.push({ range: overlap, resolutionMs: request.maxDeltaTMs, state: "pending" });
      }
    }
    for (const failure of this.failures.values()) {
      const overlap = intersect(failure.range, range);
      if (overlap !== null) {
        out.push({
          range: overlap,
          resolutionMs: failure.maxDeltaTMs,
          state: "failed",
          message: failure.message,
        });
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
    for (const fn of this.subscribers) {
      try {
        fn();
      } catch (error) {
        // Subscriber/UI failures must never be reclassified as exchange
        // failures by requestFetch's network error path.
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

function inferNominalResolution(
  points: readonly PricePoint[],
  hint: number | undefined,
  fallback: number,
): number {
  const deltas: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const delta = points[i]!.t - points[i - 1]!.t;
    if (delta > 0 && Number.isFinite(delta)) deltas.push(delta);
  }
  if (deltas.length > 0) {
    deltas.sort((a, b) => a - b);
    // Lower median resists large market-closure gaps while staying entirely
    // derived from returned timestamps.
    return deltas[Math.floor((deltas.length - 1) / 2)]!;
  }
  if (hint !== undefined) {
    if (!(hint > 0) || !Number.isFinite(hint)) {
      throw new Error(`Fetcher returned invalid resolutionHintMs ${hint}`);
    }
    return hint;
  }
  return fallback;
}

function searchedRange(
  request: Range,
  result: FetchRangeResult,
  points: readonly PricePoint[],
  nominalResolutionMs: number,
): Range | null {
  if (result.searchedRange !== undefined) return intersect(result.searchedRange, request);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  const min = Math.max(request.min, first.t);
  const max = Math.min(request.max, last.t + nominalResolutionMs);
  return min < max ? Range.create(min, max) : null;
}

function requestKey(range: Range, maxDeltaTMs: number): string {
  return `${range.min}:${range.max}:${maxDeltaTMs}`;
}

function covers(outer: Range, inner: Range): boolean {
  return outer.min <= inner.min && outer.max >= inner.max;
}

function intersect(a: Range, b: Range): Range | null {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min < max ? Range.create(min, max) : null;
}
