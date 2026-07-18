import { lowerBoundBy, upperBoundBy } from "../../core/binarySearch.ts";
import { Interval } from "../../core/interval.ts";
import type { MutableSample } from "./sample.ts";
import {
  allocateStoreId,
  analyzeEvalTime,
  classifyWrite,
  frameClock,
  InsertTimer,
  StoreProfile,
  type WriteRecord,
} from "./storeProfile.ts";

const MAX_BLOCK_LENGTH = 512;

/**
 * Zero-order-held reconstruction of one observed sample over `range`.
 *
 * `sampleTime` identifies the observation that supplies `value`. It may precede
 * `range.start` when overlaying finer evidence slices an existing segment.
 */
export interface HeldSignalSegment {
  readonly range: Interval;
  readonly sampleTime: number;
  readonly value: number;
  readonly resolutionMs: number;
}

/**
 * Immutable structure-of-arrays leaf.
 *
 * Invariants:
 * - every column has the same non-zero length, at most `MAX_BLOCK_LENGTH`;
 * - `rangeStart` is strictly increasing;
 * - every segment is non-empty and segments never overlap;
 */
interface SegmentBlock {
  readonly rangeStart: Float64Array;
  readonly rangeEnd: Float64Array;
  readonly sampleTime: Float64Array;
  readonly value: Float64Array;
  readonly resolutionMs: Float64Array;
}

interface SegmentLocation {
  readonly blockIndex: number;
  readonly segmentIndex: number;
}

const numberValue = (value: number): number => value;

/**
 * Selected signal reconstruction in sorted, cache-friendly typed-array blocks.
 *
 * Only the finest evidence seen at each interval is retained. Equal-quality
 * incoming evidence wins, while a late coarse response cannot overwrite fine
 * history. Each stored segment holds exactly one observed value over a
 * half-open interval, so observation identity is structural rather than
 * reconstructed from paired endpoints.
 *
 * Sampling performs one block binary search and one <=512-element binary
 * search per requested screen edge. It never walks observations skipped by a
 * zoomed-out pixel, so read cost depends on viewport width rather than history.
 */
export class SignalSegmentStore {
  private readonly blocks: SegmentBlock[] = [];
  private readonly profile: StoreProfile = new StoreProfile(allocateStoreId());
  private readonly insertTimer: InsertTimer = new InsertTimer();

  clear(): void {
    this.blocks.length = 0;
    this.profile.storeSegmentCount = 0;
  }

  timeInterval(): Interval | null {
    const first = this.blocks[0];
    const last = this.blocks[this.blocks.length - 1];
    return first !== undefined && last !== undefined
      ? Interval.create(blockStart(first), blockEnd(last))
      : null;
  }

  /** Write the latest selected observation at or before `time`; false leaves `out` unchanged. */
  readPointAtOrBefore(time: number, out: MutableSample): boolean {
    validateTime(time, "readPointAtOrBefore");
    const startedAt = performance.now();
    const location = this.findSegmentStartingAtOrBefore(time);
    const storeSegmentCount = this.profile.storeSegmentCount;
    if (location === null) {
      this.recordRead("readPointAtOrBefore", 1, startedAt, true, true, null, storeSegmentCount);
      return false;
    }
    const block = this.blocks[location.blockIndex]!;
    out.t = block.sampleTime[location.segmentIndex]!;
    out.value = block.value[location.segmentIndex]!;
    this.recordRead("readPointAtOrBefore", 1, startedAt, true, true, 1, storeSegmentCount);
    return true;
  }

