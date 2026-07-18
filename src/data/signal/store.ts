import { lowerBoundBy, upperBoundBy } from "../../core/binarySearch.ts";
import type { MutableSample, Sample } from "./sample.ts";

const LEAF_CAPACITY = 512;
const numberValue = (value: number): number => value;

/**
 * One packed leaf in a numeric ordered map.
 *
 * Invariants:
 * - `key` and `value` have the same non-zero length;
 * - `key` is strictly increasing;
 * - every leaf except boundary leaves is packed by the most recent batch rewrite;
 * - leaf key ranges are strictly ordered and never overlap.
 */
interface Leaf {
  readonly key: Float64Array;
  readonly value: Float64Array;
}

const leafFirstKey = (leaf: Leaf): number => leaf.key[0]!;
const leafLastKey = (leaf: Leaf): number => leaf.key[leaf.key.length - 1]!;

/**
 * A numeric `timestamp -> value` map optimized for sorted batch writes and reads.
 *
 * Write contract:
 * - samples are finite and sorted by nondecreasing timestamp;
 * - a duplicate timestamp in a batch uses its final value;
 * - a batch value replaces any stored value at the same timestamp.
 *
 * Read contract:
 * - a query selects the entry with the greatest timestamp `<= query`;
 * - missing batch results are `-Infinity` for time and `NaN` for value;
 * - batch query times are sorted ascending;
 * - caller-provided output buffers make the draw-path read allocation-free.
 *
 * The top-level leaf index is the root of a shallow B+ tree. Each lookup binary
 * searches the root and then one cache-friendly typed-array leaf. Batch reads
 * retain a finger into the current leaf, but jump through the root whenever a
 * query skips history so zoomed-out cost remains tied to output width.
 */
export class NumericSeriesStore {
  private readonly leaves: Leaf[] = [];
  private leafStart = new Float64Array(0);
  private entryCount = 0;

  get size(): number {
    return this.entryCount;
  }

  clear(): void {
    this.leaves.length = 0;
    this.leafStart = new Float64Array(0);
    this.entryCount = 0;
  }

  /** Upsert a sorted batch. Returns true exactly when the final mapping changes. */
  upsertBatch(samples: readonly Sample[]): boolean {
    if (samples.length === 0) return false;

    const firstKey = samples[0]!.t;
    const lastKey = samples[samples.length - 1]!.t;
    const firstAffected = lowerBoundBy(this.leaves, firstKey, leafLastKey);
    const afterLastAffected = upperBoundBy(this.leafStart, lastKey, numberValue);

    // Repack one neighbor on either side. This prevents tiny boundary leaves
    // without rebuilding unrelated history.
    const spliceStart = Math.max(0, firstAffected - 1);
    const spliceEnd = Math.min(this.leaves.length, Math.max(firstAffected, afterLastAffected) + 1);
    const existing = flattenLeaves(this.leaves, spliceStart, spliceEnd);
    const merged = mergeSamples(existing.key, existing.value, samples);
    if (!merged.changed) return false;

    const replacement = chunkEntries(merged.key, merged.value, merged.length);
    this.leaves.splice(spliceStart, spliceEnd - spliceStart, ...replacement);
    this.leafStart = Float64Array.from(this.leaves, leafFirstKey);
    this.entryCount += merged.length - existing.key.length;
    return true;
  }

  /** Write the greatest stored timestamp `<= time` into `out`. */
  findAtOrBefore(time: number, out: MutableSample): boolean {
    const leafIndex = upperBoundBy(this.leafStart, time, numberValue) - 1;
    if (leafIndex < 0) return false;
    const leaf = this.leaves[leafIndex]!;
    const entryIndex = upperBoundBy(leaf.key, time, numberValue) - 1;
    out.t = leaf.key[entryIndex]!;
    out.value = leaf.value[entryIndex]!;
    return true;
  }

