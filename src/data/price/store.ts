import { Range } from "../../engine/range.ts";

const BLOCK_CAPACITY = 512;

/** One observed zero-order-hold interval. */
export interface SignalSpan {
  readonly startTime: number;
  readonly endTime: number;
  readonly startValue: number;
  readonly endValue: number;
  readonly resolutionMs: number;
}

export interface PriceResolutionSpan {
  readonly startTime: number;
  readonly endTime: number;
  readonly resolutionMs: number;
}

export interface PriceSampleResult {
  readonly value: Float64Array;
  readonly resolutionMs: Float64Array;
}

interface SpanBlock {
  readonly startTime: Float64Array;
  readonly endTime: Float64Array;
  readonly startLogPrice: Float64Array;
  readonly endLogPrice: Float64Array;
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
 * Selected price history in a shallow, cache-friendly B+ tree.
 *
 * Only the finest evidence seen at each interval is retained. Equal-quality
 * incoming evidence wins, while a late coarse response cannot overwrite fine
 * history. Leaf blocks are structure-of-arrays typed buffers. Backfills touch
 * only overlapping leaves plus their neighbors; the block directory and its
 * compact quality tree are rebuilt in O(number of blocks), not O(points).
 *
 * Sampling performs one block binary search and one <=512-element binary
 * search per requested screen edge. It never walks observations skipped by a
 * zoomed-out pixel, so read cost depends on viewport width rather than history.
 */
export class SignalSpanStore {
  private readonly blocks: SpanBlock[] = [];
  private totalSpanCount = 0;

  private treeBase = 1;
  private treeMaxResolution = new Float64Array(2);
  private treeGapCount = new Uint32Array(2);

