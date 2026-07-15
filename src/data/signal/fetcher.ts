/** Demand-aware adapter scheduling for sampled real-valued time series. */

import { Range } from "../../engine/range.ts";
import { RangeSet } from "../rangeSet.ts";
import type { Sample } from "./sample.ts";

export interface AdapterDemand {
  readonly range: Range;
  /** Maximum acceptable native sample spacing requested by the consumer. */
  readonly maxDeltaTMs: number;
}

/** A demand after the adapter has selected an exchange-native resolution. */
export interface AdapterPlan extends AdapterDemand {
  readonly resolutionMs: number;
}

export interface AdapterBatch {
  /** Canonical observations in epoch milliseconds. */
  readonly samples: readonly Sample[];
  /** Everything searched by the source, which may be wider than requested. */
  readonly searchedRange: Range;
}

/** A cache delivery is self-describing; it is not tied to a broker request. */
export interface AdapterDelivery extends AdapterBatch {
  readonly resolutionMs: number;
  readonly requestedMaxDeltaTMs: number;
}

export type AdapterActivityState = "fetching" | "watching" | "failed";

export interface AcquisitionActivity {
  readonly state: AdapterActivityState;
  readonly range: Range;
  readonly resolutionMs: number;
  readonly message?: string;
  readonly retryAtMs?: number;
}

export interface SignalSink {
  next(batch: AdapterDelivery): void;
  status(activities: readonly AcquisitionActivity[]): void;
  error(error: unknown, activity: AcquisitionActivity): void;
}

/** One long-lived acquisition session per broker/source. */
export interface AdapterSession {
  setDemands(demands: readonly AdapterDemand[]): void;
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
export interface RangeLoader {
  /** Minimum useful request size. The coordinator may fetch more than demanded. */
  readonly minFetchPoints?: number;
  /** Keep live polling warm for this long after the last live demand disappears. */
  readonly liveRetentionMs?: number;
  readonly livePollDelayMs?: number;
  readonly publicationGraceMs?: number;
  readonly sourceWideBackoff?: boolean;
  readonly now?: () => number;

