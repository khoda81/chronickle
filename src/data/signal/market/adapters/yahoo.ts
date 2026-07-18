/** Interval-aware Yahoo Finance chart adapter for futures, equities, and indices. */

import { Interval, IntervalSet } from "../../../../core/interval.ts";
import type { Sample } from "../../sample.ts";
import {
  demandSampleSpacingMs,
  expandSignalRequest,
  nextSignalFutureStart,
  resolutionGaps,
  resolveSignalDemands,
  signalPollDelay,
  signalWorkIsWanted,
  type AdapterSession,
  type ResolvedSignalDemand,
  type SignalAdapter,
  type SignalDemand,
  type SignalSink,
} from "../../fetcher.ts";
import { sameSignalReports, type SignalReport } from "../../reports.ts";
import { logPriceSamples, type PricePoint } from "../price.ts";

const YAHOO_CHART_API = "https://query2.finance.yahoo.com/v8/finance/chart";
const CORS_PROXY = "https://corsproxy.io/?url=";
const DAY_MS = 86_400_000;
const MAX_CACHE_ENTRIES = 32;
const MIN_FETCH_POINTS = 128;
const PUBLICATION_GRACE_MS = 250;

interface YahooInterval {
  readonly periodMs: number;
  readonly interval: string;
  /** Maximum historical age supported by Yahoo for this interval. */
  readonly lookbackMs: number;
}

const YAHOO_LADDER: readonly YahooInterval[] = [
  { periodMs: 60_000, interval: "1m", lookbackMs: 8 * DAY_MS },
  { periodMs: 2 * 60_000, interval: "2m", lookbackMs: 60 * DAY_MS },
  { periodMs: 5 * 60_000, interval: "5m", lookbackMs: 60 * DAY_MS },
  { periodMs: 15 * 60_000, interval: "15m", lookbackMs: 60 * DAY_MS },
  { periodMs: 30 * 60_000, interval: "30m", lookbackMs: 60 * DAY_MS },
  { periodMs: 60 * 60_000, interval: "60m", lookbackMs: 730 * DAY_MS },
  { periodMs: DAY_MS, interval: "1d", lookbackMs: Number.POSITIVE_INFINITY },
  { periodMs: 7 * DAY_MS, interval: "1wk", lookbackMs: Number.POSITIVE_INFINITY },
];

export interface YahooAdapterOptions {
  readonly symbol: string;
  readonly timeoutMs?: number;
  readonly proxy?: string;
  readonly now?: () => number;
}

export function createYahooAdapter(opts: YahooAdapterOptions): SignalAdapter {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^=_-]{1,40}$/.test(symbol)) {
    throw new Error(`Invalid Yahoo Finance symbol: ${opts.symbol}`);
  }
  const state: YahooAdapterState = { cache: new Map(), pending: new Map(), generation: 0 };
  return { connect: (sink, signal) => new YahooSession(symbol, opts, state, sink, signal) };
}

interface YahooAdapterState {
  readonly cache: Map<string, CachedYahooResult>;
  readonly pending: Map<string, Promise<CachedYahooResult>>;
  generation: number;
}

interface YahooWork {
  readonly requiredRange: Interval;
  readonly requestRange: Interval;
  readonly resolutionMs: number;
  readonly attempt: number;
}

interface RunningWork {
  readonly state: "fetching";
  readonly work: YahooWork;
  readonly controller: AbortController;
}

interface FailedWork {
  readonly state: "failed";
  readonly work: YahooWork;
  readonly retryAtMs: number;
  readonly message: string;
}

type ActiveWork = RunningWork | FailedWork;

interface ScheduledReconcile {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly atMs: number;
}

class YahooSession implements AdapterSession {
  private demands: readonly ResolvedSignalDemand[] = [];
  private readonly coverage = new Map<number, IntervalSet>();
  private readonly livePollAt = new Map<number, number>();
  private active: ActiveWork | null = null;
  private scheduled: ScheduledReconcile | null = null;
  private sourceBackoffUntilMs: number | null = null;
  private sourceFailureReport: SignalReport | null = null;
  private reports: readonly SignalReport[] = [];

