/**
 * Structural and timing instrumentation for `SignalSegmentStore`.
 *
 * This module is the single source of truth for what we measure while
 * evaluating candidate replacement data structures. It is intentionally
 * allocation-conscious on the hot path: per-batch records are pooled, and
 * `StoreProfile` maintains `storeSegmentCount` incrementally so profiling it
 * stays O(1).
 *
 * Records are emitted through `performance.mark` so they appear in the browser
 * profiler / `performance.getEntriesByName` and can be scraped by tooling.
 * They are also retained in a bounded ring buffer per profile so a single
 * page session can be inspected after the fact.
 *
 * The shape of `WriteRecord`, `ReadRecord`, and `WorkloadBatch` is the
 * contract for replay tooling: candidate structures must be benchmarked
 * against exactly these workloads at 1x, 10x, and 100x scale.
 */

import type { HeldSignalSegment } from "./store.ts";

const RING_CAPACITY = 4096;

/** Where in the existing store the incoming batch landed. */
export type WritePosition = "append" | "prepend" | "middle" | "rewrite" | "spanning" | "initial";

/** One measured `insertBatch` call. Pooled; do not retain across calls. */
export interface WriteRecord {
  readonly storeId: number;
  readonly insertion: number;
  readonly incomingCount: number;
  readonly incomingStart: number;
  readonly incomingEnd: number;
  readonly storeSegmentCountBefore: number;
  readonly storeSegmentCountAfter: number;
  readonly blockCountBefore: number;
  readonly blockCountAfter: number;
  readonly directlyOverlappingBlockCount: number;
  readonly rewrittenBlockCount: number;
  readonly flattenedSegmentCount: number;
  readonly mergedSegmentCount: number;
  readonly replacementBlockCount: number;
  readonly position: WritePosition;
  readonly changed: boolean;
  readonly durationMs: number;
  readonly phaseDurationMs: WritePhaseDuration;
}

/** Per-phase timing for one insert. All durations in milliseconds. */
export interface WritePhaseDuration {
  readonly validation: number;
  readonly locating: number;
  readonly flattening: number;
  readonly overlay: number;
  readonly equality: number;
  readonly rechunking: number;
  readonly splicing: number;
}

/** One measured read (`sample` or `readPointAtOrBefore`). */
export interface ReadRecord {
  readonly storeId: number;
  readonly operation: "sample" | "readPointAtOrBefore";
  readonly evalCount: number;
  readonly durationMs: number;
  readonly sortedAscending: boolean;
  readonly regularlySpaced: boolean;
  readonly distinctBlocksVisited: number | null;
  readonly storeSegmentCount: number;
  readonly frame: number | null;
}

/**
 * Replayable workload captured at the broker/store boundary. The new
 * structure only needs numeric keys and values; `resolutionMs` is captured
 * because "finer evidence wins" must remain in the replay semantics.
 */
export interface WorkloadBatch {
  readonly storeId: number;
  readonly batchIndex: number;
  readonly resolutionMs: number;
  readonly keys: readonly number[];
  readonly values: readonly number[];
}

interface RingBuffer<T> {
  readonly capacity: number;
  readonly items: T[];
  head: number;
  size: number;
}

function ringPush<T>(ring: RingBuffer<T>, item: T): void {
  ring.items[ring.head] = item;
  ring.head = (ring.head + 1) % ring.capacity;
  if (ring.size < ring.capacity) ring.size++;
}

function ringSnapshot<T>(ring: RingBuffer<T>): readonly T[] {
  if (ring.size < ring.capacity) return ring.items.slice(0, ring.size);
  const out: T[] = new Array(ring.capacity);
  for (let i = 0; i < ring.capacity; i++) out[i] = ring.items[(ring.head + i) % ring.capacity]!;
  return out;
}

function createRing<T>(capacity: number): RingBuffer<T> {
  return { capacity, items: new Array<T>(capacity), head: 0, size: 0 };
}

/**
 * Per-store profile. One instance lives inside each `SignalSegmentStore`.
 * `storeSegmentCount` is maintained incrementally so profiling it is O(1).
 */
export class StoreProfile {
  readonly storeId: number;
  /** Incremented on every `insertBatch`, regardless of `changed`. */
  insertionCount = 0;
  /** Incremental segment count; updated by the store on every structural change. */
  storeSegmentCount = 0;

  private readonly writes: RingBuffer<WriteRecord> = createRing<WriteRecord>(RING_CAPACITY);
  private readonly reads: RingBuffer<ReadRecord> = createRing<ReadRecord>(RING_CAPACITY);
  private readonly workloads: RingBuffer<WorkloadBatch> = createRing<WorkloadBatch>(RING_CAPACITY);
  private workloadBatchIndex = 0;

  constructor(storeId: number) {
    this.storeId = storeId;
  }

  recordWrite(record: WriteRecord): void {
    ringPush(this.writes, record);
    performance.mark("SignalSegmentStore.insertBatch", { detail: record });
  }

  recordRead(record: ReadRecord): void {
    ringPush(this.reads, record);
    performance.mark("SignalSegmentStore.read", { detail: record });
  }

