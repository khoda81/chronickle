import { NumericSeriesStore } from "../src/data/signal/store.ts";
import type { Sample } from "../src/data/signal/sample.ts";

const QUERY_COUNT = 2_048;
const BATCH_SIZE = 4_096;
const WARMUP_READS = 40;
const MEASURED_READS = 200;

interface ScaleCase {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

for (const entryCount of [30_000, 300_000, 3_000_000]) {
  const store = new NumericSeriesStore();
  const buildStartedAt = performance.now();
  for (let offset = 0; offset < entryCount; offset += BATCH_SIZE) {
    const count = Math.min(BATCH_SIZE, entryCount - offset);
    const batch: Sample[] = new Array(count);
    for (let index = 0; index < count; index++) {
      const ordinal = offset + index;
      batch[index] = { t: ordinal * 2, value: ordinal };
    }
    store.upsertBatch(batch);
  }
  const buildMs = performance.now() - buildStartedAt;

  const finalKey = (entryCount - 1) * 2;
  const scales: readonly ScaleCase[] = [
    { name: "dense", start: finalKey / 2, end: finalKey / 2 + QUERY_COUNT * 2 },
    { name: "medium", start: finalKey * 0.45, end: finalKey * 0.55 },
    { name: "full", start: 0, end: finalKey },
  ];

  console.log(`\n${entryCount.toLocaleString()} entries; build ${buildMs.toFixed(2)} ms`);
  for (const scale of scales) benchmarkScale(store, scale);
  benchmarkPoints(store, finalKey);
}

function benchmarkScale(store: NumericSeriesStore, scale: ScaleCase): void {
  const query = regularGrid(scale.start, scale.end, QUERY_COUNT);
  const sampleTime = new Float64Array(QUERY_COUNT);
  const value = new Float64Array(QUERY_COUNT);

  for (let run = 0; run < WARMUP_READS; run++) {
    store.findBatchAtOrBefore(query, value, sampleTime);
  }

  let checksum = 0;
  const startedAt = performance.now();
  for (let run = 0; run < MEASURED_READS; run++) {
    store.findBatchAtOrBefore(query, value, sampleTime);
    checksum += value[(run * 31) % value.length]!;
  }
  const durationMs = performance.now() - startedAt;
  const perReadUs = (durationMs * 1_000) / MEASURED_READS;
  const perQueryNs = (durationMs * 1_000_000) / (MEASURED_READS * QUERY_COUNT);
  console.log(
    `${scale.name.padEnd(6)} ${perReadUs.toFixed(2).padStart(8)} µs/read ` +
      `${perQueryNs.toFixed(2).padStart(7)} ns/query  checksum=${checksum.toFixed(0)}`,
  );
}

function benchmarkPoints(store: NumericSeriesStore, finalKey: number): void {
  const out = { t: Number.NEGATIVE_INFINITY, value: Number.NaN };
  const count = 100_000;
  let checksum = 0;
  const startedAt = performance.now();
  for (let index = 0; index < count; index++) {
    const query = ((index * 104_729) % count) * (finalKey / count);
    store.findAtOrBefore(query, out);
    checksum += out.value;
  }
  const durationMs = performance.now() - startedAt;
  console.log(
    `point  ${((durationMs * 1_000) / count).toFixed(3).padStart(8)} µs/read` +
      `  checksum=${checksum.toFixed(0)}`,
  );
}

function regularGrid(start: number, end: number, count: number): Float64Array {
  const grid = new Float64Array(count);
  const step = (end - start) / (count - 1);
  for (let index = 0; index < count; index++) grid[index] = start + index * step;
  return grid;
}