  constructor(
    private readonly symbol: string,
    private readonly opts: YahooAdapterOptions,
    private readonly adapterState: YahooAdapterState,
    private readonly sink: SignalSink,
    private readonly signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    signal.addEventListener("abort", this.close, { once: true });
  }

  setDemands(demands: readonly SignalDemand[]): void {
    this.signal.throwIfAborted();
    const now = this.now();
    this.demands = resolveSignalDemands(
      demands,
      demand => chooseInterval(demandSampleSpacingMs(demand), demand.range.start, now).periodMs,
    );
    this.reconcile();
  }

  clearCache(): void {
    this.signal.throwIfAborted();
    this.abortActive();
    this.coverage.clear();
    this.livePollAt.clear();
    this.sourceBackoffUntilMs = null;
    this.sourceFailureReport = null;
    this.adapterState.generation++;
    this.adapterState.cache.clear();
    this.adapterState.pending.clear();
    this.cancelScheduled();
    this.reconcile();
  }

  private close = (): void => {
    if (this.active?.state === "fetching") this.active.controller.abort();
    this.active = null;
    this.demands = [];
    this.cancelScheduled();
  };

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private reconcile = (): void => {
    if (this.signal.aborted) return;
    const now = this.now();

    if (this.active !== null) {
      if (
        !signalWorkIsWanted(
          this.demands,
          this.active.work.requiredRange,
          this.active.work.resolutionMs,
        )
      ) {
        this.abortActive();
      } else if (this.active.state === "fetching") {
        return;
      } else if (now < this.active.retryAtMs) {
        this.publishStateReports();
        this.schedule(this.active.retryAtMs);
        return;
      } else {
        const work = this.active.work;
        this.active = null;
        this.start(work);
        return;
      }
    }

    if (this.sourceBackoffUntilMs !== null) {
      if (now < this.sourceBackoffUntilMs) {
        this.publishStateReports();
        this.schedule(this.sourceBackoffUntilMs);
        return;
      }
      this.sourceBackoffUntilMs = null;
      this.sourceFailureReport = null;
    }

    const work = this.nextWork(now);
    if (work !== null) {
      this.start(work);
      return;
    }

    this.publishStateReports();
    const wakeAt = this.nextWake(now);
    if (wakeAt !== null) this.schedule(wakeAt);
  };

  private nextWork(now: number): YahooWork | null {
    for (const demand of this.demands) {
      const target = Interval.clampEnd(demand.range, now);
      if (Interval.isEmpty(target)) continue;
      const gaps = resolutionGaps(this.coverage, demand.resolutionMs, target);
      const isLive = Interval.contains(demand.range, now);
      if (isLive && now < (this.livePollAt.get(demand.resolutionMs) ?? -Infinity)) {
        const tail = gaps[gaps.length - 1];
        if (tail?.end === now) gaps.pop();
      }
      const requiredRange = isLive ? gaps[gaps.length - 1] : gaps[0];
      if (requiredRange === undefined) continue;
      return {
        requiredRange,
        requestRange: expandSignalRequest(
          requiredRange,
          demand.resolutionMs,
          now,
          MIN_FETCH_POINTS,
        ),
        resolutionMs: demand.resolutionMs,
        attempt: 0,
      };
    }
    return null;
  }

  private nextWake(now: number): number | null {
    let wakeAt = nextSignalFutureStart(this.demands, now);
    for (const demand of this.demands) {
      if (!Interval.contains(demand.range, now)) continue;
      let pollAt = this.livePollAt.get(demand.resolutionMs);
      if (pollAt === undefined) {
        pollAt = now + signalPollDelay(demand.resolutionMs);
        this.livePollAt.set(demand.resolutionMs, pollAt);
      }
      wakeAt = wakeAt === null ? pollAt : Math.min(wakeAt, pollAt);
    }
    return wakeAt;
  }

  private start(work: YahooWork): void {
    const running: RunningWork = { state: "fetching", work, controller: new AbortController() };
    this.active = running;
    this.publishStateReports();
    void this.run(running);
  }