  recordWorkload(resolutionMs: number, segments: readonly HeldSignalSegment[]): void {
    const keys: number[] = new Array(segments.length);
    const values: number[] = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      keys[i] = segment.sampleTime;
      values[i] = segment.value;
    }
    const batch: WorkloadBatch = {
      storeId: this.storeId,
      batchIndex: this.workloadBatchIndex++,
      resolutionMs,
      keys,
      values,
    };
    ringPush(this.workloads, batch);
  }

  writeSnapshot(): readonly WriteRecord[] {
    return ringSnapshot(this.writes);
  }
  readSnapshot(): readonly ReadRecord[] {
    return ringSnapshot(this.reads);
  }
  workloadSnapshot(): readonly WorkloadBatch[] {
    return ringSnapshot(this.workloads);
  }
}

let nextStoreProfileId = 1;
export function allocateStoreId(): number {
  return nextStoreProfileId++;
}

/**
 * Frame counter for read attribution. The renderer calls `tickFrame()` once
 * per `requestAnimationFrame` callback; reads taken between two ticks are
 * attributed to the frame active at the moment of the read.
 */
class FrameClock {
  private currentFrame = 0;
  private activeFrame: number | null = null;

  tickFrame(): void {
    this.currentFrame++;
    this.activeFrame = this.currentFrame;
  }

  /** Called when the frame's reads are complete (e.g. on `draw` exit). */
  endFrame(): void {
    this.activeFrame = null;
  }

  frame(): number | null {
    return this.activeFrame;
  }
}

export const frameClock = new FrameClock();

/**
 * Scratch timer used by the store to record phase durations without
 * allocating per-call. The store calls `begin()`/`end()` around each phase
 * and reads `phaseDurationMs` at the end of the batch.
 */
export class InsertTimer {
  private readonly phaseDurationMs: WritePhaseDuration = {
    validation: 0,
    locating: 0,
    flattening: 0,
    overlay: 0,
    equality: 0,
    rechunking: 0,
    splicing: 0,
  };
  private start = 0;

  begin(): void {
    this.start = performance.now();
  }
  /** Stop the current phase and accumulate its duration into `key`. */
  end(key: WritePhaseKey): void {
    const duration = performance.now() - this.start;
    (this.phaseDurationMs as Writable<WritePhaseDuration>)[key] += duration;
  }
  reset(): void {
    const p = this.phaseDurationMs as Writable<WritePhaseDuration>;
    p.validation = 0;
    p.locating = 0;
    p.flattening = 0;
    p.overlay = 0;
    p.equality = 0;
    p.rechunking = 0;
    p.splicing = 0;
  }
  snapshot(): WritePhaseDuration {
    return { ...this.phaseDurationMs };
  }
}

type WritePhaseKey = keyof WritePhaseDuration;
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Classify where the incoming range landed relative to the existing store.
 * `incomingStart`/`incomingEnd` are the hull of the incoming batch;
 * `storeStart`/`storeEnd` are the existing store hull (or `null` if empty).
 *
 * - `initial`: store was empty.
 * - `append`: incoming starts at or after the existing tail (touch allowed).
 * - `prepend`: incoming ends at or before the existing head (touch allowed).
 * - `rewrite`: incoming fully covers the existing store.
 * - `spanning`: incoming overlaps more than half of the existing store on
 *   both sides, but is not a full rewrite.
 * - `middle`: incoming overlaps the existing store somewhere in the interior.
 */
export function classifyWrite(
  incomingStart: number,
  incomingEnd: number,
  storeStart: number | null,
  storeEnd: number | null,
): WritePosition {
  if (storeStart === null || storeEnd === null) return "initial";
  if (incomingStart >= storeEnd) return "append";
  if (incomingEnd <= storeStart) return "prepend";
  if (incomingStart <= storeStart && incomingEnd >= storeEnd) return "rewrite";
  const storeSpan = storeEnd - storeStart;
  if (storeSpan <= 0) return "rewrite";
  const overlapStart = Math.max(incomingStart, storeStart);
  const overlapEnd = Math.min(incomingEnd, storeEnd);
  const overlap = overlapEnd - overlapStart;
  if (overlap >= storeSpan * 0.5 && incomingStart < storeStart && incomingEnd > storeEnd) {
    return "spanning";
  }
  return "middle";
}

/**
 * Inspect an `evalTime` array for monotonicity and regular spacing.
 * Used to decide whether the read hot path can replace one binary search per
 * point with one initial search followed by a forward cursor.
 */
export function analyzeEvalTime(evalTime: Float64Array): {
  sortedAscending: boolean;
  regularlySpaced: boolean;
} {
  if (evalTime.length <= 1) {
    return { sortedAscending: true, regularlySpaced: true };
  }
  let sortedAscending = true;
  let regularlySpaced = true;
  const firstStep = evalTime[1]! - evalTime[0]!;
  for (let i = 1; i < evalTime.length; i++) {
    const prev = evalTime[i - 1]!;
    const curr = evalTime[i]!;
    if (!(curr >= prev)) {
      sortedAscending = false;
      break;
    }
  }
  if (sortedAscending) {
    for (let i = 2; i < evalTime.length; i++) {
      const step = evalTime[i]! - evalTime[i - 1]!;
      if (Math.abs(step - firstStep) > 1e-6 * Math.max(1, Math.abs(firstStep))) {
        regularlySpaced = false;
        break;
      }
    }
  } else {
    regularlySpaced = false;
  }
  return { sortedAscending, regularlySpaced };
}
