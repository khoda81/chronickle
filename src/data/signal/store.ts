import { Range } from "../../engine/range.ts";
import type { MutableSample } from "./sample.ts";

const BLOCK_CAPACITY = 512;

/**
 * Zero-order-held reconstruction of one observed sample over `[rangeStart, rangeEnd)`.
 *
 * `sampleTime` identifies the observation that supplies `value`. It may precede
 * `rangeStart` when overlaying finer evidence slices an existing segment.
 */
export interface HeldSignalSegment {
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly sampleTime: number;
  readonly value: number;
  readonly resolutionMs: number;
}

export interface ResolutionSpan {
  readonly startTime: number;
  readonly endTime: number;
  readonly resolutionMs: number;
}

interface SegmentBlock {
  readonly rangeStart: Float64Array;
  readonly rangeEnd: Float64Array;
  readonly sampleTime: Float64Array;
  readonly value: Float64Array;
  readonly resolutionMs: Float64Array;
  readonly length: number;
  readonly minTime: number;
  readonly maxTime: number;
  readonly maxResolutionMs: number;
  /** Gaps between segments inside this block; excludes the preceding block boundary. */
  readonly internalGapCount: number;
}

interface SegmentLocation {
  readonly blockIndex: number;
  readonly segmentIndex: number;
}

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

  clear(): void {
    this.blocks.length = 0;
  }

  timeRange(): Range | null {
    const first = this.blocks[0];
    const last = this.blocks[this.blocks.length - 1];
    return first !== undefined && last !== undefined
      ? Range.create(first.minTime, last.maxTime)
      : null;
  }

  /** Write the latest selected observation at or before `time`; false leaves `out` unchanged. */
  readPointAtOrBefore(time: number, out: MutableSample): boolean {
    validateTime(time, "readPointAtOrBefore");
    const location = this.findSegmentStartingAtOrBefore(time);
    if (location === null) return false;
    const block = this.blocks[location.blockIndex]!;
    out.t = block.sampleTime[location.segmentIndex]!;
    out.value = block.value[location.segmentIndex]!;
    return true;
  }

  /** Overlay a sorted, internally non-overlapping batch. */
  insertBatch(incoming: readonly HeldSignalSegment[]): boolean {
    if (incoming.length === 0) return false;
    validateIncoming(incoming);

    if (this.blocks.length === 0) {
      this.blocks.push(...chunkSegments(incoming));
      return true;
    }

    const incomingMin = incoming[0]!.rangeStart;
    const incomingMax = incoming[incoming.length - 1]!.rangeEnd;
    const firstOverlap = this.firstBlockEndingAfter(incomingMin);
    const firstAfter = this.firstBlockStartingAtOrAfter(incomingMax);

    // Pull in one neighboring leaf on each side. This coalesces small boundary
    // fragments and keeps the leaf set dense after repeated live updates.
    const spliceStart = Math.max(0, Math.min(firstOverlap, this.blocks.length) - 1);
    const spliceEnd = Math.min(this.blocks.length, Math.max(firstOverlap, firstAfter) + 1);
    const existing = flattenBlocks(this.blocks, spliceStart, spliceEnd);
    const merged = overlay(existing, incoming);
    if (segmentsEqual(existing, merged)) return false;
    const replacement = chunkSegments(merged);

    this.blocks.splice(spliceStart, spliceEnd - spliceStart, ...replacement);
    return true;
  }

  sample(evalTime: Float64Array, wallNow: number, reuseValue?: Float64Array): Float64Array {
    validateTime(wallNow, "sample now");
    const value =
      reuseValue?.length === evalTime.length ? reuseValue : new Float64Array(evalTime.length);

    for (let index = 0; index < evalTime.length; index++) {
      const t = evalTime[index]!;
      if (!Number.isFinite(t)) {
        throw new Error(`SignalSegmentStore.sample: non-finite time at ${index}`);
      }
      if (t > wallNow) {
        value[index] = NaN;
        continue;
      }
      const location = this.findContainingSegment(t);
      value[index] =
        location === null ? NaN : this.blocks[location.blockIndex]!.value[location.segmentIndex]!;
    }
    return value;
  }

  /** Add acceptable selected coverage, clipped to `range`, to `out`. */
  addReadyBlockers(out: { add(range: Range): void }, maxResolutionMs: number, range: Range): void {
    validateResolution(maxResolutionMs);
    if (this.blocks.length === 0) return;
    const firstBlock = this.firstBlockEndingAtOrAfter(range.min);
    const lastBlock = this.lastBlockStartingAtOrBefore(range.max);
    if (firstBlock > lastBlock) return;

    let runMin = NaN;
    let runMax = NaN;
    const append = (min: number, max: number): void => {
      if (!(min < max)) return;
      if (Number.isFinite(runMax) && min <= runMax) {
        runMax = Math.max(runMax, max);
        return;
      }
      if (Number.isFinite(runMin)) out.add(Range.create(runMin, runMax));
      runMin = min;
      runMax = max;
    };

    for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex++) {
      const block = this.blocks[blockIndex]!;
      if (block.maxTime < range.min || block.minTime > range.max) continue;
      if (block.maxResolutionMs <= maxResolutionMs && block.internalGapCount === 0) {
        append(Math.max(range.min, block.minTime), Math.min(range.max, block.maxTime));
        continue;
      }
      for (let segmentIndex = 0; segmentIndex < block.length; segmentIndex++) {
        if (block.resolutionMs[segmentIndex]! > maxResolutionMs) continue;
        append(
          Math.max(range.min, block.rangeStart[segmentIndex]!),
          Math.min(range.max, block.rangeEnd[segmentIndex]!),
        );
      }
    }
    if (Number.isFinite(runMin)) out.add(Range.create(runMin, runMax));
  }

  /** Resolution at cell midpoints, coalesced to at most one span per cell. */
  segments(evalTime: Float64Array, wallNow: number): ResolutionSpan[] {
    const out: ResolutionSpan[] = [];
    if (evalTime.length < 2) return out;
    for (let index = 0; index + 1 < evalTime.length; index++) {
      const min = evalTime[index]!;
      const max = Math.min(evalTime[index + 1]!, wallNow);
      if (!(min < max)) continue;
      const location = this.findContainingSegment(min + (max - min) / 2);
      if (location === null) continue;
      const resolutionMs = this.blocks[location.blockIndex]!.resolutionMs[location.segmentIndex]!;
      const previous = out[out.length - 1];
      if (
        previous !== undefined &&
        previous.endTime === min &&
        previous.resolutionMs === resolutionMs
      ) {
        out[out.length - 1] = { ...previous, endTime: max };
      } else {
        out.push({ startTime: min, endTime: max, resolutionMs });
      }
    }
    return out;
  }

  private findContainingSegment(t: number): SegmentLocation | null {
    const location = this.findSegmentStartingAtOrBefore(t);
    if (location === null) return null;
    const block = this.blocks[location.blockIndex]!;
    return t < block.rangeEnd[location.segmentIndex]! ? location : null;
  }

  private findSegmentStartingAtOrBefore(t: number): SegmentLocation | null {
    if (this.blocks.length === 0) return null;
    let lo = 0;
    let hi = this.blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.blocks[mid]!.minTime <= t) lo = mid + 1;
      else hi = mid;
    }
    const blockIndex = lo - 1;
    if (blockIndex < 0) return null;
    const block = this.blocks[blockIndex]!;
    let innerLo = 0;
    let innerHi = block.length;
    while (innerLo < innerHi) {
      const mid = (innerLo + innerHi) >>> 1;
      if (block.rangeStart[mid]! <= t) innerLo = mid + 1;
      else innerHi = mid;
    }
    const segmentIndex = innerLo - 1;
    return segmentIndex >= 0 ? { blockIndex, segmentIndex } : null;
  }

  private firstBlockEndingAfter(t: number): number {
    let lo = 0;
    let hi = this.blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.blocks[mid]!.maxTime <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private firstBlockEndingAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.blocks[mid]!.maxTime < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private firstBlockStartingAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.blocks[mid]!.minTime < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private lastBlockStartingAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.blocks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.blocks[mid]!.minTime <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
}

