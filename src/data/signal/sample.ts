/** One observation of a real-valued signal at an epoch-millisecond timestamp. */
export interface Sample {
  readonly t: number;
  readonly value: number;
}

/**
 * Validate, sort, and deduplicate samples at the acquisition boundary.
 * Duplicate timestamps use last-write-wins semantics.
 */
export function normalizeSamples(samples: readonly Sample[]): readonly Sample[] {
  if (samples.length === 0) return [];

  const sorted = [...samples];
  for (let index = 0; index < sorted.length; index++) {
    const sample = sorted[index]!;
    if (!Number.isFinite(sample.t)) {
      throw new Error(`normalizeSamples: non-finite timestamp at ${index}: ${sample.t}`);
    }
    if (!Number.isFinite(sample.value)) {
      throw new Error(`normalizeSamples: non-finite value at ${index}: ${sample.value}`);
    }
  }
  sorted.sort((a, b) => a.t - b.t);

  const normalized: Sample[] = [];
  for (const sample of sorted) {
    const last = normalized[normalized.length - 1];
    if (last?.t === sample.t) normalized[normalized.length - 1] = sample;
    else normalized.push(sample);
  }
  return normalized;
}