  clear(): void {
    this.blocks.length = 0;
    this.totalSpanCount = 0;
    this.treeBase = 1;
    this.treeMaxResolution = new Float64Array(2);
    this.treeGapCount = new Uint32Array(2);
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

  /** Latest observed log price at or before `time`, including after the final span. */
  logPriceAtOrBefore(time: number): number | null {
    if (!Number.isFinite(time)) {
      throw new Error(`PriceSpanStore.logPriceAtOrBefore: invalid time ${time}`);
    }
    const location = this.findSpanStartingAtOrBefore(time);
    if (location === null) return null;
    const selected = this.selectBoundaryOwner(location, time);
    const block = this.blocks[selected.blockIndex]!;
    return time >= block.endTime[selected.spanIndex]!
      ? block.endLogPrice[selected.spanIndex]!
      : block.startLogPrice[selected.spanIndex]!;
  }

  /** Overlay a sorted, internally non-overlapping batch. */
  insertBatch(incoming: readonly SignalSpan[]): void {
    if (incoming.length === 0) return;
    validateIncoming(incoming);

    if (this.blocks.length === 0) {
      this.blocks.push(...chunkSpans(incoming));
      this.totalSpanCount = incoming.length;
      this.rebuildSummaryTree();
      return;
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
    const replacement = chunkSpans(merged);

    let removedCount = 0;
    for (let index = spliceStart; index < spliceEnd; index++) {
      removedCount += this.blocks[index]!.length;
    }
    this.blocks.splice(spliceStart, spliceEnd - spliceStart, ...replacement);
    this.totalSpanCount += merged.length - removedCount;
    this.rebuildSummaryTree();
  }

  sample(
    evalTime: Float64Array,
    wallNow: number,
    reuseValue?: Float64Array,
    reuseResolution?: Float64Array,
  ): PriceSampleResult {
    if (!Number.isFinite(wallNow)) throw new Error(`PriceSpanStore.sample: invalid now ${wallNow}`);
    const value =
      reuseValue?.length === evalTime.length ? reuseValue : new Float64Array(evalTime.length);
    const resolution =
      reuseResolution?.length === evalTime.length
        ? reuseResolution
        : new Float64Array(evalTime.length);

    for (let index = 0; index < evalTime.length; index++) {
      const t = evalTime[index]!;
      if (!Number.isFinite(t))
        throw new Error(`PriceSpanStore.sample: non-finite time at ${index}`);
      if (t > wallNow) {
        value[index] = NaN;
        resolution[index] = NaN;
        continue;
      }

      const location = this.findContainingSpan(t);
      if (location === null) {
        value[index] = NaN;
        resolution[index] = NaN;
        continue;
      }

      const selected = this.selectBoundaryOwner(location, t);
      const block = this.blocks[selected.blockIndex]!;
      value[index] =
        t === block.endTime[selected.spanIndex]!
          ? block.endLogPrice[selected.spanIndex]!
          : block.startLogPrice[selected.spanIndex]!;
      resolution[index] = block.resolutionMs[selected.spanIndex]!;
    }
    return { value, resolutionMs: resolution };
  }

  /** True when selected evidence covers all of `range` at acceptable quality. */
  answers(range: Range, maxResolutionMs: number): boolean {
    validateResolution(maxResolutionMs);
    const first = this.findContainingSpan(range.min);
    const last = this.findContainingSpan(range.max);
    if (first === null || last === null) return false;
    if (compareLocations(first, last) > 0) return false;

    if (first.blockIndex === last.blockIndex) {
      return this.scanQuality(first, last, maxResolutionMs);
    }

    const firstBlock = this.blocks[first.blockIndex]!;
    const firstEnd = { blockIndex: first.blockIndex, spanIndex: firstBlock.length - 1 };
    if (!this.scanQuality(first, firstEnd, maxResolutionMs)) return false;

    const lastStart = { blockIndex: last.blockIndex, spanIndex: 0 };
    if (!this.scanQuality(lastStart, last, maxResolutionMs)) return false;

    // Boundaries from the partial edge blocks into the summarized middle.
    if (!this.blocksTouch(first.blockIndex, first.blockIndex + 1)) return false;
    if (!this.blocksTouch(last.blockIndex - 1, last.blockIndex)) return false;

    const middleStart = first.blockIndex + 1;
    const middleEnd = last.blockIndex; // exclusive
    if (middleStart < middleEnd) {
      const summary = this.queryBlockSummary(middleStart, middleEnd);
      if (summary.maxResolutionMs > maxResolutionMs || summary.gapCount !== 0) return false;
    }

    return true;
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
      if (Number.isFinite(runMax) && min <= runMax + 1) {
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
  segments(evalTime: Float64Array, wallNow: number): PriceResolutionSpan[] {
    const out: PriceResolutionSpan[] = [];
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

  private rebuildSummaryTree(): void {
    this.treeBase = 1;
    while (this.treeBase < this.blocks.length) this.treeBase <<= 1;
    this.treeMaxResolution = new Float64Array(this.treeBase * 2);
    this.treeMaxResolution.fill(Number.NEGATIVE_INFINITY);
    this.treeGapCount = new Uint32Array(this.treeBase * 2);

    for (let blockIndex = 0; blockIndex < this.blocks.length; blockIndex++) {
      const block = this.blocks[blockIndex]!;
      const treeIndex = this.treeBase + blockIndex;
      this.treeMaxResolution[treeIndex] = block.maxResolutionMs;
      this.treeGapCount[treeIndex] =
        block.internalGapCount +
        (blockIndex > 0 && !this.blocksTouch(blockIndex - 1, blockIndex) ? 1 : 0);
    }
    for (let index = this.treeBase - 1; index > 0; index--) {
      this.treeMaxResolution[index] = Math.max(
        this.treeMaxResolution[index * 2]!,
        this.treeMaxResolution[index * 2 + 1]!,
      );
      this.treeGapCount[index] = this.treeGapCount[index * 2]! + this.treeGapCount[index * 2 + 1]!;
    }
  }

  private queryBlockSummary(
    startBlock: number,
    endBlock: number,
  ): { maxResolutionMs: number; gapCount: number } {
    let left = this.treeBase + startBlock;
    let right = this.treeBase + endBlock;
    let maxResolutionMs = Number.NEGATIVE_INFINITY;
    let gapCount = 0;
    while (left < right) {
      if ((left & 1) !== 0) {
        maxResolutionMs = Math.max(maxResolutionMs, this.treeMaxResolution[left]!);
        gapCount += this.treeGapCount[left]!;
        left++;
      }
      if ((right & 1) !== 0) {
        right--;
        maxResolutionMs = Math.max(maxResolutionMs, this.treeMaxResolution[right]!);
        gapCount += this.treeGapCount[right]!;
      }
      left >>= 1;
      right >>= 1;
    }
    return { maxResolutionMs, gapCount };
  }

  private scanQuality(first: SpanLocation, last: SpanLocation, maxResolutionMs: number): boolean {
    let blockIndex = first.blockIndex;
    let spanIndex = first.spanIndex;
    let previousEnd = this.blocks[blockIndex]!.startTime[spanIndex]!;
    while (compareLocations({ blockIndex, spanIndex }, last) <= 0) {
      const block = this.blocks[blockIndex]!;
      const start = block.startTime[spanIndex]!;
      if (start > previousEnd) return false;
      if (block.resolutionMs[spanIndex]! > maxResolutionMs) return false;
      previousEnd = block.endTime[spanIndex]!;
      spanIndex++;
      if (spanIndex >= block.length) {
        blockIndex++;
        spanIndex = 0;
      }
    }
    return true;
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

  private blocksTouch(leftIndex: number, rightIndex: number): boolean {
    if (leftIndex < 0 || rightIndex >= this.blocks.length || leftIndex >= rightIndex) return false;
    return this.blocks[leftIndex]!.maxTime >= this.blocks[rightIndex]!.minTime;
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
    const startLogPrice = new Float64Array(length);
    const endLogPrice = new Float64Array(length);
    const resolutionMs = new Float64Array(length);
    let maxResolutionMs = Number.NEGATIVE_INFINITY;
    let internalGapCount = 0;
    for (let index = 0; index < length; index++) {
      const span = spans[offset + index]!;
      startTime[index] = span.startTime;
      endTime[index] = span.endTime;
      startLogPrice[index] = span.startValue;
      endLogPrice[index] = span.endValue;
      resolutionMs[index] = span.resolutionMs;
      maxResolutionMs = Math.max(maxResolutionMs, span.resolutionMs);
      if (index > 0 && endTime[index - 1]! < span.startTime) internalGapCount++;
    }
    blocks.push({
      startTime,
      endTime,
      startLogPrice,
      endLogPrice,
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
        startValue: block.startLogPrice[spanIndex]!,
        endValue: block.endLogPrice[spanIndex]!,
        resolutionMs: block.resolutionMs[spanIndex]!,
      });
    }
  }
  return out;
}

function overlay(
  existing: readonly SignalSpan[],
  incoming: readonly SignalSpan[],
): SignalSpan[] {
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
      throw new Error(`PriceSpanStore.overlay: stalled at ${cursor} -> ${next}`);

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

function compareLocations(a: SpanLocation, b: SpanLocation): number {
  return a.blockIndex - b.blockIndex || a.spanIndex - b.spanIndex;
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
      throw new Error(`PriceSpanStore.insertBatch: invalid span at ${index}`);
    }
    if (!Number.isFinite(span.startValue) || !Number.isFinite(span.endValue)) {
      throw new Error(`PriceSpanStore.insertBatch: non-finite price at ${index}`);
    }
    validateResolution(span.resolutionMs);
    if (span.startTime < previousEnd) {
      throw new Error(`PriceSpanStore.insertBatch: overlapping incoming spans at ${index}`);
    }
    previousEnd = span.endTime;
  }
}

function validateResolution(resolutionMs: number): void {
  if (!(resolutionMs > 0) || !Number.isFinite(resolutionMs)) {
    throw new Error(`PriceSpanStore: invalid resolution ${resolutionMs}`);
  }
}