function chunkSegments(segments: readonly HeldSignalSegment[]): SegmentBlock[] {
  const blocks: SegmentBlock[] = [];
  for (let offset = 0; offset < segments.length; offset += BLOCK_CAPACITY) {
    const length = Math.min(BLOCK_CAPACITY, segments.length - offset);
    const rangeStart = new Float64Array(length);
    const rangeEnd = new Float64Array(length);
    const sampleTime = new Float64Array(length);
    const value = new Float64Array(length);
    const resolutionMs = new Float64Array(length);
    let maxResolutionMs = Number.NEGATIVE_INFINITY;
    let internalGapCount = 0;
    for (let index = 0; index < length; index++) {
      const segment = segments[offset + index]!;
      rangeStart[index] = segment.rangeStart;
      rangeEnd[index] = segment.rangeEnd;
      sampleTime[index] = segment.sampleTime;
      value[index] = segment.value;
      resolutionMs[index] = segment.resolutionMs;
      maxResolutionMs = Math.max(maxResolutionMs, segment.resolutionMs);
      if (index > 0 && rangeEnd[index - 1]! < segment.rangeStart) internalGapCount++;
    }
    blocks.push({
      rangeStart,
      rangeEnd,
      sampleTime,
      value,
      resolutionMs,
      length,
      minTime: rangeStart[0]!,
      maxTime: rangeEnd[length - 1]!,
      maxResolutionMs,
      internalGapCount,
    });
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
    for (let segmentIndex = 0; segmentIndex < block.length; segmentIndex++) {
      out.push({
        rangeStart: block.rangeStart[segmentIndex]!,
        rangeEnd: block.rangeEnd[segmentIndex]!,
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
  let cursor = Math.min(existing[0]?.rangeStart ?? Infinity, incoming[0]?.rangeStart ?? Infinity);

  while (Number.isFinite(cursor)) {
    while (existingIndex < existing.length && existing[existingIndex]!.rangeEnd <= cursor) {
      existingIndex++;
    }
    while (incomingIndex < incoming.length && incoming[incomingIndex]!.rangeEnd <= cursor) {
      incomingIndex++;
    }

    const existingActive =
      existingIndex < existing.length && existing[existingIndex]!.rangeStart <= cursor;
    const incomingActive =
      incomingIndex < incoming.length && incoming[incomingIndex]!.rangeStart <= cursor;
    let next = Infinity;
    if (existingActive) next = Math.min(next, existing[existingIndex]!.rangeEnd);
    else if (existingIndex < existing.length)
      next = Math.min(next, existing[existingIndex]!.rangeStart);
    if (incomingActive) next = Math.min(next, incoming[incomingIndex]!.rangeEnd);
    else if (incomingIndex < incoming.length)
      next = Math.min(next, incoming[incomingIndex]!.rangeStart);
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
        rangeStart: cursor,
        rangeEnd: next,
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
    previous.rangeEnd === segment.rangeStart &&
    previous.sampleTime === segment.sampleTime &&
    previous.value === segment.value &&
    previous.resolutionMs === segment.resolutionMs
  ) {
    out[out.length - 1] = { ...previous, rangeEnd: segment.rangeEnd };
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
      left.rangeStart !== right.rangeStart ||
      left.rangeEnd !== right.rangeEnd ||
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
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (
      !Number.isFinite(segment.rangeStart) ||
      !Number.isFinite(segment.rangeEnd) ||
      !(segment.rangeStart < segment.rangeEnd)
    ) {
      throw new Error(`SignalSegmentStore.insertBatch: invalid range at ${index}`);
    }
    if (!Number.isFinite(segment.sampleTime) || segment.sampleTime > segment.rangeStart) {
      throw new Error(`SignalSegmentStore.insertBatch: invalid sample time at ${index}`);
    }
    if (!Number.isFinite(segment.value)) {
      throw new Error(`SignalSegmentStore.insertBatch: non-finite value at ${index}`);
    }
    validateResolution(segment.resolutionMs);
    if (segment.rangeStart < previousEnd) {
      throw new Error(`SignalSegmentStore.insertBatch: overlapping incoming segments at ${index}`);
    }
    previousEnd = segment.rangeEnd;
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
