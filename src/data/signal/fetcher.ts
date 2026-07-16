/** Demand-aware adapter scheduling for sampled real-valued time series. */

import { Interval, IntervalSet } from "../../core/interval.ts";
import { BrokerDemand } from "./broker.ts";
import type { Sample } from "./sample.ts";

/** Concrete source request after native resolution selection and range expansion. */
export interface AdapterPlan {
  readonly range: Interval;
  readonly resolutionMs: number;
}

export interface AdapterBatch {
  /** Canonical observations in epoch milliseconds. */
  readonly samples: readonly Sample[];
  /** Everything searched by the source, which may be wider than requested. */
  readonly searchedInterval: Interval;
}

/** A cache delivery is self-describing and independent of a broker request. */
export interface AdapterDelivery extends AdapterBatch {
  readonly resolutionMs: number;
}

interface AcquisitionActivityBase {
  readonly range: Interval;
  readonly resolutionMs: number;
}

export type AcquisitionActivity =
  | (AcquisitionActivityBase & { readonly state: "fetching" | "watching" })
  | (AcquisitionActivityBase & {
    readonly state: "failed";
    readonly message: string;
    readonly retryAtMs: number;
  });

export interface SignalSink {
  next(batch: AdapterDelivery): void;
  status(activities: readonly AcquisitionActivity[]): void;
  error(error: unknown, activity: Extract<AcquisitionActivity, { readonly state: "failed" }>): void;
}

/** One long-lived acquisition session per broker/source. */
export interface AdapterSession {
  setDemands(demands: readonly BrokerDemand[]): void;
  clearCache(): void;
  dispose(): void;
}

/**
 * The broker describes current interest. The adapter owns request expansion,
 * deduplication, cancellation, retries, and the lifetime of live transports.
 */
export interface SignalAdapter {
  connect(sink: SignalSink): AdapterSession;
}

/** Low-level HTTP implementation used by the generic polling coordinator. */
export interface IntervalLoader {
  /** Minimum useful request size. The coordinator may fetch more than demanded. */
  readonly minFetchPoints?: number;
  /** Keep live polling warm for this long after the last live demand disappears. */
  readonly liveRetentionMs?: number;
  readonly livePollDelayMs?: number;
  readonly publicationGraceMs?: number;
  readonly sourceWideBackoff?: boolean;
  readonly now?: () => number;

  resolve(demand: BrokerDemand): number;
  fetchInterval(plan: AdapterPlan, signal: AbortSignal): Promise<AdapterBatch>;
  retryDelayMs?(error: unknown, attempt: number): number;
  clearCache?(): void;
}

interface ResolvedDemand {
  readonly range: Interval;
  readonly resolutionMs: number;
}

interface Work {
  readonly kind: "history" | "live";
  /** Unexpanded gap whose completion advances scheduling. */
  readonly requiredInterval: Interval;
  /** Expanded source request. */
  readonly plan: AdapterPlan;
  readonly attempt: number;
}

interface RunningWork {
  readonly state: "fetching";
  readonly work: Work;
  readonly controller: AbortController;
}

interface FailedWork {
  readonly state: "failed";
  readonly work: Work;
  readonly retryAtMs: number;
  readonly message: string;
}

type ActiveWork = RunningWork | FailedWork;

interface LiveLease {
  plan: ResolvedDemand;
  cursorMs: number;
  pollAtMs: number;
  /** `null` while current demand keeps the lease indefinitely. */
  expiresAtMs: number | null;
  activityRange: Interval;
}

interface ScheduledReconcile {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly atMs: number;
}

interface PollingPolicy {
  readonly minFetchPoints: number;
  readonly liveRetentionMs: number;
  readonly livePollDelayMs: number | null;
  readonly publicationGraceMs: number;
}

const DEFAULT_RETRY = (attempt: number): number => Math.min(30_000, 2_000 * 2 ** (attempt - 1));
const PUBLICATION_GRACE_MS = 250;
const DEFAULT_MIN_FETCH_POINTS = 128;
const DEFAULT_LIVE_RETENTION_MS = 15_000;

