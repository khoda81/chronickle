const CHUNK_CAPACITY = 1024;

interface Chunk {
  time: Float64Array;
  value: Float32Array;
  length: number;
  /** Cached for fast routing */
  startTime: number;
  endTime: number;
}

export class ChunkedLevelStore {
  /** * A flat array of chunks, sorted chronologically.
   * This is a "Shallow B+ Tree". For 1M points, this is only ~1000 elements.
   * A flat array of 1000 objects is vastly faster to binary search than a deep tree.
   */
  chunks: Chunk[] = [];

  /**
   * Inserts a batch of points that belong in this specific LoD level.
   * @param incomingTime Sorted chronological timestamps
   * @param incomingValue Corresponding values
   */
  insertBatch(incomingTime: Float64Array, incomingValue: Float32Array) {
    if (incomingTime.length === 0) return;

    const batchStart = incomingTime[0]!;
    const batchEnd = incomingTime[incomingTime.length - 1]!;

    // 1. Find which existing chunks overlap with our incoming batch
    const overlapStartIndex = this.findChunkIndex(batchStart);
    let overlapEndIndex = this.findChunkIndex(batchEnd);

    // If the batch extends past our existing data, bind the end index
    if (overlapEndIndex >= this.chunks.length) {
      overlapEndIndex = this.chunks.length > 0 ? this.chunks.length - 1 : 0;
    }

    // 2. Extract all existing data in the overlapping range
    const existingChunks = this.chunks.slice(overlapStartIndex, overlapEndIndex + 1);

    // 3. Merge the new data with the overlapping existing data
    const mergedChunks = this.mergeAndRechunk(existingChunks, incomingTime, incomingValue);

    // 4. Splice the newly formed, perfectly-sized chunks back into the routing array
    this.chunks.splice(overlapStartIndex, existingChunks.length, ...mergedChunks);
  }

  /**
   * Core DOD Logic: Merges existing chunk data with new data and splits it into
   * fresh chunks of exactly CHUNK_CAPACITY.
   */
  private mergeAndRechunk(
    existing: Chunk[],
    newTime: Float64Array,
    newValue: Float32Array,
  ): Chunk[] {
    // Calculate total possible size to allocate a temporary contiguous buffer
    const existingLength = existing.reduce((sum, c) => sum + c.length, 0);
    const totalLength = existingLength + newTime.length;

    const tempTime = new Float64Array(totalLength);
    const tempValue = new Float32Array(totalLength);

    let eIdx = 0; // Existing chunks iterator
    let eInnerIdx = 0; // Iterator inside the current existing chunk
    let nIdx = 0; // New data iterator
    let tIdx = 0; // Temp buffer iterator

    // Two-pointer merge sort (since both existing and new data are already sorted)
    while (eIdx < existing.length || nIdx < newTime.length) {
      const hasExisting = eIdx < existing.length;
      const hasNew = nIdx < newTime.length;

      const currentExistingChunk = existing[eIdx]!;
      const eTime = hasExisting ? currentExistingChunk.time[eInnerIdx] : Infinity;
      const nTime = hasNew ? newTime[nIdx]! : Infinity;

      if (eTime === nTime) {
        // Overwrite existing data with the newer data on exact timestamp match
        tempTime[tIdx] = newTime[nIdx];
        tempValue[tIdx] = newValue[nIdx];
        nIdx++;
        eInnerIdx++;
        tIdx++;
      } else if (eTime < nTime) {
        tempTime[tIdx] = currentExistingChunk.time[eInnerIdx];
        tempValue[tIdx] = currentExistingChunk.value[eInnerIdx];
        eInnerIdx++;
      } else {
        tempTime[tIdx] = newTime[nIdx];
        tempValue[tIdx] = newValue[nIdx];
        nIdx++;
      }

      // Advance existing chunk pointer if we exhausted the current one
      if (hasExisting && eInnerIdx >= currentExistingChunk.length) {
        eIdx++;
        eInnerIdx = 0;
      }
    }

    // Now slice the temp buffer into perfectly sized new chunks
    const resultChunks: Chunk[] = [];
    const finalLength = tIdx; // Actual length after handling overwrites

    for (let i = 0; i < finalLength; i += CHUNK_CAPACITY) {
      const chunkLen = Math.min(CHUNK_CAPACITY, finalLength - i);

      const chunkTime = new Float64Array(CHUNK_CAPACITY);
      const chunkValue = new Float32Array(CHUNK_CAPACITY);

      // Copy the segment into the new typed arrays
      chunkTime.set(tempTime.subarray(i, i + chunkLen));
      chunkValue.set(tempValue.subarray(i, i + chunkLen));

      resultChunks.push({
        time: chunkTime,
        value: chunkValue,
        length: chunkLen,
        startTime: chunkTime[0]!,
        endTime: chunkTime[chunkLen - 1]!,
      });
    }

    return resultChunks;
  }

  /** Binary search to find the chunk containing the target time */
  private findChunkIndex(targetTime: number): number {
    let l = 0,
      r = this.chunks.length - 1;
    let ans = this.chunks.length;
    while (l <= r) {
      const m = (l + r) >> 1;
      if (this.chunks[m]!.endTime >= targetTime) {
        ans = m;
        r = m - 1;
      } else {
        l = m + 1;
      }
    }
    return ans;
  }
}
