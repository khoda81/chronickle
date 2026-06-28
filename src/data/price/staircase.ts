/**
 * Staircase (zero-order-hold) evaluation over a sorted sample store.
 *
 * The price series is a step function: each sample's value holds until the
 * next sample's timestamp. The UI asks "what is the value at these specific
 * times?" — typically one timestamp per pixel boundary (W+1 of them for a
 * canvas of width W). This module answers that question against the chunked
 * store in a single O(chunks + evalPoints) sweep, with no intermediate
 * allocation of the full in-range sample set.
 *
 * Output is exactly `evalTime.length` values, one per requested timestamp.
 * This is the same shape the wavelet and renderer consume, so there is no
 * downstream format conversion.
 */

import { Chunk } from "./store.ts";

export interface StaircaseResult {
  /** Values aligned with the input `evalTime`. Length === evalTime.length. */
  readonly value: Float32Array;
  /**
   * Number of leading/trailing eval points that fell outside the store's
   * covered range. Those entries in `value` are `NaN` and must be handled
   * by the caller (e.g. the renderer clamps or skips them).
   */
  readonly leadingNaN: number;
  readonly trailingNaN: number;
}

/**
 * Evaluate the staircase at `evalTime` (ascending) against `chunks`.
 *
 * `evalTime` must be ascending; this is not re-checked (the viewport
 * produces it monotonically). Values before the first sample and after the
 * last sample are `NaN` — the caller decides how to render the gap.
 *
 * Allocation: one `Float32Array(evalTime.length)`. No per-sample buffers.
 */
export function evaluateStaircase(
  chunks: readonly Chunk[],
  evalTime: Float64Array,
): StaircaseResult {
  const n = evalTime.length;
  const out = new Float32Array(n);

  if (n === 0 || chunks.length === 0) {
    return { value: out, leadingNaN: 0, trailingNaN: 0 };
  }

  // First/last sample timestamps across the whole store.
  const storeStart = chunks[0]!.startTime;
  const storeEnd = chunks[chunks.length - 1]!.endTime;

  // Walk eval points and chunks together. Both are ascending.
  let chunkIdx = 0;
  let innerIdx = 0;
  // `lastValue` is the value of the most recent sample seen so far (the
  // current step's height). NaN until we've passed the first sample.
  let lastValue = NaN;
  let leadingNaN = 0;

  // Count leading eval points before the store starts.
  while (leadingNaN < n && evalTime[leadingNaN]! < storeStart) {
    leadingNaN++;
  }

  let trailingStart = n;
  // Find the first eval point strictly after storeEnd (trailing NaNs begin there).
  // Binary search for the leftmost index with evalTime > storeEnd.
  {
    let lo = leadingNaN;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (evalTime[m]! <= storeEnd) lo = m + 1;
      else hi = m;
    }
    trailingStart = lo;
  }

  // Fill leading NaNs explicitly (Float32Array is zeroed, but NaN is clearer).
  for (let i = 0; i < leadingNaN; i++) out[i] = NaN;

  // Sweep the in-range eval points [leadingNaN, trailingStart).
  for (let i = leadingNaN; i < trailingStart; i++) {
    const t = evalTime[i]!;

    // Advance through samples whose timestamp is <= t.
    // `lastValue` becomes the value of the last such sample.
    while (chunkIdx < chunks.length) {
      const c = chunks[chunkIdx]!;
      // If this chunk starts after t, no more samples can be <= t.
      if (c.startTime > t) break;

      // Scan within the chunk up to and including t.
      // Fast path: if t >= chunk end, consume the whole chunk's last value.
      if (t >= c.endTime) {
        lastValue = c.value[c.length - 1]!;
        chunkIdx++;
        innerIdx = 0;
        continue;
      }
      // Otherwise scan forward inside the chunk.
      while (innerIdx < c.length && c.time[innerIdx]! <= t) {
        lastValue = c.value[innerIdx]!;
        innerIdx++;
      }
      // If we stopped because innerIdx hit a sample > t, this chunk still
      // owns future eval points; don't advance chunkIdx.
      break;
    }

    out[i] = lastValue;
  }

  // Trailing NaNs (eval points past storeEnd).
  const trailingNaN = n - trailingStart;
  for (let i = trailingStart; i < n; i++) out[i] = NaN;

  return { value: out, leadingNaN, trailingNaN };
}