  resolve(demand: AdapterDemand): number;
  fetchRange(plan: AdapterPlan, signal: AbortSignal): Promise<AdapterBatch>;
  retryDelayMs?(error: unknown, attempt: number): number;
  clearCache?(): void;
}

interface Work {
  readonly kind: "history" | "live";
  readonly requiredRange: Range;
  readonly plan: AdapterPlan;
  readonly controller: AbortController;
  attempt: number;
  retryAtMs: number | null;
  failureMessage: string | null;
}

interface LiveLease {
  plan: AdapterPlan;
  cursorMs: number;
  nextAtMs: number;
  retainedUntilMs: number;
  statusRange: Range;
}

const DEFAULT_RETRY = (attempt: number): number => Math.min(30_000, 2_000 * 2 ** (attempt - 1));
const PUBLICATION_GRACE_MS = 250;
const DEFAULT_MIN_FETCH_POINTS = 128;
const DEFAULT_LIVE_RETENTION_MS = 15_000;

/**
 * Turn a range fetcher into a demand-aware adapter. There is one bounded work
 * lane and at most one live lease, so redraws cannot multiply polling loops.
 */
export function createPollingSignalSource(fetcher: RangeLoader): SignalAdapter {
  const now = fetcher.now ?? Date.now;
  const planDemand = (demand: AdapterDemand): AdapterPlan => {
    validateDemand(demand);
    const resolutionMs = fetcher.resolve(demand);
    if (!(resolutionMs > 0 && Number.isFinite(resolutionMs))) {
      throw new Error(`SignalAdapter: invalid native resolution ${resolutionMs}`);
    }
    return { ...demand, resolutionMs };
  };

  const adapter: SignalAdapter = {
    connect(sink) {
      let disposed = false;
      let demands: readonly AdapterDemand[] = [];
      const coverage = new Map<number, RangeSet>();
      let active: Work | null = null;
      let live: LiveLease | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timerAtMs = Number.POSITIVE_INFINITY;
      let sourceRetryAt = -Infinity;
      let statusKey = "";

      const schedule = (atMs: number): void => {
        if (disposed) return;
        if (timer !== null && timerAtMs <= atMs) return;
        if (timer !== null) clearTimeout(timer);
        timerAtMs = atMs;
        timer = setTimeout(
          () => {
            timer = null;
            timerAtMs = Number.POSITIVE_INFINITY;
            reconcile();
          },
          Math.max(0, atMs - now()),
        );
      };

      const emitStatus = (): void => {
        if (disposed) return;
        const activities: AcquisitionActivity[] = [];
        if (live !== null) {
          activities.push({
            state: "watching",
            range: live.statusRange,
            resolutionMs: live.plan.resolutionMs,
          });
        }
        if (active !== null) {
          const message = active.failureMessage ?? undefined;
          activities.push({
            state: active.retryAtMs === null ? "fetching" : "failed",
            range: active.plan.range,
            resolutionMs: active.plan.resolutionMs,
            ...(message === undefined ? {} : { message, retryAtMs: active.retryAtMs! }),
          });
        }
        const nextKey = activities
          .map(
            (item) =>
              `${item.state}:${item.range.min}:${item.range.max}:${item.resolutionMs}:${item.retryAtMs ?? ""}:${item.message ?? ""}`,
          )
          .join("|");
        if (nextKey === statusKey) return;
        statusKey = nextKey;
        sink.status(activities);
      };

      const coverageFor = (resolutionMs: number): RangeSet => {
        let ranges = coverage.get(resolutionMs);
        if (ranges === undefined) {
          ranges = new RangeSet();
          coverage.set(resolutionMs, ranges);
        }
        return ranges;
      };

      const addCoverage = (resolutionMs: number, range: Range): void => {
        coverageFor(resolutionMs).add(range);
      };

      const blockers = (resolutionMs: number, target: Range): RangeSet => {
        const out = new RangeSet();
        for (const [availableResolutionMs, ranges] of coverage) {
          if (availableResolutionMs > resolutionMs) continue;
          for (const overlap of ranges.intersections(target)) out.add(overlap);
        }
        if (live !== null && live.plan.resolutionMs <= resolutionMs) {
          const wallNow = now();
          const tailMin = Math.max(live.plan.range.min, wallNow - 2 * live.plan.resolutionMs);
          if (tailMin < wallNow) {
            const tail = intersect(Range.create(tailMin, wallNow), target);
            if (tail !== null) out.add(tail);
          }
        }
        return out;
      };

      const currentPlans = (): AdapterPlan[] =>
        demands
          .map((demand) => planDemand({ ...demand }))
          .sort((a, b) => a.resolutionMs - b.resolutionMs || b.range.max - a.range.max);

      const desiredLivePlan = (plans: readonly AdapterPlan[]): AdapterPlan | null => {
        const wallNow = now();
        return plans.find((plan) => includes(plan.range, wallNow)) ?? null;
      };

      const createLiveLease = (plan: AdapterPlan, wallNow: number): LiveLease => {
        const cursorMs = Math.max(plan.range.min, wallNow - 2 * plan.resolutionMs);
        return {
          plan,
          cursorMs,
          nextAtMs: wallNow,
          retainedUntilMs: Number.POSITIVE_INFINITY,
          statusRange: Range.create(
            Math.min(cursorMs, wallNow - plan.resolutionMs),
            wallNow,
          ),
        };
      };

      const updateLiveLease = (plans: readonly AdapterPlan[]): void => {
        const wallNow = now();
        const desired = desiredLivePlan(plans);
        if (desired !== null) {
          if (live === null || live.plan.resolutionMs > desired.resolutionMs) {
            live = createLiveLease(desired, wallNow);
          } else if (live.plan.resolutionMs === desired.resolutionMs) {
            live.plan = {
              ...live.plan,
              range: desired.range,
            };
            live.retainedUntilMs = Number.POSITIVE_INFINITY;
          } else {
            if (!Number.isFinite(live.retainedUntilMs)) {
              live.retainedUntilMs =
                wallNow + (fetcher.liveRetentionMs ?? DEFAULT_LIVE_RETENTION_MS);
            }
            if (wallNow >= live.retainedUntilMs) {
              live = createLiveLease(desired, wallNow);
            } else {
              live.plan = {
                ...live.plan,
                range: desired.range,
              };
            }
          }
          return;
        }
        if (live === null) return;
        if (!Number.isFinite(live.retainedUntilMs)) {
          live.retainedUntilMs = wallNow + (fetcher.liveRetentionMs ?? DEFAULT_LIVE_RETENTION_MS);
        }
        if (wallNow >= live.retainedUntilMs) live = null;
      };

      const isStillWanted = (work: Work, plans: readonly AdapterPlan[]): boolean => {
        if (work.kind === "live")
          return live !== null && live.plan.resolutionMs === work.plan.resolutionMs;
        return plans.some(
          (plan) =>
            plan.resolutionMs >= work.plan.resolutionMs &&
            intersect(plan.range, work.requiredRange) !== null,
        );
      };

      const nextHistoricalWork = (plans: readonly AdapterPlan[], wallNow: number): Work | null => {
        for (const plan of plans) {
          const target = clampToNow(plan.range, wallNow);
          if (target === null) continue;
          const gaps = blockers(plan.resolutionMs, target).gaps(target);
          const gap = includes(plan.range, wallNow) ? gaps[gaps.length - 1] : gaps[0];
          if (gap === undefined) continue;
          return makeWork("history", plan, gap, wallNow);
        }
        return null;
      };

      const nextLiveWork = (wallNow: number): Work | null => {
        if (live === null || wallNow < live.nextAtMs) return null;
        const min = Math.min(live.cursorMs, wallNow - live.plan.resolutionMs);
        if (!(min < wallNow)) return null;
        return makeWork("live", live.plan, Range.create(min, wallNow), wallNow);
      };

      const makeWork = (
        kind: Work["kind"],
        plan: AdapterPlan,
        requiredRange: Range,
        wallNow: number,
      ): Work => {
        const fetchRange = expandRange(
          requiredRange,
          plan.resolutionMs,
          wallNow,
          fetcher.minFetchPoints,
        );
        return {
          kind,
          requiredRange,
          plan: { ...plan, range: fetchRange },
          controller: new AbortController(),
          attempt: 0,
          retryAtMs: null,
          failureMessage: null,
        };
      };

      const finishWork = (work: Work, batch: AdapterBatch): void => {
        validateBatch(work.requiredRange, batch);
        sink.next({
          ...batch,
          resolutionMs: work.plan.resolutionMs,
          requestedMaxDeltaTMs: work.plan.maxDeltaTMs,
        });
        addCoverage(work.plan.resolutionMs, batch.searchedRange);

        if (work.kind === "live" && live !== null) {
          const wallNow = now();
          const last = batch.samples[batch.samples.length - 1];
          live.cursorMs = Math.max(
            batch.searchedRange.max,
            last === undefined ? -Infinity : last.t + work.plan.resolutionMs,
          );
          live.statusRange = work.requiredRange;
          const pollDelay = fetcher.livePollDelayMs ?? defaultPollDelay(work.plan.resolutionMs);
          const expectedNext = last === undefined ? -Infinity : last.t + work.plan.resolutionMs;
          live.nextAtMs =
            expectedNext > wallNow
              ? expectedNext + (fetcher.publicationGraceMs ?? PUBLICATION_GRACE_MS)
              : wallNow + pollDelay;
        }
      };

      const start = (work: Work): void => {
        active = work;
        work.failureMessage = null;
        emitStatus();
        void (async () => {
          try {
            const batch = await fetcher.fetchRange(work.plan, work.controller.signal);
            if (disposed || active !== work) return;
            finishWork(work, batch);
            active = null;
            emitStatus();
            reconcile();
          } catch (error) {
            if (disposed || active !== work || isAbort(error)) return;
            work.attempt++;
            const proposed =
              fetcher.retryDelayMs?.(error, work.attempt) ?? DEFAULT_RETRY(work.attempt);
            const delay = validDelay(proposed)
              ? Math.max(100, proposed)
              : DEFAULT_RETRY(work.attempt);
            work.retryAtMs = now() + delay;
            work.failureMessage = error instanceof Error ? error.message : String(error);
            if (fetcher.sourceWideBackoff === true) {
              sourceRetryAt = Math.max(sourceRetryAt, work.retryAtMs);
            }
            const activity: AcquisitionActivity = {
              state: "failed",
              range: work.plan.range,
              resolutionMs: work.plan.resolutionMs,
              message: error instanceof Error ? error.message : String(error),
              retryAtMs: work.retryAtMs,
            };
            emitStatus();
            sink.error(error, activity);
            schedule(work.retryAtMs);
          }
        })();
      };

      const reconcile = (): void => {
        if (disposed) return;
        const wallNow = now();
        const plans = currentPlans();
        updateLiveLease(plans);

        if (active !== null) {
          if (!isStillWanted(active, plans)) {
            active.controller.abort();
            active = null;
            emitStatus();
          } else if (active.retryAtMs !== null) {
            if (wallNow < active.retryAtMs) {
              schedule(active.retryAtMs);
              return;
            }
            active.retryAtMs = null;
            start(active);
            return;
          } else {
            return;
          }
        }

        if (fetcher.sourceWideBackoff === true && wallNow < sourceRetryAt) {
          schedule(sourceRetryAt);
          return;
        }

        const liveWork = nextLiveWork(wallNow);
        if (liveWork !== null) {
          start(liveWork);
          return;
        }
        const historicalWork = nextHistoricalWork(plans, wallNow);
        if (historicalWork !== null) {
          start(historicalWork);
          return;
        }

        emitStatus();
        if (live !== null) {
          const nextAt = Math.min(live.nextAtMs, live.retainedUntilMs);
          if (Number.isFinite(nextAt)) schedule(nextAt);
        }
      };

      return {
        setDemands(nextDemands) {
          if (disposed) throw new Error("Signal adapter session is disposed");
          for (const demand of nextDemands) validateDemand(demand);
          demands = nextDemands.map((demand) => ({ ...demand }));
          reconcile();
        },

        clearCache() {
          if (disposed) throw new Error("Signal adapter session is disposed");
          active?.controller.abort();
          active = null;
          live = null;
          coverage.clear();
          sourceRetryAt = -Infinity;
          if (timer !== null) clearTimeout(timer);
          timer = null;
          timerAtMs = Number.POSITIVE_INFINITY;
          statusKey = "";
          fetcher.clearCache?.();
          emitStatus();
          reconcile();
        },

        dispose() {
          if (disposed) return;
          disposed = true;
          active?.controller.abort();
          active = null;
          live = null;
          demands = [];
          if (timer !== null) clearTimeout(timer);
          timer = null;
          timerAtMs = Number.POSITIVE_INFINITY;
        },
      };
    },
  };

  return adapter;
}

function expandRange(
  required: Range,
  resolutionMs: number,
  wallNow: number,
  configuredMinPoints: number | undefined,
): Range {
  const minPoints = configuredMinPoints ?? DEFAULT_MIN_FETCH_POINTS;
  if (!(minPoints >= 1) || !Number.isFinite(minPoints)) {
    throw new Error(`SignalAdapter: invalid minFetchPoints ${minPoints}`);
  }
  const minSpan = Math.ceil(minPoints) * resolutionMs;
  let min = Math.floor(required.min / resolutionMs) * resolutionMs;
  let max = Math.min(wallNow, Math.ceil(required.max / resolutionMs) * resolutionMs);
  if (!(min < max)) max = Math.min(wallNow, Math.max(required.max, min + resolutionMs));
  if (max - min < minSpan) {
    if (required.max >= wallNow - 2 * resolutionMs) {
      min = max - minSpan;
    } else {
      const missing = minSpan - (max - min);
      min -= Math.ceil(missing / 2 / resolutionMs) * resolutionMs;
      max = Math.min(wallNow, min + minSpan);
      if (max < required.max) {
        max = required.max;
        min = max - minSpan;
      }
    }
  }
  if (!(min < max)) throw new Error("SignalAdapter: could not construct a non-empty fetch range");
  return Range.create(min, max);
}

function validateDemand(demand: AdapterDemand): void {
  if (!(demand.maxDeltaTMs > 0) || !Number.isFinite(demand.maxDeltaTMs)) {
    throw new Error(`SignalAdapter: invalid requested resolution ${demand.maxDeltaTMs}`);
  }
}

function validateBatch(requiredRange: Range, batch: AdapterBatch): void {
  if (intersect(requiredRange, batch.searchedRange) === null) {
    throw new Error("SignalAdapter: searched range made no progress on the required range");
  }
}

function defaultPollDelay(resolutionMs: number): number {
  return Math.min(30_000, Math.max(1_000, resolutionMs / 10));
}

function validDelay(value: number): boolean {
  return value >= 0 && Number.isFinite(value);
}

function includes(range: Range, time: number): boolean {
  return range.min <= time && range.max >= time;
}

function clampToNow(range: Range, now: number): Range | null {
  const max = Math.min(range.max, now);
  return range.min < max ? Range.create(range.min, max) : null;
}

function intersect(a: Range, b: Range): Range | null {
  const min = Math.max(a.min, b.min);
  const max = Math.min(a.max, b.max);
  return min < max ? Range.create(min, max) : null;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