  /** Overlay a sorted, internally non-overlapping batch. */
  insertBatch(incoming: readonly HeldSignalSegment[]): boolean {
    if (incoming.length === 0) return false;

    this.insertTimer.reset();
    this.insertTimer.begin();
    validateIncoming(incoming);
    this.insertTimer.end("validation");

    const incomingStart = incoming[0]!.range.start;
    const incomingEnd = incoming[incoming.length - 1]!.range.end;
    this.profile.recordWorkload(incoming[0]!.resolutionMs, incoming);

    const blockCountBefore = this.blocks.length;
    const storeSegmentCountBefore = this.profile.storeSegmentCount;

    if (this.blocks.length === 0) {
      this.insertTimer.begin();
      const replacement = chunkSegments(incoming);
      this.insertTimer.end("rechunking");
      this.insertTimer.begin();
      this.blocks.push(...replacement);
      this.insertTimer.end("splicing");
      this.profile.storeSegmentCount = countSegments(this.blocks);
      this.emitWrite({
        incomingCount: incoming.length,
        incomingStart,
        incomingEnd,
        storeSegmentCountBefore: 0,
        storeSegmentCountAfter: this.profile.storeSegmentCount,
        blockCountBefore: 0,
        blockCountAfter: this.blocks.length,
        directlyOverlappingBlockCount: 0,
        rewrittenBlockCount: 0,
        flattenedSegmentCount: 0,
        mergedSegmentCount: incoming.length,
        replacementBlockCount: replacement.length,
        position: "initial",
        changed: true,
      });
      return true;
    }

    const incomingRange = Interval.hull(incoming[0]!.range, incoming[incoming.length - 1]!.range);

    this.insertTimer.begin();
    const overlapping = this.overlappingBlocks(incomingRange);
    this.insertTimer.end("locating");

    // Pull in one neighboring leaf on each side. This coalesces small boundary
    // fragments and keeps the leaf set dense after repeated live updates.
    const spliceStart = Math.max(0, overlapping.start - 1);
    const spliceEnd = Math.min(this.blocks.length, overlapping.end + 1);
    const rewrittenBlockCount = spliceEnd - spliceStart;

    this.insertTimer.begin();
    const existing = flattenBlocks(this.blocks, spliceStart, spliceEnd);
    this.insertTimer.end("flattening");

    this.insertTimer.begin();
    const merged = overlay(existing, incoming);
    this.insertTimer.end("overlay");

    this.insertTimer.begin();
    const equal = segmentsEqual(existing, merged);
    this.insertTimer.end("equality");

    if (equal) {
      this.emitWrite({
        incomingCount: incoming.length,
        incomingStart,
        incomingEnd,
        storeSegmentCountBefore,
        storeSegmentCountAfter: storeSegmentCountBefore,
        blockCountBefore,
        blockCountAfter: blockCountBefore,
        directlyOverlappingBlockCount: Interval.span(overlapping),
        rewrittenBlockCount,
        flattenedSegmentCount: existing.length,
        mergedSegmentCount: existing.length,
        replacementBlockCount: rewrittenBlockCount,
        position: classifyWrite(
          incomingStart,
          incomingEnd,
          this.blocks[0] ? blockStart(this.blocks[0]) : null,
          this.blocks[this.blocks.length - 1]
            ? blockEnd(this.blocks[this.blocks.length - 1]!)
            : null,
        ),
        changed: false,
      });
      return false;
    }

    this.insertTimer.begin();
    const replacement = chunkSegments(merged);
    this.insertTimer.end("rechunking");

    this.insertTimer.begin();
    this.blocks.splice(spliceStart, rewrittenBlockCount, ...replacement);
    this.insertTimer.end("splicing");

    this.profile.storeSegmentCount = countSegments(this.blocks);

    this.emitWrite({
      incomingCount: incoming.length,
      incomingStart,
      incomingEnd,
      storeSegmentCountBefore,
      storeSegmentCountAfter: this.profile.storeSegmentCount,
      blockCountBefore,
      blockCountAfter: this.blocks.length,
      directlyOverlappingBlockCount: Interval.span(overlapping),
      rewrittenBlockCount,
      flattenedSegmentCount: existing.length,
      mergedSegmentCount: merged.length,
      replacementBlockCount: replacement.length,
      position: classifyWrite(
        incomingStart,
        incomingEnd,
        this.blocks[0] ? blockStart(this.blocks[0]) : null,
        this.blocks[this.blocks.length - 1] ? blockEnd(this.blocks[this.blocks.length - 1]!) : null,
      ),
      changed: true,
    });
    return true;
  }

  /**
   * Sample the selected reconstruction and, when supplied, record the exact
   * observation timestamp that supplied every grid value.
   */
  sample(
    evalTime: Float64Array,
    reuseValue?: Float64Array,
    sampleTime?: Float64Array,
  ): Float64Array {
    if (sampleTime !== undefined && sampleTime.length !== evalTime.length) {
      throw new Error(
        `SignalSegmentStore.sample: sample-time length ${sampleTime.length} does not match ${evalTime.length}`,
      );
    }
    const value =
      reuseValue?.length === evalTime.length ? reuseValue : new Float64Array(evalTime.length);

    const startedAt = performance.now();
    const storeSegmentCount = this.profile.storeSegmentCount;
    const visitedBlocks = new Set<number>();
    let evalCount = 0;

    for (let index = 0; index < evalTime.length; index++) {
      const t = evalTime[index]!;
      if (!Number.isFinite(t)) {
        throw new Error(`SignalSegmentStore.sample: non-finite time at ${index}`);
      }
      const location = this.findContainingSegment(t);
      if (location === null) {
        value[index] = NaN;
        if (sampleTime !== undefined) sampleTime[index] = NaN;
        continue;
      }
      evalCount++;
      visitedBlocks.add(location.blockIndex);
      const block = this.blocks[location.blockIndex]!;
      value[index] = block.value[location.segmentIndex]!;
      if (sampleTime !== undefined) sampleTime[index] = block.sampleTime[location.segmentIndex]!;
    }

    const analysis = analyzeEvalTime(evalTime);
    this.recordRead(
      "sample",
      evalCount,
      startedAt,
      analysis.sortedAscending,
      analysis.regularlySpaced,
      visitedBlocks.size,
      storeSegmentCount,
    );
    return value;
  }