  private async run(running: RunningWork): Promise<void> {
    try {
      const result = await this.fetch(running.work, running.controller.signal);
      if (this.signal.aborted || this.active !== running) return;
      this.coverageFor(running.work.resolutionMs).add(running.work.requestRange);
      this.sourceBackoffUntilMs = null;
      this.sourceFailureReport = null;
      this.updateLivePoll(running.work, result.samples);
      this.sink.next(result.samples);
      if (this.signal.aborted || this.active !== running) return;
      this.active = null;
      this.reconcile();
    } catch (error) {
      if (this.signal.aborted || this.active !== running) return;
      this.fail(running.work, error);
    }
  }

  private async fetch(work: YahooWork, signal: AbortSignal): Promise<CachedYahooResult> {
    const entry = YAHOO_LADDER.find(candidate => candidate.periodMs === work.resolutionMs)!;
    const startMs =
      Math.floor((work.requestRange.start - entry.periodMs) / entry.periodMs) * entry.periodMs;
    const roundedEndMs = Math.ceil(work.requestRange.end / entry.periodMs) * entry.periodMs;
    const endMs = Math.max(startMs + entry.periodMs, roundedEndMs);
    const key = `${entry.interval}:${startMs}:${endMs}`;
    const requestGeneration = this.adapterState.generation;
    const cached = this.adapterState.cache.get(key);
    if (cached !== undefined) return cached;

    let pending = this.adapterState.pending.get(key);
    if (pending === undefined) {
      pending = fetchYahooWindow(this.symbol, entry, startMs, endMs, this.opts, signal);
      this.adapterState.pending.set(key, pending);
    }
    try {
      const result = await pending;
      if (requestGeneration === this.adapterState.generation) {
        this.adapterState.cache.set(key, result);
        trimOldest(this.adapterState.cache, MAX_CACHE_ENTRIES);
      }
      return result;
    } finally {
      if (this.adapterState.pending.get(key) === pending) this.adapterState.pending.delete(key);
    }
  }

  private updateLivePoll(work: YahooWork, samples: readonly Sample[]): void {
    const now = this.now();
    if (
      !this.demands.some(
        demand => demand.resolutionMs === work.resolutionMs && Interval.contains(demand.range, now),
      )
    )
      return;
    const last = samples[samples.length - 1];
    const expectedNext = last === undefined ? null : last.t + work.resolutionMs;
    this.livePollAt.set(
      work.resolutionMs,
      expectedNext !== null && expectedNext > now
        ? expectedNext + PUBLICATION_GRACE_MS
        : now + signalPollDelay(work.resolutionMs),
    );
  }

  private fail(work: YahooWork, error: unknown): void {
    const attempt = work.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    const delay =
      error instanceof YahooHttpError && error.status === 429
        ? (error.retryAfterMs ?? Math.min(15 * 60_000, 60_000 * 2 ** (attempt - 1)))
        : Math.min(60_000, 2_000 * 2 ** (attempt - 1));
    const retryAtMs = this.now() + delay;
    const failed: FailedWork = { state: "failed", work: { ...work, attempt }, retryAtMs, message };
    this.active = failed;
    this.sourceBackoffUntilMs = retryAtMs;
    this.sourceFailureReport = {
      range: work.requestRange,
      kind: "error",
      message: `Yahoo: retrying after ${message}`,
    };
    this.publishStateReports();
    this.schedule(retryAtMs);
    this.sink.error(error);
  }

  private publishStateReports(): void {
    const reports: SignalReport[] =
      this.sourceFailureReport === null ? [] : [this.sourceFailureReport];
    if (this.active?.state === "fetching") {
      reports.push({
        range: this.active.work.requestRange,
        kind: "info",
        message: `Yahoo: fetching ${this.active.work.resolutionMs}ms candles`,
      });
    }
    if (sameSignalReports(reports, this.reports)) return;
    this.reports = reports;
    this.sink.setReports(reports);
  }

  private coverageFor(resolutionMs: number): IntervalSet {
    let coverage = this.coverage.get(resolutionMs);
    if (coverage === undefined) {
      coverage = new IntervalSet();
      this.coverage.set(resolutionMs, coverage);
    }
    return coverage;
  }

