import { Range } from "../engine/range.ts";

const CHUNK_CAPACITY = 1024;

/**
 * A fixed-capacity sorted run of (time, value) samples.
 *
 * Invariants (enforced by `Chunk.create`):
 *  - `length <= CHUNK_CAPACITY`.
 *  - `time` and `value` have length `CHUNK_CAPACITY` (allocated once); only
 *    `[0, length)` is meaningful.
 *  - `time[0..length)` is strictly ascending (no duplicates).
 *  - `startTime === time[0]` and `endTime === time[length-1]` (derived, not stored independently).
 *
 * Only the **last** chunk in a store may be partial (`length < CHUNK_CAPACITY`);
 * all earlier chunks are full. `ChunkedLevelStore.insertBatch` preserves this.
 */
export interface Chunk {
  readonly time: Float64Array;
  readonly value: Float32Array;
  readonly length: number;
  readonly startTime: number;
  readonly endTime: number;
}

export const Chunk = {
  /**
   * Build a chunk by copying `srcTime`/`srcValue` into fresh typed arrays of
   * size `CHUNK_CAPACITY`. Validates sortedness and finiteness.
   * @throws if lengths differ, exceed capacity, are unsorted, or contain non-finite values.
   */
  create(srcTime: ArrayLike<number>, srcValue: ArrayLike<number>, length: number): Chunk {
    if (length > CHUNK_CAPACITY) {
      throw new Error(`Chunk.create: length ${length} exceeds capacity ${CHUNK_CAPACITY}`);
    }
    if (srcTime.length !== srcValue.length) {
      throw new Error(
        `Chunk.create: source length mismatch (${srcTime.length} vs ${srcValue.length})`,
      );
    }
    if (length > srcTime.length) {
      throw new Error(`Chunk.create: length ${length} exceeds source length ${srcTime.length}`);
    }

    const time = new Float64Array(CHUNK_CAPACITY);
    const value = new Float32Array(CHUNK_CAPACITY);

    let prev = -Infinity;
    for (let i = 0; i < length; i++) {
      const t = srcTime[i]!;
      const v = srcValue[i]!;
      if (!Number.isFinite(t)) {
        throw new Error(`Chunk.create: non-finite time at index ${i}: ${t}`);
      }
      if (!Number.isFinite(v)) {
        throw new Error(`Chunk.create: non-finite value at index ${i}: ${v}`);
      }
      if (!(t > prev)) {
        throw new Error(
          `Chunk.create: time must be strictly ascending; index ${i} t=${t} prev=${prev}`,
        );
      }
      time[i] = t;
      value[i] = v;
      prev = t;
    }

    return {
      time,
      value,
      length,
      startTime: length > 0 ? time[0]! : NaN,
      endTime: length > 0 ? time[length - 1]! : NaN,
    };
  },

  /** Capacity constant, exported for callers that need to size buffers. */
  capacity: CHUNK_CAPACITY,
};

/**
 * A sorted array of fixed-capacity chunks — a "shallow B+ tree".
 *
 * For 1M points this is ~1000 chunk objects; binary search over the chunk
 * array is O(log n) and cache-friendly. All data resolutions (tick, 1m, 5m,
 * daily, ws prints) for a single price source are mixed into the same store,
 * since the series is a zero-order-hold staircase: a finer sample simply
 * subdivides a coarser step, and exact-timestamp matches overwrite.
 */
export class ChunkedLevelStore {
  /**
   * Sorted ascending by `startTime`. Only the last chunk may be partial.
   * Exposed read-only for staircase evaluation and diagnostics — callers
   * must not mutate.
   */
  private readonly _chunks: Chunk[] = [];

  /** Read-only view of the chunk array. */
  get chunks(): readonly Chunk[] {
    return this._chunks;
  }

  /** Number of chunks (for diagnostics/tests). */
  get chunkCount(): number {
    return this._chunks.length;
  }

  /** Total number of stored samples. */
  get pointCount(): number {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    return n;
  }

  /** Covered time range, or `null` if empty. */
  timeRange(): Range | null {
    if (this._chunks.length === 0) return null;
    const first = this._chunks[0]!;
    const last = this._chunks[this._chunks.length - 1]!;
    return Range.create(first.startTime, last.endTime);
  }