/**
 * Turn a range loader into a demand-aware adapter. A session owns one serialized
 * work lane and at most one live lease, so redraws cannot multiply polling loops.
 */
export function createPollingSignalSource(loader: IntervalLoader): SignalAdapter {
  const policy = createPolicy(loader);
  return { connect: sink => new PollingSession(loader, policy, sink) };
}

class PollingSession implements AdapterSession {
  private disposed = false;
  /** Resolved once when demand changes; ordered finest-first, then newest-first. */
  private plans: readonly ResolvedDemand[] = [];
  private readonly coverage = new Map<number, IntervalSet>();
  private active: ActiveWork | null = null;
  private live: LiveLease | null = null;
  private scheduled: ScheduledReconcile | null = null;
  private sourceBackoffUntilMs: number | null = null;
  private lastActivities: readonly AcquisitionActivity[] = [];

  constructor(
    private readonly loader: IntervalLoader,
    private readonly policy: PollingPolicy,
    private readonly sink: SignalSink,
  ) { }

  setDemands(demands: readonly BrokerDemand[]): void {
    this.assertOpen();
    this.plans = resolveDemands(this.loader, demands);
    this.reconcile();
  }

  clearCache(): void {
    this.assertOpen();
    this.abortActive();
    this.live = null;
    this.coverage.clear();
    this.sourceBackoffUntilMs = null;
    this.cancelScheduled();
    this.loader.clearCache?.();
    this.emitStatus();
    this.reconcile();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortActive();
    this.live = null;
    this.plans = [];
    this.cancelScheduled();
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Signal adapter session is disposed");
  }

  private now(): number {
    const value = (this.loader.now ?? Date.now)();
    if (!Number.isFinite(value)) throw new Error(`SignalAdapter: invalid wall clock ${value}`);
    return value;
  }

  private reconcile = (): void => {
    if (this.disposed) return;
    const wallNow = this.now();
    this.updateLiveLease(wallNow);

    if (this.active !== null) {
      if (!this.isStillWanted(this.active.work)) {
        this.abortActive();
        this.emitStatus();
      } else if (this.active.state === "failed") {
        if (wallNow < this.active.retryAtMs) {
          this.schedule(this.active.retryAtMs);
          return;
        }
        const work = this.active.work;
        this.active = null;
        this.start(work);
        return;
      } else {
        return;
      }
    }

    if (this.sourceBackoffUntilMs !== null) {
      if (wallNow < this.sourceBackoffUntilMs) {
        this.schedule(this.sourceBackoffUntilMs);
        return;
      }
      this.sourceBackoffUntilMs = null;
    }

    const work = this.nextLiveWork(wallNow) ?? this.nextHistoricalWork(wallNow);
    if (work !== null) {
      this.start(work);
      return;
    }

    this.emitStatus();
    if (this.live !== null) {
      const nextAtMs =
        this.live.expiresAtMs === null
          ? this.live.pollAtMs
          : Math.min(this.live.pollAtMs, this.live.expiresAtMs);
      this.schedule(nextAtMs);
    }
  };