  private abortActive(): void {
    if (this.active?.state === "fetching") this.active.controller.abort();
    this.active = null;
    this.publishStateReports();
  }

  private schedule(atMs: number): void {
    if (!Number.isFinite(atMs)) return;
    if (this.scheduled !== null && this.scheduled.atMs <= atMs) return;
    this.cancelScheduled();
    this.scheduled = {
      atMs,
      handle: setTimeout(
        () => {
          this.scheduled = null;
          this.reconcile();
        },
        Math.max(0, atMs - this.now()),
      ),
    };
  }

  private cancelScheduled(): void {
    if (this.scheduled === null) return;
    clearTimeout(this.scheduled.handle);
    this.scheduled = null;
  }
}

async function fetchYahooWindow(
  symbol: string,
  entry: YahooInterval,
  startMs: number,
  endMs: number,
  opts: YahooAdapterOptions,
  signal: AbortSignal,
): Promise<CachedYahooResult> {
  const params = new URLSearchParams({
    period1: Math.floor(startMs / 1_000).toString(),
    period2: Math.ceil(endMs / 1_000).toString(),
    interval: entry.interval,
    events: "history",
    includeAdjustedClose: "false",
  });
  const target = `${YAHOO_CHART_API}/${encodeURIComponent(symbol)}?${params}`;
  const url = `${opts.proxy ?? CORS_PROXY}${encodeURIComponent(target)}`;
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]),
  });
  if (!response.ok) {
    throw new YahooHttpError(
      `Yahoo Finance chart failed: ${response.status} ${response.statusText}`,
      response.status,
      retryAfterMs(response.headers.get("retry-after")),
    );
  }
  const payload = (await response.json()) as YahooChartResponse;
  if (payload.chart?.error !== null && payload.chart?.error !== undefined) {
    const detail = payload.chart.error.description ?? payload.chart.error.code ?? "unknown error";
    const rateLimited = /rate|too many/i.test(detail);
    throw new YahooHttpError(
      `Yahoo Finance chart failed: ${detail}`,
      rateLimited ? 429 : 500,
      null,
    );
  }
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const opens = result?.indicators?.quote?.[0]?.open;
  if (!Array.isArray(timestamps) || !Array.isArray(opens)) {
    throw new Error("Yahoo Finance chart returned no timestamp/open arrays");
  }

  const points: PricePoint[] = [];
  const count = Math.min(timestamps.length, opens.length);
  for (let index = 0; index < count; index++) {
    const seconds = timestamps[index];
    const price = opens[index];
    if (
      typeof seconds === "number" &&
      typeof price === "number" &&
      Number.isFinite(seconds) &&
      Number.isFinite(price) &&
      price > 0
    ) {
      points.push({ t: seconds * 1_000, price });
    }
  }
  return { samples: logPriceSamples(points) };
}

interface CachedYahooResult {
  readonly samples: readonly Sample[];
}

class YahooHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "YahooHttpError";
  }
}

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function trimOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

export function chooseYahooInterval(
  maxDeltaTMs: number,
  rangeMin: number,
  now: number,
): { readonly periodMs: number; readonly interval: string } {
  const entry = chooseInterval(maxDeltaTMs, rangeMin, now);
  return { periodMs: entry.periodMs, interval: entry.interval };
}

function chooseInterval(maxDeltaTMs: number, rangeMin: number, now: number): YahooInterval {
  const eligible = YAHOO_LADDER.filter(candidate => now - rangeMin <= candidate.lookbackMs);
  // Daily and weekly history have no lookback limit, so this is structurally
  // non-empty. Start with the finest available interval as the best effort
  // when even it is coarser than the viewport asks for.
  let selected = eligible[0]!;
  for (const candidate of eligible) {
    if (candidate.periodMs > maxDeltaTMs) break;
    selected = candidate;
  }
  return selected;
}

interface YahooChartResponse {
  readonly chart?: {
    readonly result?:
      | readonly {
          readonly timestamp?: readonly number[];
          readonly indicators?: {
            readonly quote?: readonly { readonly open?: readonly (number | null)[] }[];
          };
        }[]
      | null;
    readonly error?: { readonly code?: string; readonly description?: string } | null;
  };
}
