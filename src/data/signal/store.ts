import { lowerBoundBy, upperBoundBy } from "../../core/binarySearch.ts";
import { Interval } from "../../core/interval.ts";
import type { MutableSample, Sample } from "./sample.ts";

const MAX_BLOCK_LENGTH = 512;
const MAX_SAMPLE_BLOCK_LENGTH = 1_024;

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
  private readonly sampleTimes = new SampleTimeIndex();

  clear(): void {
    this.blocks.length = 0;
    this.sampleTimes.clear();
  }

  /** Retain unique observation timestamps independently of ZOH reconstruction. */
  insertSamples(samples: readonly Sample[]): void {
    this.sampleTimes.add(samples);
  }

  /**
   * Count observations per equal-width time bin and normalize by the requested
   * cadence. Whole timestamp blocks are counted without visiting each sample.
   */
  sampleDensity(
    range: Interval,
    binCount: number,
    targetSamplePeriodMs: number,
    reuse?: Float64Array,
  ): Float64Array {
    return this.sampleTimes.density(range, binCount, targetSamplePeriodMs, reuse);
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

    const incomingRange = Interval.hull(incoming[0]!.range, incoming[incoming.length - 1]!.range);
    const overlapping = this.overlappingBlocks(incomingRange);

    // Pull in one neighboring leaf on each side. This coalesces small boundary
    // fragments and keeps the leaf set dense after repeated live updates.
    const spliceStart = Math.max(0, overlapping.start - 1);
    const spliceEnd = Math.min(this.blocks.length, overlapping.end + 1);
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

/** Sorted unique observation timestamps in fixed-size immutable leaves. */
class SampleTimeIndex {
  private readonly blocks: Float64Array[] = [];

  clear(): void {
    this.blocks.length = 0;
  }

  add(samples: readonly Sample[]): void {
    if (samples.length === 0) return;
    const first = samples[0]!.t;
    const last = samples[samples.length - 1]!.t;
    const overlapStart = lowerBoundBy(this.blocks, first, sampleBlockEnd);
    const overlapEnd = upperBoundBy(this.blocks, last, sampleBlockStart, overlapStart);
    // Include neighboring leaves so repeated live singleton deliveries fill a
    // bounded block instead of degrading into one block per observation.
    const spliceStart = Math.max(0, overlapStart - 1);
    const spliceEnd = Math.min(this.blocks.length, overlapEnd + 1);
    const existingLength = countSampleBlockItems(this.blocks, spliceStart, spliceEnd);
    const merged = new Float64Array(existingLength + samples.length);
    let existingBlock = spliceStart;
    let existingIndex = 0;
    let sampleIndex = 0;
    let outputLength = 0;

    const existingTime = (): number => {
      while (existingBlock < spliceEnd && existingIndex >= this.blocks[existingBlock]!.length) {
        existingBlock++;
        existingIndex = 0;
      }
      return existingBlock < spliceEnd
        ? this.blocks[existingBlock]![existingIndex]!
        : Number.POSITIVE_INFINITY;
    };

    while (existingBlock < spliceEnd || sampleIndex < samples.length) {
      const cached = existingTime();
      const incoming = samples[sampleIndex]?.t ?? Number.POSITIVE_INFINITY;
      const next = Math.min(cached, incoming);
      if (merged[outputLength - 1] !== next) merged[outputLength++] = next;
      if (cached === next) existingIndex++;
      if (incoming === next) sampleIndex++;
    }

    const replacement: Float64Array[] = [];
    for (let offset = 0; offset < outputLength; offset += MAX_SAMPLE_BLOCK_LENGTH) {
      replacement.push(
        merged.slice(offset, Math.min(outputLength, offset + MAX_SAMPLE_BLOCK_LENGTH)),
      );
    }
    this.blocks.splice(spliceStart, spliceEnd - spliceStart, ...replacement);
  }

  density(
    range: Interval,
    binCount: number,
    targetSamplePeriodMs: number,
    reuse?: Float64Array,
  ): Float64Array {
    if (!Number.isInteger(binCount) || binCount < 0) {
      throw new Error(`SignalSegmentStore.sampleDensity: invalid bin count ${binCount}`);
    }
    validateResolution(targetSamplePeriodMs);
    const out = reuse?.length === binCount ? reuse : new Float64Array(binCount);
    out.fill(0);
    if (binCount === 0 || Interval.isEmpty(range) || this.blocks.length === 0) return out;

    const binSpan = Interval.span(range) / binCount;
    let blockIndex = lowerBoundBy(this.blocks, range.start, sampleBlockEnd);
    let itemIndex =
      blockIndex < this.blocks.length
        ? lowerBoundBy(this.blocks[blockIndex]!, range.start, numberValue)
        : 0;

    for (let bin = 0; bin < binCount; bin++) {
      const binEnd = bin + 1 === binCount ? range.end : range.start + (bin + 1) * binSpan;
      let count = 0;
      while (blockIndex < this.blocks.length) {
        const block = this.blocks[blockIndex]!;
        if (itemIndex >= block.length) {
          blockIndex++;
          itemIndex = 0;
          continue;
        }
        if (block[itemIndex]! >= binEnd) break;
        if (itemIndex === 0 && sampleBlockEnd(block) < binEnd) {
          count += block.length;
          blockIndex++;
          continue;
        }
        while (itemIndex < block.length && block[itemIndex]! < binEnd) {
          count++;
          itemIndex++;
        }
      }
      out[bin] = Math.min(1, (count * targetSamplePeriodMs) / binSpan);
    }
    return out;
  }
}

function countSampleBlockItems(
  blocks: readonly Float64Array[],
  start: number,
  end: number,
): number {
  let count = 0;
  for (let index = start; index < end; index++) count += blocks[index]!.length;
  return count;
}

function sampleBlockStart(block: Float64Array): number {
  return block[0]!;
}

function sampleBlockEnd(block: Float64Array): number {
  return block[block.length - 1]!;
}

function validateResolution(resolutionMs: number): void {
  if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
    throw new Error(`SignalSegmentStore: invalid resolution ${resolutionMs}`);
  }
}