  private schedule(atMs: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(atMs)) return;
    if (this.scheduled !== null && this.scheduled.atMs <= atMs) return;
    this.cancelScheduled();
    const handle = setTimeout(
      () => {
        this.scheduled = null;
        this.reconcile();
      },
      Math.max(0, atMs - this.now()),
    );
    this.scheduled = { handle, atMs };
  }

  private cancelScheduled(): void {
    if (this.scheduled === null) return;
    clearTimeout(this.scheduled.handle);
    this.scheduled = null;
  }

  private emitStatus(): void {
    if (this.disposed) return;
    const activities: AcquisitionActivity[] = [];
    if (this.live !== null) {
      activities.push({
        state: "watching",
        range: this.live.activityRange,
        resolutionMs: this.live.plan.resolutionMs,
      });
    }
    if (this.active !== null) {
      const { plan } = this.active.work;
      if (this.active.state === "fetching") {
        activities.push({ state: "fetching", range: plan.range, resolutionMs: plan.resolutionMs });
      } else {
        activities.push({
          state: "failed",
          range: plan.range,
          resolutionMs: plan.resolutionMs,
          message: this.active.message,
          retryAtMs: this.active.retryAtMs,
        });
      }
    }
    if (sameActivities(activities, this.lastActivities)) return;
    this.lastActivities = activities;
    this.sink.status(activities);
  }

  private coverageFor(resolutionMs: number): IntervalSet {
    let ranges = this.coverage.get(resolutionMs);
    if (ranges === undefined) {
      ranges = new IntervalSet();
      this.coverage.set(resolutionMs, ranges);
    }
    return ranges;
  }

  private blockers(resolutionMs: number, target: Interval, wallNow: number): IntervalSet {
    const out = new IntervalSet();
    for (const [availableResolutionMs, ranges] of this.coverage) {
      if (availableResolutionMs > resolutionMs) continue;
      for (const overlap of ranges.intersections(target)) out.add(overlap);
    }
    if (this.live !== null && this.live.plan.resolutionMs <= resolutionMs) {
      const tail = Interval.create(
        Math.max(this.live.plan.range.start, wallNow - 2 * this.live.plan.resolutionMs),
        wallNow,
      );
      out.add(Interval.intersection(tail, target));
    }
    return out;
  }

  private desiredLivePlan(wallNow: number): ResolvedDemand | null {
    return this.plans.find(plan => Interval.contains(plan.range, wallNow)) ?? null;
  }

  private createLiveLease(plan: ResolvedDemand, wallNow: number): LiveLease {
    const activityRange = liveTail(plan, wallNow);
    return {
      plan,
      cursorMs: activityRange.start,
      pollAtMs: wallNow,
      expiresAtMs: null,
      activityRange,
    };
  }

  private updateLiveLease(wallNow: number): void {
    const desired = this.desiredLivePlan(wallNow);
    if (desired === null) {
      if (this.live === null) return;
      this.live.expiresAtMs ??= wallNow + this.policy.liveRetentionMs;
      if (wallNow >= this.live.expiresAtMs) this.live = null;
      return;
    }

    if (this.live === null || this.live.plan.resolutionMs > desired.resolutionMs) {
      this.live = this.createLiveLease(desired, wallNow);
      return;
    }

    if (this.live.plan.resolutionMs === desired.resolutionMs) {
      this.live.plan = desired;
      this.live.expiresAtMs = null;
      return;
    }

    // Keep the existing finer lease briefly instead of immediately downgrading.
    this.live.expiresAtMs ??= wallNow + this.policy.liveRetentionMs;
    if (wallNow >= this.live.expiresAtMs) {
      this.live = this.createLiveLease(desired, wallNow);
    } else {
      this.live.plan = { ...this.live.plan, range: desired.range };
    }
  }

  private isStillWanted(work: Work): boolean {
    if (work.kind === "live") {
      return this.live !== null && this.live.plan.resolutionMs === work.plan.resolutionMs;
    }
    return this.plans.some(
      plan =>
        plan.resolutionMs >= work.plan.resolutionMs &&
        Interval.overlaps(plan.range, work.requiredInterval),
    );
  }

  private nextHistoricalWork(wallNow: number): Work | null {
    for (const plan of this.plans) {
      const target = Interval.clampEnd(plan.range, wallNow);
      if (Interval.isEmpty(target)) continue;
      const gaps = this.blockers(plan.resolutionMs, target, wallNow).gaps(target);
      const gap = Interval.contains(plan.range, wallNow) ? gaps[gaps.length - 1] : gaps[0];
      if (gap !== undefined) return this.makeWork("history", plan, gap, wallNow);
    }
    return null;
  }

  private nextLiveWork(wallNow: number): Work | null {
    if (this.live === null || wallNow < this.live.pollAtMs) return null;
    const required = Interval.create(
      Math.min(this.live.cursorMs, wallNow - this.live.plan.resolutionMs),
      wallNow,
    );
    if (Interval.isEmpty(required)) return null;
    return this.makeWork("live", this.live.plan, required, wallNow);
  }

  private makeWork(
    kind: Work["kind"],
    demand: ResolvedDemand,
    requiredInterval: Interval,
    wallNow: number,
  ): Work {
    return {
      kind,
      requiredInterval,
      plan: {
        range: expandFetchInterval(
          requiredInterval,
          demand.resolutionMs,
          wallNow,
          this.policy.minFetchPoints,
        ),
        resolutionMs: demand.resolutionMs,
      },
      attempt: 0,
    };
  }

  private start(work: Work): void {
    const running: RunningWork = { state: "fetching", work, controller: new AbortController() };
    this.active = running;
    this.emitStatus();
    if (this.active === running) void this.run(running);
  }

  private async run(running: RunningWork): Promise<void> {
    let batch: AdapterBatch;
    try {
      batch = await this.loader.fetchInterval(running.work.plan, running.controller.signal);
      if (this.disposed || this.active !== running) return;
      validateBatch(running.work.requiredInterval, batch);
    } catch (error) {
      if (this.disposed || this.active !== running || isAbort(error)) return;
      this.failWork(running.work, error);
      return;
    }

    // Sink failures are consumer bugs, not acquisition failures. Keep delivery
    // outside the loader retry boundary so they are never blamed on the source.
    this.finishWork(running.work, batch);
    if (this.disposed || this.active !== running) return;
    this.active = null;
    this.emitStatus();
    this.reconcile();
  }

  private finishWork(work: Work, batch: AdapterBatch): void {
    // Commit coordinator state before delivery. Sink callbacks may synchronously
    // clear the cache or replace demands; those operations must win reentrantly.
    this.coverageFor(work.plan.resolutionMs).add(batch.searchedInterval);

    if (
      work.kind === "live" &&
      this.live !== null &&
      this.live.plan.resolutionMs === work.plan.resolutionMs
    ) {
      const wallNow = this.now();
      const last = batch.samples[batch.samples.length - 1];
      const expectedNextMs = last === undefined ? null : last.t + work.plan.resolutionMs;
      this.live.cursorMs = Math.max(batch.searchedInterval.end, expectedNextMs ?? -Infinity);
      this.live.activityRange = work.requiredInterval;
      this.live.pollAtMs =
        expectedNextMs !== null && expectedNextMs > wallNow
          ? expectedNextMs + this.policy.publicationGraceMs
          : wallNow + (this.policy.livePollDelayMs ?? defaultPollDelay(work.plan.resolutionMs));
    }

    this.sink.next({ ...batch, resolutionMs: work.plan.resolutionMs });
  }

  private failWork(work: Work, error: unknown): void {
    const attempt = work.attempt + 1;
    const proposed = this.loader.retryDelayMs?.(error, attempt) ?? DEFAULT_RETRY(attempt);
    const delayMs = validDelay(proposed) ? Math.max(100, proposed) : DEFAULT_RETRY(attempt);
    const retryAtMs = this.now() + delayMs;
    const message = error instanceof Error ? error.message : String(error);
    const failed: FailedWork = { state: "failed", work: { ...work, attempt }, retryAtMs, message };
    this.active = failed;
    if (this.loader.sourceWideBackoff === true) {
      this.sourceBackoffUntilMs = Math.max(this.sourceBackoffUntilMs ?? -Infinity, retryAtMs);
    }
    const activity: Extract<AcquisitionActivity, { readonly state: "failed" }> = {
      state: "failed",
      range: work.plan.range,
      resolutionMs: work.plan.resolutionMs,
      message,
      retryAtMs,
    };
    this.emitStatus();
    if (this.active === failed) this.schedule(retryAtMs);
    this.sink.error(error, activity);
  }

  private abortActive(): void {
    if (this.active?.state === "fetching") this.active.controller.abort();
    this.active = null;
  }
}

