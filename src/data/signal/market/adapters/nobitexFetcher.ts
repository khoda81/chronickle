/** Nobitex adapter with source-owned fallback, coverage, retry, and live state. */

import { Interval, IntervalSet } from "../../../../core/interval.ts";
import {
  demandSampleSpacingMs,
  expandSignalRequest,
  nextSignalFutureStart,
  resolutionGaps,
  resolveSignalDemands,
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
import { fetchOhlc, ohlcToLogPriceSamples } from "./nobitex.ts";

const SECONDE = 1_000;
const MINUTE = 60 * SECONDE;
const HOUR = 60 * MINUTE;
const RESPONSE_LIMIT = 500;
const MIN_FETCH_POINTS = 256;
const LIVE_POLL_DELAY_MS = 1_000;
const PUBLICATION_GRACE_MS = 250;
/** A fine `no_data` response is ambiguous, so it is negative-cached only briefly. */
const FALLBACK_RETRY_MS = 60_000;

type NobitexResolution = "1" | "5" | "15" | "30" | "60" | "180" | "240" | "360" | "720" | "D" | "2D" | "3D";

const DAY = HOUR * 24;
const NOBITEX_LADDER: readonly { readonly periodMs: number; readonly resolution: NobitexResolution }[] = [
  { periodMs: MINUTE, resolution: "1" },
  { periodMs: MINUTE * 5, resolution: "5" },
  { periodMs: MINUTE * 15, resolution: "15" },
  { periodMs: MINUTE * 30, resolution: "30" },
  { periodMs: HOUR, resolution: "60" },
  { periodMs: HOUR * 3, resolution: "180" },
  { periodMs: HOUR * 4, resolution: "240" },
  { periodMs: HOUR * 6, resolution: "360" },
  { periodMs: HOUR * 12, resolution: "720" },
  { periodMs: DAY, resolution: "D" },
  { periodMs: DAY * 2, resolution: "2D" },
  { periodMs: DAY * 3, resolution: "3D" },
];

const PERIODS = NOBITEX_LADDER.map(entry => entry.periodMs);

export interface NobitexAdapterOptions {
  readonly symbol?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

interface NobitexWork {
  readonly requiredRange: Interval;
  readonly requestRange: Interval;
  readonly resolutionMs: number;
  readonly attempt: number;
}

interface RunningWork {
  readonly state: "fetching";
  readonly work: NobitexWork;
  readonly controller: AbortController;
}

interface FailedWork {
  readonly state: "failed";
  readonly work: NobitexWork;
  readonly retryAtMs: number;
  readonly message: string;
}

type ActiveWork = RunningWork | FailedWork;

interface UnavailableRange {
  readonly resolutionMs: number;
  readonly range: Interval;
  readonly retryAtMs: number;
  readonly fallbackResolutionMs: number;
}

interface NobitexBatch {
  readonly samples: readonly Sample[];
  readonly searchedRange: Interval;
  readonly actualResolutionMs: number;
  readonly unavailableResolutions: readonly number[];
}

interface ScheduledReconcile {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly atMs: number;
}

export function createNobitexAdapter(opts: NobitexAdapterOptions = {}): SignalAdapter {
  return { connect: (sink, signal) => new NobitexSession(opts, sink, signal) };
}

class NobitexSession implements AdapterSession {
  private readonly symbol: string;
  private demands: readonly ResolvedSignalDemand[] = [];
  private readonly coverage = new Map<number, IntervalSet>();
  private readonly livePollAt = new Map<number, number>();
  private unavailable: UnavailableRange[] = [];
  private active: ActiveWork | null = null;
  private scheduled: ScheduledReconcile | null = null;
  private reports: readonly SignalReport[] = [];

  constructor(
    private readonly opts: NobitexAdapterOptions,
    private readonly sink: SignalSink,
    private readonly signal: AbortSignal,
  ) {
    this.symbol = opts.symbol ?? "USDTIRT";
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
    this.unavailable = [];
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
    this.unavailable = this.unavailable.filter(entry => entry.retryAtMs > now);

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

    const work = this.nextWork(now);
    if (work !== null) {
      this.start(work);
      return;
    }

    this.publishStateReports();
    const wakeAt = this.nextWake(now);
    if (wakeAt !== null) this.schedule(wakeAt);
  };

  private nextWork(now: number): NobitexWork | null {
    for (const demand of this.demands) {
      const target = Interval.clampEnd(demand.range, now);
      if (Interval.isEmpty(target)) continue;
      const unavailable = this.unavailable
        .filter(entry => entry.resolutionMs === demand.resolutionMs)
        .map(entry => entry.range);
      const gaps = resolutionGaps(this.coverage, demand.resolutionMs, target, unavailable);
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
      for (const entry of this.unavailable) {
        if (
          entry.resolutionMs === demand.resolutionMs &&
          Interval.overlaps(entry.range, demand.range)
        ) {
          wakeAt = wakeAt === null ? entry.retryAtMs : Math.min(wakeAt, entry.retryAtMs);
        }
      }
      if (!Interval.contains(demand.range, now)) continue;
      let pollAt = this.livePollAt.get(demand.resolutionMs);
      if (pollAt === undefined) {
        pollAt = now + LIVE_POLL_DELAY_MS;
        this.livePollAt.set(demand.resolutionMs, pollAt);
      }
      wakeAt = wakeAt === null ? pollAt : Math.min(wakeAt, pollAt);
    }
    return wakeAt;
  }

  private start(work: NobitexWork): void {
    const running: RunningWork = { state: "fetching", work, controller: new AbortController() };
    this.active = running;
    this.publishStateReports();
    void this.run(running);
  }

  private async run(running: RunningWork): Promise<void> {
    try {
      const batch = await this.fetch(running.work, running.controller.signal);
      if (this.signal.aborted || this.active !== running) return;
      this.coverageFor(batch.actualResolutionMs).add(batch.searchedRange);
      const retryAtMs = this.now() + FALLBACK_RETRY_MS;
      for (const resolutionMs of batch.unavailableResolutions) {
        this.unavailable.push({
          resolutionMs,
          range: batch.searchedRange,
          retryAtMs,
          fallbackResolutionMs: batch.actualResolutionMs,
        });
      }
      this.updateLivePoll(running.work, batch);
      this.sink.next(batch.samples);
      if (this.signal.aborted || this.active !== running) return;
      this.active = null;
      this.reconcile();
    } catch (error) {
      if (this.signal.aborted || this.active !== running) return;
      this.fail(running.work, error);
    }
  }

  private async fetch(work: NobitexWork, signal: AbortSignal): Promise<NobitexBatch> {
    const requestedIndex = NOBITEX_LADDER.findIndex(entry => entry.periodMs === work.resolutionMs);
    const unavailableResolutions: number[] = [];

    for (let index = requestedIndex; index < NOBITEX_LADDER.length; index++) {
      const { resolution, periodMs } = NOBITEX_LADDER[index]!;
      const response = await fetchOhlc({
        symbol: this.symbol,
        resolution,
        fromMs: work.requestRange.start - periodMs,
        toMs: work.requestRange.end,
        timeoutMs: this.opts.timeoutMs,
        signal,
      });
      const samples = ohlcToLogPriceSamples(response);
      if (samples.length === 0) {
        unavailableResolutions.push(periodMs);
        continue;
      }

      const searchedRange =
        response !== null && response.t.length >= RESPONSE_LIMIT
          ? Interval.clampStart(work.requestRange, samples[0]!.t)
          : work.requestRange;
      if (Interval.isEmpty(searchedRange)) {
        throw new Error(
          `Nobitex returned ${samples.length} candles outside ${work.requestRange.start}..${work.requestRange.end}`,
        );
      }
      return { samples, searchedRange, actualResolutionMs: periodMs, unavailableResolutions };
    }

    return {
      samples: [],
      searchedRange: work.requestRange,
      actualResolutionMs: work.resolutionMs,
      unavailableResolutions: [],
    };
  }

  private updateLivePoll(work: NobitexWork, batch: NobitexBatch): void {
    const now = this.now();
    if (
      !this.demands.some(
        demand => demand.resolutionMs === work.resolutionMs && Interval.contains(demand.range, now),
      )
    )
      return;
    const last = batch.samples[batch.samples.length - 1];
    const expectedNext = last === undefined ? null : last.t + batch.actualResolutionMs;
    this.livePollAt.set(
      work.resolutionMs,
      expectedNext !== null && expectedNext > now
        ? expectedNext + PUBLICATION_GRACE_MS
        : now + LIVE_POLL_DELAY_MS,
    );
  }

  private fail(work: NobitexWork, error: unknown): void {
    const attempt = work.attempt + 1;
    const message = error instanceof Error ? error.message : String(error);
    const failed: FailedWork = {
      state: "failed",
      work: { ...work, attempt },
      retryAtMs: this.now() + Math.min(60_000, 2_000 * 2 ** (attempt - 1)),
      message,
    };
    this.active = failed;
    this.publishStateReports();
    this.schedule(failed.retryAtMs);
    this.sink.error(error);
  }

  private publishStateReports(): void {
    const reports: SignalReport[] = this.unavailable.map(entry => ({
      range: entry.range,
      kind: "warn",
      message: `Nobitex: ${entry.resolutionMs}ms unavailable; using ${entry.fallbackResolutionMs}ms`,
    }));
    if (this.active !== null) {
      reports.push({
        range: this.active.work.requestRange,
        kind: this.active.state === "fetching" ? "info" : "error",
        message:
          this.active.state === "fetching"
            ? `Nobitex: fetching ${this.active.work.resolutionMs}ms candles`
            : `Nobitex: retrying after ${this.active.message}`,
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