  private recordRead(
    operation: "sample" | "readPointAtOrBefore",
    evalCount: number,
    startedAt: number,
    sortedAscending: boolean,
    regularlySpaced: boolean,
    distinctBlocksVisited: number | null,
    storeSegmentCount: number,
  ): void {
    this.profile.recordRead({
      storeId: this.profile.storeId,
      operation,
      evalCount,
      durationMs: performance.now() - startedAt,
      sortedAscending,
      regularlySpaced,
      distinctBlocksVisited,
      storeSegmentCount,
      frame: frameClock.frame(),
    });
  }

  private emitWrite(
    record: Omit<WriteRecord, "storeId" | "insertion" | "durationMs" | "phaseDurationMs">,
  ): void {
    const phaseDurationMs = this.insertTimer.snapshot();
    const durationMs =
      phaseDurationMs.validation +
      phaseDurationMs.locating +
      phaseDurationMs.flattening +
      phaseDurationMs.overlay +
      phaseDurationMs.equality +
      phaseDurationMs.rechunking +
      phaseDurationMs.splicing;
    const finalized: WriteRecord = {
      storeId: this.profile.storeId,
      insertion: ++this.profile.insertionCount,
      ...record,
      durationMs,
      phaseDurationMs,
    };
    this.profile.recordWrite(finalized);
  }

  private findContainingSegment(t: number): SegmentLocation | null {
    const location = this.findSegmentStartingAtOrBefore(t);
    if (location === null) return null;
    const block = this.blocks[location.blockIndex]!;
    return t < block.rangeEnd[location.segmentIndex]! ? location : null;
  }

  private findSegmentStartingAtOrBefore(t: number): SegmentLocation | null {
    const blockIndex = upperBoundBy(this.blocks, t, blockStart) - 1;
    if (blockIndex < 0) return null;
    const block = this.blocks[blockIndex]!;
    const segmentIndex = upperBoundBy(block.rangeStart, t, numberValue) - 1;
    return segmentIndex >= 0 ? { blockIndex, segmentIndex } : null;
  }

  /** Exact half-open block index interval whose block hulls overlap `range`. */
  private overlappingBlocks(range: Interval): Interval {
    if (Interval.isEmpty(range)) return Interval.empty(0);
    return Interval.create(
      upperBoundBy(this.blocks, range.start, blockEnd),
      lowerBoundBy(this.blocks, range.end, blockStart),
    );
  }
}

function countSegments(blocks: readonly SegmentBlock[]): number {
  let total = 0;
  for (let i = 0; i < blocks.length; i++) total += blockLength(blocks[i]!);
  return total;
}

function blockLength(block: SegmentBlock): number {
  return block.rangeStart.length;
}

function blockStart(block: SegmentBlock): number {
  return block.rangeStart[0]!;
}

function blockEnd(block: SegmentBlock): number {
  return block.rangeEnd[blockLength(block) - 1]!;
}

function segmentRange(block: SegmentBlock, index: number): Interval {
  return Interval.create(block.rangeStart[index]!, block.rangeEnd[index]!);
}

function chunkSegments(segments: readonly HeldSignalSegment[]): SegmentBlock[] {
  const blocks: SegmentBlock[] = [];
  for (let offset = 0; offset < segments.length; offset += MAX_BLOCK_LENGTH) {
    const length = Math.min(MAX_BLOCK_LENGTH, segments.length - offset);
    const rangeStart = new Float64Array(length);
    const rangeEnd = new Float64Array(length);
    const sampleTime = new Float64Array(length);
    const value = new Float64Array(length);
    const resolutionMs = new Float64Array(length);
    for (let index = 0; index < length; index++) {
      const segment = segments[offset + index]!;
      rangeStart[index] = segment.range.start;
      rangeEnd[index] = segment.range.end;
      sampleTime[index] = segment.sampleTime;
      value[index] = segment.value;
      resolutionMs[index] = segment.resolutionMs;
    }
    blocks.push({ rangeStart, rangeEnd, sampleTime, value, resolutionMs });
  }
  return blocks;
}