function createPolicy(loader: IntervalLoader): PollingPolicy {
  return {
    minFetchPoints: Math.ceil(
      positiveFinite(loader.minFetchPoints ?? DEFAULT_MIN_FETCH_POINTS, "minFetchPoints"),
    ),
    liveRetentionMs: nonNegativeFinite(
      loader.liveRetentionMs ?? DEFAULT_LIVE_RETENTION_MS,
      "liveRetentionMs",
    ),
    livePollDelayMs:
      loader.livePollDelayMs === undefined
        ? null
        : positiveFinite(loader.livePollDelayMs, "livePollDelayMs"),
    publicationGraceMs: nonNegativeFinite(
      loader.publicationGraceMs ?? PUBLICATION_GRACE_MS,
      "publicationGraceMs",
    ),
  };
}

function resolveDemands(
  loader: IntervalLoader,
  demands: readonly BrokerDemand[],
): ResolvedDemand[] {
  const plans = demands.map(demand => {
    validateDemand(demand);
    const resolutionMs = loader.resolve(demand);
    if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
      throw new Error(`SignalAdapter: invalid native resolution ${resolutionMs}`);
    }
    return { range: demand.range, resolutionMs };
  });
  plans.sort(
    (a, b) =>
      a.resolutionMs - b.resolutionMs || b.range.end - a.range.end || b.range.start - a.range.start,
  );
  return plans.filter(
    (plan, index) =>
      index === 0 ||
      plan.resolutionMs !== plans[index - 1]!.resolutionMs ||
      !Interval.equals(plan.range, plans[index - 1]!.range),
  );
}