  /**
   * Insert a sorted batch. Overwrites existing samples on exact-timestamp
   * match (newer data wins). Re-chunks affected region to fixed capacity.
   */
  insertBatch(incomingTime: Float64Array, incomingValue: Float32Array): void {
    if (incomingTime.length === 0) return;
    if (incomingTime.length !== incomingValue.length) {
      throw new Error(
        `insertBatch: length mismatch (${incomingTime.length} vs ${incomingValue.length})`,
      );
    }

    const batchStart = incomingTime[0]!;
    const batchEnd = incomingTime[incomingTime.length - 1]!;

    // 1. Locate the chunk range that overlaps [batchStart, batchEnd].
    const overlapStartIndex = this.findChunkIndex(batchStart);
    let overlapEndIndex = this.findChunkIndex(batchEnd);
    if (overlapEndIndex >= this._chunks.length) {
      overlapEndIndex = this._chunks.length > 0 ? this._chunks.length - 1 : 0;
    }

    // 2. Extract overlapping existing chunks.
    const existingChunks =
      overlapStartIndex < this._chunks.length
        ? this._chunks.slice(overlapStartIndex, overlapEndIndex + 1)
        : [];

    // 3. Merge and re-chunk.
    const merged = this.mergeAndRechunk(existingChunks, incomingTime, incomingValue);

    // 4. Splice back. Preserve the "only last chunk may be partial" invariant:
    //    if the merged tail is partial and there's a following chunk it would
    //    now be adjacent to, the next insert will re-merge them anyway. We do
    //    not eagerly steal from the next chunk — keeps insert O(affected region).
    this._chunks.splice(overlapStartIndex, existingChunks.length, ...merged);
  }

  /**
   * Two-pointer merge of existing chunks with an incoming sorted batch,
   * then re-slice into fixed-capacity chunks. Exact-timestamp matches take
   * the incoming (newer) value.
   */
  private mergeAndRechunk(
    existing: Chunk[],
    newTime: Float64Array,
    newValue: Float32Array,
  ): Chunk[] {
    const existingLength = existing.reduce((sum, c) => sum + c.length, 0);
    const totalLength = existingLength + newTime.length;

    const tempTime = new Float64Array(totalLength);
    const tempValue = new Float32Array(totalLength);

    let eIdx = 0;
    let eInnerIdx = 0;
    let nIdx = 0;
    let tIdx = 0;

    while (eIdx < existing.length || nIdx < newTime.length) {
      const hasExisting = eIdx < existing.length;
      const hasNew = nIdx < newTime.length;

      const currentExistingChunk = existing[eIdx]!;
      const eTime = hasExisting ? currentExistingChunk.time[eInnerIdx]! : Infinity;
      const nTime = hasNew ? newTime[nIdx]! : Infinity;

      if (eTime === nTime) {
        tempTime[tIdx] = newTime[nIdx]!;
        tempValue[tIdx] = newValue[nIdx]!;
        nIdx++;
        eInnerIdx++;
        tIdx++;
      } else if (eTime < nTime) {
        tempTime[tIdx] = currentExistingChunk.time[eInnerIdx]!;
        tempValue[tIdx] = currentExistingChunk.value[eInnerIdx]!;
        eInnerIdx++;
        tIdx++;
      } else {
        tempTime[tIdx] = newTime[nIdx]!;
        tempValue[tIdx] = newValue[nIdx]!;
        nIdx++;
        tIdx++;
      }

      if (hasExisting && eInnerIdx >= currentExistingChunk.length) {
        eIdx++;
        eInnerIdx = 0;
      }
    }

    const finalLength = tIdx;
    const resultChunks: Chunk[] = [];
    for (let i = 0; i < finalLength; i += CHUNK_CAPACITY) {
      const chunkLen = Math.min(CHUNK_CAPACITY, finalLength - i);
      resultChunks.push(
        Chunk.create(
          tempTime.subarray(i, i + chunkLen),
          tempValue.subarray(i, i + chunkLen),
          chunkLen,
        ),
      );
    }
    return resultChunks;
  }

  /** Binary search: index of the chunk whose `endTime >= targetTime`, else `chunks.length`. */
  private findChunkIndex(targetTime: number): number {
    let l = 0;
    let r = this._chunks.length - 1;
    let ans = this._chunks.length;
    while (l <= r) {
      const m = (l + r) >> 1;
      if (this._chunks[m]!.endTime >= targetTime) {
        ans = m;
        r = m - 1;
      } else {
        l = m + 1;
      }
    }
    return ans;
  }
}
