/** Binance kline adapter. Binance owns its request, coverage, retry, and live state. */

import { Interval, IntervalSet } from "../../../../core/interval.ts";
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
import { pickResolution } from "../../resolution.ts";
import type { Sample } from "../../sample.ts";
import { logPriceSamples, type PricePoint } from "../price.ts";

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const LIMIT = 1_000;
const MIN_FETCH_POINTS = 256;
const PUBLICATION_GRACE_MS = 250;

const BINANCE_LADDER: readonly { readonly periodMs: number; readonly interval: string }[] = [
  { periodMs: 60_000, interval: "1m" },
  { periodMs: 3 * 60_000, interval: "3m" },
  { periodMs: 5 * 60_000, interval: "5m" },
  { periodMs: 15 * 60_000, interval: "15m" },
  { periodMs: 30 * 60_000, interval: "30m" },
  { periodMs: 60 * 60_000, interval: "1h" },
  { periodMs: 2 * 60 * 60_000, interval: "2h" },
  { periodMs: 4 * 60 * 60_000, interval: "4h" },
  { periodMs: 6 * 60 * 60_000, interval: "6h" },
  { periodMs: 8 * 60 * 60_000, interval: "8h" },
  { periodMs: 12 * 60 * 60_000, interval: "12h" },
  { periodMs: 24 * 60 * 60_000, interval: "1d" },
  { periodMs: 3 * 24 * 60 * 60_000, interval: "3d" },
  { periodMs: 7 * 24 * 60 * 60_000, interval: "1w" },
];

const PERIODS = BINANCE_LADDER.map(entry => entry.periodMs);

export interface BinanceAdapterOptions {
  readonly symbol: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface BinanceWork {
  readonly requiredRange: Interval;
  readonly requestRange: Interval;
  readonly resolutionMs: number;
  readonly attempt: number;
}

interface RunningWork {
  readonly state: "fetching";
  readonly work: BinanceWork;
  readonly controller: AbortController;
}

interface FailedWork {
  readonly state: "failed";
  readonly work: BinanceWork;
  readonly retryAtMs: number;
  readonly message: string;
}

type ActiveWork = RunningWork | FailedWork;

interface ScheduledReconcile {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly atMs: number;
}

interface BinanceBatch {
  readonly samples: readonly Sample[];
  readonly searchedRange: Interval;
}

export function createBinanceAdapter(opts: BinanceAdapterOptions): SignalAdapter {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/.test(symbol)) {
    throw new Error(`Invalid Binance symbol: ${opts.symbol}`);
  }
  return { connect: (sink, signal) => new BinanceSession(symbol, opts, sink, signal) };
}

class BinanceSession implements AdapterSession {
  private demands: readonly ResolvedSignalDemand[] = [];
  private readonly coverage = new Map<number, IntervalSet>();
  private readonly livePollAt = new Map<number, number>();
  private active: ActiveWork | null = null;
  private scheduled: ScheduledReconcile | null = null;
  private reports: readonly SignalReport[] = [];

  constructor(
    private readonly symbol: string,
    private readonly opts: BinanceAdapterOptions,
    private readonly sink: SignalSink,
    private readonly signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    signal.addEventListener("abort", this.close, { once: true });
  }

  setDemands(demands: readonly SignalDemand[]): void {
    this.signal.throwIfAborted();
    this.demands = resolveSignalDemands(demands, demand =>
      pickResolution(PERIODS, demandSampleSpacingMs(demand)),
    );
    this.reconcile();
  }

