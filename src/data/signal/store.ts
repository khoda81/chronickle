import { Range } from "../../engine/range.ts";

const BLOCK_CAPACITY = 512;

/**
 * A reconstruction span derived from observed samples at a source cadence.
 * It supports zero-order-hold rendering; it is not evidence that every value
 * inside the interval was directly observed.
 */
export interface SignalSpan {
  readonly startTime: number;
  readonly endTime: number;
  readonly startValue: number;
  readonly endValue: number;
  readonly resolutionMs: number;
}

export interface ResolutionSpan {
  readonly startTime: number;
  readonly endTime: number;
  readonly resolutionMs: number;
}

export interface SampleResult {
  readonly value: Float64Array;
}

interface SpanBlock {
  readonly startTime: Float64Array;
  readonly endTime: Float64Array;
  readonly startValue: Float64Array;
  readonly endValue: Float64Array;
  readonly resolutionMs: Float64Array;
  readonly length: number;
  readonly minTime: number;
  readonly maxTime: number;
  readonly maxResolutionMs: number;
  /** Gaps between spans inside this block; excludes the preceding block boundary. */
  readonly internalGapCount: number;
}

interface SpanLocation {
  readonly blockIndex: number;
  readonly spanIndex: number;
}

/**
 * Selected signal reconstruction in sorted, cache-friendly typed-array blocks.
 *
 * Only the finest evidence seen at each interval is retained. Equal-quality
 * incoming evidence wins, while a late coarse response cannot overwrite fine
 * history. Blocks are structure-of-arrays typed buffers. Backfills touch only
 * overlapping blocks plus their neighbors.
 *
 * Sampling performs one block binary search and one <=512-element binary
 * search per requested screen edge. It never walks observations skipped by a
 * zoomed-out pixel, so read cost depends on viewport width rather than history.
 */
export class SignalSpanStore {
  private readonly blocks: SpanBlock[] = [];
  private totalSpanCount = 0;

  clear(): void {
    this.blocks.length = 0;
    this.totalSpanCount = 0;
  }

  get spanCount(): number {
    return this.totalSpanCount;
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  timeRange(): Range | null {
    const first = this.blocks[0];
    const last = this.blocks[this.blocks.length - 1];
    return first !== undefined && last !== undefined
      ? Range.create(first.minTime, last.maxTime)
      : null;
  }

  /** Latest reconstructed value at or before `time`, including after the final span. */
  valueAtOrBefore(time: number): number | null {
    if (!Number.isFinite(time)) {
      throw new Error(`SignalSpanStore.valueAtOrBefore: invalid time ${time}`);
    }
    const location = this.findSpanStartingAtOrBefore(time);
    if (location === null) return null;
    const selected = this.selectBoundaryOwner(location, time);
    const block = this.blocks[selected.blockIndex]!;
    return time >= block.endTime[selected.spanIndex]!
      ? block.endValue[selected.spanIndex]!
      : block.startValue[selected.spanIndex]!;
  }

  /** Overlay a sorted, internally non-overlapping batch. */
  insertBatch(incoming: readonly SignalSpan[]): boolean {
    if (incoming.length === 0) return false;
    validateIncoming(incoming);

    if (this.blocks.length === 0) {
      this.blocks.push(...chunkSpans(incoming));
      this.totalSpanCount = incoming.length;
      return true;
    }

    const incomingMin = incoming[0]!.startTime;
    const incomingMax = incoming[incoming.length - 1]!.endTime;
    const firstOverlap = this.firstBlockEndingAfter(incomingMin);
    const firstAfter = this.firstBlockStartingAtOrAfter(incomingMax);

    // Pull in one neighboring leaf on each side. This coalesces small boundary
    // fragments and keeps the B+ tree dense after repeated live updates.
    const spliceStart = Math.max(0, Math.min(firstOverlap, this.blocks.length) - 1);
    const spliceEnd = Math.min(this.blocks.length, Math.max(firstOverlap, firstAfter) + 1);
    const existing = flattenBlocks(this.blocks, spliceStart, spliceEnd);
    const merged = overlay(existing, incoming);
    if (spansEqual(existing, merged)) return false;
    const replacement = chunkSpans(merged);

    let removedCount = 0;
    for (let index = spliceStart; index < spliceEnd; index++) {
      removedCount += this.blocks[index]!.length;
    }
    this.blocks.splice(spliceStart, spliceEnd - spliceStart, ...replacement);
    this.totalSpanCount += merged.length - removedCount;
    return true;
  }

  sample(evalTime: Float64Array, wallNow: number, reuseValue?: Float64Array): SampleResult {
    if (!Number.isFinite(wallNow))
      throw new Error(`SignalSpanStore.sample: invalid now ${wallNow}`);
    const value =
      reuseValue?.length === evalTime.length ? reuseValue : new Float64Array(evalTime.length);

    for (let index = 0; index < evalTime.length; index++) {
      const t = evalTime[index]!;
      if (!Number.isFinite(t)) {
        throw new Error(`SignalSpanStore.sample: non-finite time at ${index}`);
      }
      if (t > wallNow) {
        value[index] = NaN;
        continue;
      }
      const location = this.findContainingSpan(t);
      if (location === null) {
        value[index] = NaN;
        continue;
      }
      const selected = this.selectBoundaryOwner(location, t);
      const block = this.blocks[selected.blockIndex]!;
      value[index] =
        t === block.endTime[selected.spanIndex]!
          ? block.endValue[selected.spanIndex]!
          : block.startValue[selected.spanIndex]!;
    }
    return { value };
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
      for (let spanIndex = 0; spanIndex < block.length; spanIndex++) {
        if (block.resolutionMs[spanIndex]! > maxResolutionMs) continue;
        append(
          Math.max(range.min, block.startTime[spanIndex]!),
          Math.min(range.max, block.endTime[spanIndex]!),
        );
      }
    }
    if (Number.isFinite(runMin)) out.add(Range.create(runMin, runMax));
  }

