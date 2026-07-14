/** Evidence-backed, resolution-aware price broker. */

import { PriceSeries, type PricePoint } from "../../domain.ts";
import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";
import { CoverageIndex, type ResolutionSegment } from "./coverage.ts";
import type { Fetcher, FetchRangeResult } from "./fetcher.ts";
import { evaluateStaircase, type StaircaseResult } from "./staircase.ts";
import { ChunkedLevelStore } from "./store.ts";

export type QueryStatus = "complete" | "partial" | "empty";

export interface QueryResult extends StaircaseResult {
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

export interface EnsureOptions {
  readonly range: Range;
  readonly maxDeltaTMs: number;
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

type RequestLifecycle =
  | { readonly kind: "fetching"; readonly request: RequestState; readonly attempt: number }
  | {
      readonly kind: "backoff";
      readonly request: RequestState;
      readonly attempt: number;
      readonly message: string;
      readonly retryAt: number;
      readonly timer: number;
    }
  | { readonly kind: "retryable"; readonly attempt: number };

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
  private readonly stores = new Map<number, ChunkedLevelStore>();
  private readonly coverage = new CoverageIndex();
  private readonly subscribers = new Set<() => void>();
  private readonly requests = new Map<string, RequestLifecycle>();
  private liveRefresh: LiveRefresh | null = null;
  private readonly now: () => number;
  private readonly defaultRetryDelayMs: (attempt: number) => number;
  private readonly onError: (message: string, error?: unknown) => void;
  private readonly onWarning: (message: string) => void;
  private generation = 0;
  private revision = 0;
  private wantedResolution: Float64Array = new Float64Array(0);

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
   * Compatibility façade for the original unidirectional UI flow: synchronously
   * sample current cache contents and independently schedule missing coverage.
   */
  query(opts: QueryOptions): QueryResult {
    validateResolution(opts.maxDeltaTMs, "Broker.query");
    const wallNow = this.now();
    const range = rangeOf(opts.evalTime);
    if (range !== null) this.ensureAt(range, opts.maxDeltaTMs, wallNow);
    return this.sampleAt(opts, wallNow);
  }

  /** Declare data demand without reading or allocating a sampled result. */
  ensure(opts: EnsureOptions): void {
    validateResolution(opts.maxDeltaTMs, "Broker.ensure");
    this.ensureAt(opts.range, opts.maxDeltaTMs, this.now());
  }

  /** Read current cache contents without starting requests or changing demand. */
  sample(opts: QueryOptions): QueryResult {
    validateResolution(opts.maxDeltaTMs, "Broker.sample");
    return this.sampleAt(opts, this.now());
  }

  private ensureAt(range: Range, maxDeltaTMs: number, wallNow: number): void {
    const historicalRange = clampToNow(range, wallNow);
    if (historicalRange !== null) this.planRequests(historicalRange, maxDeltaTMs);
  }