  /**
   * Batched predecessor lookup for ascending query times.
   *
   * `sampleTime`, when supplied, must match `evalTime.length`. `reuseValue` is
   * reused only when its length matches; otherwise a correctly sized value
   * array is allocated for the caller.
   */
  findBatchAtOrBefore(
    evalTime: Float64Array,
    reuseValue?: Float64Array,
    sampleTime?: Float64Array,
  ): Float64Array {
    if (sampleTime !== undefined && sampleTime.length !== evalTime.length) {
      throw new Error(
        `NumericSeriesStore.findBatchAtOrBefore: sample-time length ${sampleTime.length} ` +
          `does not match query length ${evalTime.length}`,
      );
    }

    const value =
      reuseValue?.length === evalTime.length ? reuseValue : new Float64Array(evalTime.length);
    if (this.leaves.length === 0) {
      value.fill(NaN);
      sampleTime?.fill(Number.NEGATIVE_INFINITY);
      return value;
    }

    let leafIndex = upperBoundBy(this.leafStart, evalTime[0] ?? -Infinity, numberValue) - 1;
    let entryIndex = -1;

    for (let index = 0; index < evalTime.length; index++) {
      const query = evalTime[index]!;

      if (leafIndex < 0) {
        if (query >= leafFirstKey(this.leaves[0]!)) {
          leafIndex = upperBoundBy(this.leafStart, query, numberValue) - 1;
        }
      } else {
        const nextLeaf = this.leaves[leafIndex + 1];
        if (nextLeaf !== undefined && query >= leafFirstKey(nextLeaf)) {
          leafIndex = upperBoundBy(this.leafStart, query, numberValue, leafIndex + 1) - 1;
          entryIndex = -1;
        }
      }

      if (leafIndex < 0) {
        value[index] = NaN;
        if (sampleTime !== undefined) sampleTime[index] = Number.NEGATIVE_INFINITY;
        continue;
      }

      const leaf = this.leaves[leafIndex]!;
      entryIndex = upperBoundBy(leaf.key, query, numberValue, Math.max(0, entryIndex)) - 1;
      value[index] = leaf.value[entryIndex]!;
      if (sampleTime !== undefined) sampleTime[index] = leaf.key[entryIndex]!;
    }
    return value;
  }
}

interface FlatEntries {
  readonly key: Float64Array;
  readonly value: Float64Array;
}

function flattenLeaves(leaves: readonly Leaf[], start: number, end: number): FlatEntries {
  let length = 0;
  for (let index = start; index < end; index++) length += leaves[index]!.key.length;

  const key = new Float64Array(length);
  const value = new Float64Array(length);
  let offset = 0;
  for (let index = start; index < end; index++) {
    const leaf = leaves[index]!;
    key.set(leaf.key, offset);
    value.set(leaf.value, offset);
    offset += leaf.key.length;
  }
  return { key, value };
}

interface MergedEntries {
  readonly key: Float64Array;
  readonly value: Float64Array;
  readonly length: number;
  readonly changed: boolean;
}

function mergeSamples(
  existingKey: Float64Array,
  existingValue: Float64Array,
  incoming: readonly Sample[],
): MergedEntries {
  const key = new Float64Array(existingKey.length + incoming.length);
  const value = new Float64Array(key.length);
  let existingIndex = 0;
  let incomingIndex = 0;
  let length = 0;
  let changed = false;

  while (existingIndex < existingKey.length || incomingIndex < incoming.length) {
    if (incomingIndex >= incoming.length) {
      key[length] = existingKey[existingIndex]!;
      value[length++] = existingValue[existingIndex++]!;
      continue;
    }

    const incomingKey = incoming[incomingIndex]!.t;
    let finalIncomingIndex = incomingIndex;
    while (
      finalIncomingIndex + 1 < incoming.length &&
      incoming[finalIncomingIndex + 1]!.t === incomingKey
    ) {
      finalIncomingIndex++;
    }
    const incomingValue = incoming[finalIncomingIndex]!.value;

    while (existingIndex < existingKey.length && existingKey[existingIndex]! < incomingKey) {
      key[length] = existingKey[existingIndex]!;
      value[length++] = existingValue[existingIndex++]!;
    }

    key[length] = incomingKey;
    value[length++] = incomingValue;
    if (existingKey[existingIndex] === incomingKey) {
      changed ||= existingValue[existingIndex] !== incomingValue;
      existingIndex++;
    } else {
      changed = true;
    }
    incomingIndex = finalIncomingIndex + 1;
  }

  return { key, value, length, changed };
}

function chunkEntries(key: Float64Array, value: Float64Array, length: number): Leaf[] {
  const leaves: Leaf[] = [];
  for (let offset = 0; offset < length; offset += LEAF_CAPACITY) {
    const end = Math.min(length, offset + LEAF_CAPACITY);
    leaves.push({ key: key.slice(offset, end), value: value.slice(offset, end) });
  }
  return leaves;
}