  /** Resolution at cell midpoints, coalesced to at most one segment per cell. */
  segments(evalTime: Float64Array, wallNow: number): ResolutionSpan[] {
    const out: ResolutionSpan[] = [];
    if (evalTime.length < 2) return out;
    for (let index = 0; index + 1 < evalTime.length; index++) {
      const min = evalTime[index]!;
      const max = Math.min(evalTime[index + 1]!, wallNow);
      if (!(min < max)) continue;
      const location = this.findContainingSpan(min + (max - min) / 2);
      if (location === null) continue;
      const resolutionMs = this.blocks[location.blockIndex]!.resolutionMs[location.spanIndex]!;
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

  private selectBoundaryOwner(location: SpanLocation, t: number): SpanLocation {
    const block = this.blocks[location.blockIndex]!;
    if (t !== block.startTime[location.spanIndex]!) return location;
    const previous = this.previousLocation(location);
    if (previous === null) return location;
    const previousBlock = this.blocks[previous.blockIndex]!;
    if (previousBlock.endTime[previous.spanIndex]! !== t) return location;
    return previousBlock.resolutionMs[previous.spanIndex]! < block.resolutionMs[location.spanIndex]!
      ? previous
      : location;
  }

  private findContainingSpan(t: number): SpanLocation | null {
    const location = this.findSpanStartingAtOrBefore(t);
    if (location === null) return null;
    const block = this.blocks[location.blockIndex]!;
    return t <= block.endTime[location.spanIndex]! ? location : null;
  }

  private findSpanStartingAtOrBefore(t: number): SpanLocation | null {
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
      if (block.startTime[mid]! <= t) innerLo = mid + 1;
      else innerHi = mid;
    }
    const spanIndex = innerLo - 1;
    return spanIndex >= 0 ? { blockIndex, spanIndex } : null;
  }

  private previousLocation(location: SpanLocation): SpanLocation | null {
    if (location.spanIndex > 0) {
      return { blockIndex: location.blockIndex, spanIndex: location.spanIndex - 1 };
    }
    if (location.blockIndex === 0) return null;
    const blockIndex = location.blockIndex - 1;
    return { blockIndex, spanIndex: this.blocks[blockIndex]!.length - 1 };
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

function chunkSpans(spans: readonly SignalSpan[]): SpanBlock[] {
  const blocks: SpanBlock[] = [];
  for (let offset = 0; offset < spans.length; offset += BLOCK_CAPACITY) {
    const length = Math.min(BLOCK_CAPACITY, spans.length - offset);
    const startTime = new Float64Array(length);
    const endTime = new Float64Array(length);
    const startValue = new Float64Array(length);
    const endValue = new Float64Array(length);
    const resolutionMs = new Float64Array(length);
    let maxResolutionMs = Number.NEGATIVE_INFINITY;
    let internalGapCount = 0;
    for (let index = 0; index < length; index++) {
      const span = spans[offset + index]!;
      startTime[index] = span.startTime;
      endTime[index] = span.endTime;
      startValue[index] = span.startValue;
      endValue[index] = span.endValue;
      resolutionMs[index] = span.resolutionMs;
      maxResolutionMs = Math.max(maxResolutionMs, span.resolutionMs);
      if (index > 0 && endTime[index - 1]! < span.startTime) internalGapCount++;
    }
    blocks.push({
      startTime,
      endTime,
      startValue,
      endValue,
      resolutionMs,
      length,
      minTime: startTime[0]!,
      maxTime: endTime[length - 1]!,
      maxResolutionMs,
      internalGapCount,
    });
  }
  return blocks;
}

function flattenBlocks(blocks: readonly SpanBlock[], start: number, end: number): SignalSpan[] {
  const out: SignalSpan[] = [];
  for (let blockIndex = start; blockIndex < end; blockIndex++) {
    const block = blocks[blockIndex]!;
    for (let spanIndex = 0; spanIndex < block.length; spanIndex++) {
      out.push({
        startTime: block.startTime[spanIndex]!,
        endTime: block.endTime[spanIndex]!,
        startValue: block.startValue[spanIndex]!,
        endValue: block.endValue[spanIndex]!,
        resolutionMs: block.resolutionMs[spanIndex]!,
      });
    }
  }
  return out;
}

function overlay(existing: readonly SignalSpan[], incoming: readonly SignalSpan[]): SignalSpan[] {
  const out: SignalSpan[] = [];
  let existingIndex = 0;
  let incomingIndex = 0;
  let cursor = Math.min(existing[0]?.startTime ?? Infinity, incoming[0]?.startTime ?? Infinity);

  while (Number.isFinite(cursor)) {
    while (existingIndex < existing.length && existing[existingIndex]!.endTime <= cursor) {
      existingIndex++;
    }
    while (incomingIndex < incoming.length && incoming[incomingIndex]!.endTime <= cursor) {
      incomingIndex++;
    }

    const existingActive =
      existingIndex < existing.length && existing[existingIndex]!.startTime <= cursor;
    const incomingActive =
      incomingIndex < incoming.length && incoming[incomingIndex]!.startTime <= cursor;
    let next = Infinity;
    if (existingActive) next = Math.min(next, existing[existingIndex]!.endTime);
    else if (existingIndex < existing.length)
      next = Math.min(next, existing[existingIndex]!.startTime);
    if (incomingActive) next = Math.min(next, incoming[incomingIndex]!.endTime);
    else if (incomingIndex < incoming.length)
      next = Math.min(next, incoming[incomingIndex]!.startTime);
    if (!Number.isFinite(next)) break;
    if (!(next > cursor))
      throw new Error(`SignalSpanStore.overlay: stalled at ${cursor} -> ${next}`);

    if (existingActive || incomingActive) {
      const useIncoming =
        incomingActive &&
        (!existingActive ||
          incoming[incomingIndex]!.resolutionMs <= existing[existingIndex]!.resolutionMs);
      const source = useIncoming ? incoming[incomingIndex]! : existing[existingIndex]!;
      appendSlice(out, {
        startTime: cursor,
        endTime: next,
        startValue: source.startValue,
        endValue: next === source.endTime ? source.endValue : source.startValue,
        resolutionMs: source.resolutionMs,
      });
    }
    cursor = next;
  }
  return out;
}

function appendSlice(out: SignalSpan[], span: SignalSpan): void {
  const previous = out[out.length - 1];
  if (
    previous !== undefined &&
    previous.endTime === span.startTime &&
    previous.resolutionMs === span.resolutionMs &&
    previous.startValue === previous.endValue &&
    previous.endValue === span.startValue
  ) {
    out[out.length - 1] = { ...previous, endTime: span.endTime, endValue: span.endValue };
  } else {
    out.push(span);
  }
}

function spansEqual(a: readonly SignalSpan[], b: readonly SignalSpan[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.startTime !== right.startTime ||
      left.endTime !== right.endTime ||
      left.startValue !== right.startValue ||
      left.endValue !== right.endValue ||
      left.resolutionMs !== right.resolutionMs
    ) {
      return false;
    }
  }
  return true;
}

function validateIncoming(spans: readonly SignalSpan[]): void {
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    if (
      !Number.isFinite(span.startTime) ||
      !Number.isFinite(span.endTime) ||
      !(span.startTime < span.endTime)
    ) {
      throw new Error(`SignalSpanStore.insertBatch: invalid span at ${index}`);
    }
    if (!Number.isFinite(span.startValue) || !Number.isFinite(span.endValue)) {
      throw new Error(`SignalSpanStore.insertBatch: non-finite value at ${index}`);
    }
    validateResolution(span.resolutionMs);
    if (span.startTime < previousEnd) {
      throw new Error(`SignalSpanStore.insertBatch: overlapping incoming spans at ${index}`);
    }
    previousEnd = span.endTime;
  }
}

function validateResolution(resolutionMs: number): void {
  if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
    throw new Error(`SignalSpanStore: invalid resolution ${resolutionMs}`);
  }
}