  private sampleAt(opts: QueryOptions, wallNow: number): QueryResult {
    const { evalTime, maxDeltaTMs } = opts;
    const value = new Float64Array(evalTime.length);
    value.fill(NaN);
    const queryRange = rangeOf(evalTime);
    if (queryRange === null) {
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

    const historicalRange = clampToNow(queryRange, wallNow);
    this.wantedResolution = this.coverage.resolve(evalTime, maxDeltaTMs, this.wantedResolution);
    const wantedResolution = this.wantedResolution;
    for (const [resolutionMs, store] of this.stores) {
      const sampled = evaluateStaircase(store.chunks, evalTime).value;
      for (let i = 0; i < evalTime.length; i++) {
        if (
          evalTime[i]! > wallNow ||
          wantedResolution[i] !== resolutionMs ||
          !Number.isFinite(sampled[i]!)
        ) {
          continue;
        }
        value[i] = sampled[i]!;
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
    for (const item of value) if (Number.isFinite(item)) finiteCount++;

    const unresolved =
      historicalRange === null ? [] : this.unresolved(historicalRange, maxDeltaTMs);
    const status: QueryStatus =
      finiteCount === 0 ? "empty" : unresolved.length === 0 ? "complete" : "partial";
    const resolution =
      historicalRange === null
        ? []
        : [
            ...this.coverage.segments(historicalRange, maxDeltaTMs),
            ...this.transientSegments(historicalRange),
          ].sort((a, b) => b.resolutionMs - a.resolutionMs || a.range.min - b.range.min);

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

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    this.armLiveRefresh();
    return () => this.subscribers.delete(fn);
  }

  dispose(): void {
    this.generation++;
    this.clearRequestLifecycle();
    this.clearLiveRefresh();
    this.subscribers.clear();
  }

  /** Drop all observations/request state and ignore responses from the old generation. */
  clearCache(): void {
    this.generation++;
    this.fetcher.clearCache?.();
    this.stores.clear();
    this.coverage.clear();
    this.clearRequestLifecycle();
    this.clearLiveRefresh();
    this.revision++;
    this.notify();
  }

  cachedRange(): Range | null {
    let min = Infinity;
    let max = -Infinity;
    for (const store of this.stores.values()) {
      const range = store.timeRange();
      if (range === null) continue;
      min = Math.min(min, range.min);
      max = Math.max(max, range.max);
    }
    return min < max ? Range.create(min, max) : null;
  }

  private planRequests(range: Range, maxDeltaTMs: number): void {
    // The overwhelmingly common steady-state path is already answered by one
    // ready level. Avoid constructing and merging a temporary RangeSet on
    // every animation frame in that case.
    if (this.coverage.answers(range, maxDeltaTMs) || this.transientlyBlocks(range, maxDeltaTMs)) {
      return;
    }
    const blocked = this.blockers(range, maxDeltaTMs);
    for (const gap of blocked.gaps(range)) void this.requestFetch(gap, maxDeltaTMs);
  }

  private transientlyBlocks(range: Range, maxDeltaTMs: number): boolean {
    if (this.fetcher.serializeRequests === true && this.hasRequestKind("fetching")) return true;
    for (const lifecycle of this.requests.values()) {
      if (
        lifecycle.kind === "fetching" &&
        lifecycle.request.maxDeltaTMs <= maxDeltaTMs &&
        covers(lifecycle.request.range, range)
      ) {
        return true;
      }
    }
    if (this.fetcher.sourceWideBackoff === true && this.hasRequestKind("backoff")) return true;
    for (const lifecycle of this.requests.values()) {
      if (lifecycle.kind === "backoff" && covers(lifecycle.request.range, range)) return true;
    }
    return false;
  }

  private blockers(range: Range, maxDeltaTMs: number): RangeSet {
    const blocked = new RangeSet();
    this.coverage.addReadyBlockers(blocked, maxDeltaTMs, range);
    this.coverage.addEmptyBlockers(blocked, maxDeltaTMs, range);
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
    if (this.fetcher.serializeRequests === true && this.hasRequestKind("fetching")) {
      blocked.add(range);
    } else {
      for (const lifecycle of this.requests.values()) {
        if (lifecycle.kind !== "fetching") continue;
        const request = lifecycle.request;
        if (request.maxDeltaTMs > maxDeltaTMs) continue;
        const overlap = intersect(request.range, range);
        if (overlap !== null) blocked.add(overlap);
      }
    }
    // A failed exchange call suppresses all qualities briefly; the adapter
    // controls how long through retryDelayMs().
    if (this.fetcher.sourceWideBackoff === true && this.hasRequestKind("backoff")) {
      blocked.add(range);
    } else {
      for (const lifecycle of this.requests.values()) {
        if (lifecycle.kind !== "backoff") continue;
        const overlap = intersect(lifecycle.request.range, range);
        if (overlap !== null) blocked.add(overlap);
      }
    }
    return blocked;
  }

  private unresolved(range: Range, maxDeltaTMs: number): readonly Range[] {
    if (this.coverage.answers(range, maxDeltaTMs)) return [];
    const answered = new RangeSet();
    this.coverage.addReadyBlockers(answered, maxDeltaTMs, range);
    this.coverage.addEmptyBlockers(answered, maxDeltaTMs, range);
    return answered.gaps(range);
  }

  private async requestFetch(range: Range, maxDeltaTMs: number): Promise<void> {
    if (this.fetcher.serializeRequests === true && this.hasRequestKind("fetching")) return;
    if (this.fetcher.sourceWideBackoff === true && this.hasRequestKind("backoff")) return;
    const key = requestKey(range, maxDeltaTMs);
    const previous = this.requests.get(key);
    if (previous?.kind === "fetching" || previous?.kind === "backoff") return;
    const priorAttempt = previous?.kind === "retryable" ? previous.attempt : 0;
    const startedAt = this.now();
    const request: RequestState = {
      range,
      maxDeltaTMs,
      liveEdge: startedAt >= range.max && startedAt - range.max <= LIVE_EDGE_SLOP_MS,
    };
    const lifecycle: RequestLifecycle = { kind: "fetching", request, attempt: priorAttempt };
    const generation = this.generation;
    this.requests.set(key, lifecycle);
    let notifyAfterRequest = false;

    try {
      const result = await this.fetcher.fetchRange(request);
      if (generation !== this.generation) return;
      const liveRefresh = this.ingest(request, result);
      if (liveRefresh !== null) this.setLiveRefresh(liveRefresh);
      this.revision++;
      notifyAfterRequest = true;
    } catch (error) {
      if (generation !== this.generation) return;
      this.onError(`[Broker] fetch failed for ${range.min}..${range.max}`, error);
      const attempt = priorAttempt + 1;
      const proposed =
        this.fetcher.retryDelayMs?.(error, attempt) ?? this.defaultRetryDelayMs(attempt);
      const validPolicy = proposed >= 0 && Number.isFinite(proposed);
      if (!validPolicy) this.onError(`[Broker] invalid retry delay ${proposed}; using default`);
      const delay = Math.max(100, validPolicy ? proposed : DEFAULT_RETRY(attempt));
      const retryAt = this.now() + delay;
      const message = error instanceof Error ? error.message : String(error);
      const timer = setTimeout(() => {
        const current = this.requests.get(key);
        if (current?.kind !== "backoff" || current.retryAt !== retryAt) return;
        this.requests.set(key, { kind: "retryable", attempt });
        this.revision++;
        this.notify();
      }, delay) as unknown as number;
      this.requests.set(key, {
        kind: "backoff",
        request,
        attempt,
        message,
        retryAt,
        timer,
      });
      this.revision++;
      notifyAfterRequest = true;
    } finally {
      if (this.requests.get(key) === lifecycle) this.requests.delete(key);
      if (notifyAfterRequest) this.notify();
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
    this.coverage.addReadyBlockers(observed, request.maxDeltaTMs, searched);
    for (const gap of observed.gaps(searched)) {
      this.coverage.addEmpty(request.maxDeltaTMs, gap);
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
    if (refresh === null || refresh.timer !== null || this.subscribers.size === 0) return;
    const delay = Math.max(0, refresh.at - this.now());
    refresh.timer = setTimeout(() => {
      if (this.liveRefresh !== refresh) return;
      this.liveRefresh = null;
      this.notify();
    }, delay) as unknown as number;
  }

  private clearLiveRefresh(): void {
    const refresh = this.liveRefresh;
    if (refresh?.timer !== null && refresh?.timer !== undefined) clearTimeout(refresh.timer);
    this.liveRefresh = null;
  }

  private ingestObserved(
    points: readonly PricePoint[],
    nominalResolutionMs: number,
    observedThroughMs: number,
    searchedThroughRequestEnd: boolean,
  ): void {
    const buckets = new Map<number, PricePoint[]>();
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1]!;
      const current = points[i]!;
      const observedDelta = current.t - previous.t;
      if (observedDelta > 0) {
        this.coverage.addReady(observedDelta, Range.create(previous.t, current.t));
        appendPoint(buckets, observedDelta, previous);
        appendPoint(buckets, observedDelta, current);
      }
    }
    const last = points[points.length - 1];
    if (last !== undefined) {
      const expectedUntil = last.t + nominalResolutionMs;
      const heldUntil = searchedThroughRequestEnd
        ? expectedUntil
        : Math.min(expectedUntil, observedThroughMs);
      if (last.t < heldUntil) {
        this.coverage.addReady(nominalResolutionMs, Range.create(last.t, heldUntil));
      }
      appendPoint(buckets, nominalResolutionMs, last);
    }

    for (const [resolutionMs, bucket] of buckets) {
      const time = new Float64Array(bucket.length);
      const logPrice = new Float64Array(bucket.length);
      for (let i = 0; i < bucket.length; i++) {
        time[i] = bucket[i]!.t;
        logPrice[i] = Math.log(bucket[i]!.price);
      }
      this.levelStore(resolutionMs).insertBatch(time, logPrice);
    }
  }

  private levelStore(resolutionMs: number): ChunkedLevelStore {
    let store = this.stores.get(resolutionMs);
    if (store === undefined) {
      store = new ChunkedLevelStore();
      this.stores.set(resolutionMs, store);
    }
    return store;
  }

  private transientSegments(range: Range): ResolutionSegment[] {
    const out: ResolutionSegment[] = [];
    for (const lifecycle of this.requests.values()) {
      if (lifecycle.kind === "retryable") continue;
      const overlap = intersect(lifecycle.request.range, range);
      if (overlap === null) continue;
      if (lifecycle.kind === "fetching") {
        out.push({
          range: overlap,
          resolutionMs: lifecycle.request.maxDeltaTMs,
          state: "pending",
        });
      } else {
        out.push({
          range: overlap,
          resolutionMs: lifecycle.request.maxDeltaTMs,
          state: "failed",
          message: lifecycle.message,
        });
      }
    }
    return out;
  }

  private hasRequestKind(kind: "fetching" | "backoff"): boolean {
    for (const lifecycle of this.requests.values()) {
      if (lifecycle.kind === kind) return true;
    }
    return false;
  }

  private clearRequestLifecycle(): void {
    for (const lifecycle of this.requests.values()) {
      if (lifecycle.kind === "backoff") clearTimeout(lifecycle.timer);
    }
    this.requests.clear();
  }

  private notify(): void {
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

function validateResolution(maxDeltaTMs: number, owner: string): void {
  if (!(maxDeltaTMs > 0) || !Number.isFinite(maxDeltaTMs)) {
    throw new Error(`${owner}: invalid maxDeltaTMs ${maxDeltaTMs}`);
  }
}

function rangeOf(evalTime: Float64Array): Range | null {
  if (evalTime.length < 2) return null;
  return Range.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
}

function appendPoint(
  buckets: Map<number, PricePoint[]>,
  resolutionMs: number,
  point: PricePoint,
): void {
  let bucket = buckets.get(resolutionMs);
  if (bucket === undefined) {
    bucket = [];
    buckets.set(resolutionMs, bucket);
  }
  const last = bucket[bucket.length - 1];
  if (last?.t === point.t) bucket[bucket.length - 1] = point;
  else bucket.push(point);
}

function clampToNow(range: Range, now: number): Range | null {
  if (!Number.isFinite(now)) throw new Error(`Broker: invalid wall clock ${now}`);
  const max = Math.min(range.max, now);
  return range.min < max ? Range.create(range.min, max) : null;
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