  clearCache(): void {
    this.signal.throwIfAborted();
    this.abortActive();
    this.coverage.clear();
    this.livePollAt.clear();
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
        this.schedule(this.active.retryAtMs);
        return;
      } else {
        const work = this.active.work;
        this.active = null;
        this.start(work);
        return;
      }
    }

    const work = this.nextWork(now);
    if (work !== null) {
      this.start(work);
      return;
    }

    this.publishReports([]);
    const wakeAt = this.nextWake(now);
    if (wakeAt !== null) this.schedule(wakeAt);
  };

  private nextWork(now: number): BinanceWork | null {
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

  private start(work: BinanceWork): void {
    const running: RunningWork = { state: "fetching", work, controller: new AbortController() };
    this.active = running;
    this.publishReports([
      {
        range: work.requestRange,
        kind: "info",
        message: `Binance: fetching ${work.resolutionMs}ms candles`,
      },
    ]);
    void this.run(running);
  }

  private async run(running: RunningWork): Promise<void> {
    try {
      const batch = await this.fetch(running.work, running.controller.signal);
      if (this.signal.aborted || this.active !== running) return;
      this.coverageFor(running.work.resolutionMs).add(batch.searchedRange);
      this.updateLivePoll(running.work, batch.samples);
      this.sink.next(batch.samples);
      if (this.signal.aborted || this.active !== running) return;
      this.active = null;
      this.reconcile();
    } catch (error) {
      if (this.signal.aborted || this.active !== running) return;
      this.fail(running.work, error);
    }
  }

  private async fetch(work: BinanceWork, signal: AbortSignal): Promise<BinanceBatch> {
    const entry = BINANCE_LADDER.find(candidate => candidate.periodMs === work.resolutionMs)!;
    const params = new URLSearchParams({
      symbol: this.symbol,
      interval: entry.interval,
      startTime: Math.floor(work.requestRange.start - work.resolutionMs).toString(),
      endTime: Math.floor(work.requestRange.end).toString(),
      limit: LIMIT.toString(),
    });
    const response = await fetch(`${BINANCE_KLINES}?${params}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs ?? 15_000)]),
    });
    if (!response.ok) {
      throw new Error(`Binance klines failed: ${response.status} ${response.statusText}`);
    }
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) throw new Error("Binance klines returned a non-array payload");

    const points: PricePoint[] = [];
    for (const row of raw) {
      if (!Array.isArray(row)) continue;
      const t = Number(row[0]);
      const price = Number(row[1]);
      if (Number.isFinite(t) && Number.isFinite(price) && price > 0) points.push({ t, price });
    }

    let searchedRange = work.requestRange;
    const last = points[points.length - 1];
    if (raw.length >= LIMIT && last !== undefined) {
      const searchedEnd = Math.min(work.requestRange.end, last.t + work.resolutionMs);
      if (searchedEnd > work.requestRange.start) {
        searchedRange = Interval.create(work.requestRange.start, searchedEnd);
      }
    }
    return { samples: logPriceSamples(points), searchedRange };
  }

  private updateLivePoll(work: BinanceWork, samples: readonly Sample[]): void {
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

  private fail(work: BinanceWork, error: unknown): void {
    const attempt = work.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    const delay =
      message.includes("429") || message.includes("418")
        ? 60_000
        : Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    const failed: FailedWork = {
      state: "failed",
      work: { ...work, attempt },
      retryAtMs: this.now() + delay,
      message,
    };
    this.active = failed;
    this.publishReports([
      { range: work.requestRange, kind: "error", message: `Binance: retrying after ${message}` },
    ]);
    this.schedule(failed.retryAtMs);
    this.sink.error(error);
  }

  private coverageFor(resolutionMs: number): IntervalSet {
    let coverage = this.coverage.get(resolutionMs);
    if (coverage === undefined) {
      coverage = new IntervalSet();
      this.coverage.set(resolutionMs, coverage);
    }
    return coverage;
  }

  private publishReports(reports: readonly SignalReport[]): void {
    if (sameSignalReports(reports, this.reports)) return;
    this.reports = reports;
    this.sink.setReports(reports);
  }

  private abortActive(): void {
    if (this.active?.state === "fetching") this.active.controller.abort();
    this.active = null;
    this.publishReports([]);
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