function expandFetchInterval(
  required: Interval,
  resolutionMs: number,
  wallNow: number,
  minFetchPoints: number,
): Interval {
  const minSpan = minFetchPoints * resolutionMs;
  let start = Math.floor(required.start / resolutionMs) * resolutionMs;
  let end = Math.min(wallNow, Math.ceil(required.end / resolutionMs) * resolutionMs);
  if (!(start < end)) end = Math.min(wallNow, Math.max(required.end, start + resolutionMs));

  if (end - start < minSpan) {
    if (required.end >= wallNow - 2 * resolutionMs) {
      start = end - minSpan;
    } else {
      const missing = minSpan - (end - start);
      start -= Math.ceil(missing / 2 / resolutionMs) * resolutionMs;
      end = Math.min(wallNow, start + minSpan);
      if (end < required.end) {
        end = required.end;
        start = end - minSpan;
      }
    }
  }

  const expanded = Interval.create(start, end);
  if (Interval.isEmpty(expanded)) {
    throw new Error("SignalAdapter: could not construct a non-empty fetch range");
  }
  return expanded;
}

function liveTail(plan: ResolvedDemand, wallNow: number): Interval {
  return Interval.create(Math.max(plan.range.start, wallNow - 2 * plan.resolutionMs), wallNow);
}

function validateDemand(demand: BrokerDemand): void {
  if (!(demand.maxDeltaTMs > 0) || !Number.isFinite(demand.maxDeltaTMs)) {
    throw new Error(`SignalAdapter: invalid requested resolution ${demand.maxDeltaTMs}`);
  }
}

function validateBatch(requiredInterval: Interval, batch: AdapterBatch): void {
  if (!Interval.overlaps(requiredInterval, batch.searchedInterval)) {
    throw new Error("SignalAdapter: searched range made no progress on the required range");
  }
}

function sameActivities(
  a: readonly AcquisitionActivity[],
  b: readonly AcquisitionActivity[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((activity, index) => sameActivity(activity, b[index]!));
}

function sameActivity(a: AcquisitionActivity, b: AcquisitionActivity): boolean {
  if (
    a.state !== b.state ||
    a.resolutionMs !== b.resolutionMs ||
    !Interval.equals(a.range, b.range)
  ) {
    return false;
  }
  return (
    a.state !== "failed" ||
    (b.state === "failed" && a.message === b.message && a.retryAtMs === b.retryAtMs)
  );
}

function defaultPollDelay(resolutionMs: number): number {
  return Math.min(30_000, Math.max(1_000, resolutionMs / 10));
}

function validDelay(value: number): boolean {
  return value >= 0 && Number.isFinite(value);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function positiveFinite(value: number, name: string): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error(`SignalAdapter: invalid ${name} ${value}`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (value < 0 || !Number.isFinite(value)) {
    throw new Error(`SignalAdapter: invalid ${name} ${value}`);
  }
  return value;
}