function flattenBlocks(
  blocks: readonly SegmentBlock[],
  start: number,
  end: number,
): HeldSignalSegment[] {
  const out: HeldSignalSegment[] = [];
  for (let blockIndex = start; blockIndex < end; blockIndex++) {
    const block = blocks[blockIndex]!;
    for (let segmentIndex = 0; segmentIndex < blockLength(block); segmentIndex++) {
      out.push({
        range: segmentRange(block, segmentIndex),
        sampleTime: block.sampleTime[segmentIndex]!,
        value: block.value[segmentIndex]!,
        resolutionMs: block.resolutionMs[segmentIndex]!,
      });
    }
  }
  return out;
}

function overlay(
  existing: readonly HeldSignalSegment[],
  incoming: readonly HeldSignalSegment[],
): HeldSignalSegment[] {
  const out: HeldSignalSegment[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  let cursor = Math.min(existing[0]?.range.start ?? Infinity, incoming[0]?.range.start ?? Infinity);

  while (Number.isFinite(cursor)) {
    while (existingIndex < existing.length && existing[existingIndex]!.range.end <= cursor) {
      existingIndex++;
    }
    while (incomingIndex < incoming.length && incoming[incomingIndex]!.range.end <= cursor) {
      incomingIndex++;
    }

    const existingActive =
      existingIndex < existing.length && Interval.contains(existing[existingIndex]!.range, cursor);
    const incomingActive =
      incomingIndex < incoming.length && Interval.contains(incoming[incomingIndex]!.range, cursor);
    let next = Infinity;
    if (existingIndex < existing.length) {
      const range = existing[existingIndex]!.range;
      next = Math.min(next, existingActive ? range.end : range.start);
    }
    if (incomingIndex < incoming.length) {
      const range = incoming[incomingIndex]!.range;
      next = Math.min(next, incomingActive ? range.end : range.start);
    }
    if (!Number.isFinite(next)) break;
    if (!(next > cursor)) {
      throw new Error(`SignalSegmentStore.overlay: stalled at ${cursor} -> ${next}`);
    }

    if (existingActive || incomingActive) {
      const useIncoming =
        incomingActive &&
        (!existingActive ||
          incoming[incomingIndex]!.resolutionMs <= existing[existingIndex]!.resolutionMs);
      const source = useIncoming ? incoming[incomingIndex]! : existing[existingIndex]!;
      appendSlice(out, {
        range: Interval.create(cursor, next),
        sampleTime: source.sampleTime,
        value: source.value,
        resolutionMs: source.resolutionMs,
      });
    }
    cursor = next;
  }
  return out;
}

function appendSlice(out: HeldSignalSegment[], segment: HeldSignalSegment): void {
  const previous = out[out.length - 1];
  if (
    previous !== undefined &&
    Interval.touches(previous.range, segment.range) &&
    previous.sampleTime === segment.sampleTime &&
    previous.value === segment.value &&
    previous.resolutionMs === segment.resolutionMs
  ) {
    out[out.length - 1] = { ...previous, range: Interval.hull(previous.range, segment.range) };
  } else {
    out.push(segment);
  }
}

function segmentsEqual(a: readonly HeldSignalSegment[], b: readonly HeldSignalSegment[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.range.start !== right.range.start ||
      left.range.end !== right.range.end ||
      left.sampleTime !== right.sampleTime ||
      left.value !== right.value ||
      left.resolutionMs !== right.resolutionMs
    ) {
      return false;
    }
  }
  return true;
}

function validateIncoming(segments: readonly HeldSignalSegment[]): void {
  let previous: HeldSignalSegment | undefined;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (Interval.isEmpty(segment.range)) {
      throw new Error(`SignalSegmentStore.insertBatch: empty range at ${index}`);
    }
    if (!Number.isFinite(segment.sampleTime) || segment.sampleTime > segment.range.start) {
      throw new Error(`SignalSegmentStore.insertBatch: invalid sample time at ${index}`);
    }
    if (!Number.isFinite(segment.value)) {
      throw new Error(`SignalSegmentStore.insertBatch: non-finite value at ${index}`);
    }
    validateResolution(segment.resolutionMs);
    if (previous !== undefined && !Interval.isBefore(previous.range, segment.range)) {
      throw new Error(`SignalSegmentStore.insertBatch: unsorted or overlapping range at ${index}`);
    }
    previous = segment;
  }
}

function validateTime(time: number, operation: string): void {
  if (!Number.isFinite(time)) {
    throw new Error(`SignalSegmentStore.${operation}: invalid time ${time}`);
  }
}

function validateResolution(resolutionMs: number): void {
  if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
    throw new Error(`SignalSegmentStore: invalid resolution ${resolutionMs}`);
  }
}
