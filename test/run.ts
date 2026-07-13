import { PriceSeries } from "../src/domain.ts";
import { Broker } from "../src/data/price/broker.ts";
import type { Fetcher } from "../src/data/price/fetcher.ts";
import { pickResolution } from "../src/data/price/resolution.ts";
import { ReturnPyramid } from "../src/data/price/returnPyramid.ts";
import { ChunkedLevelStore } from "../src/data/price/store.ts";
import { evaluateStaircase } from "../src/data/price/staircase.ts";
import { Range } from "../src/engine/range.ts";
import {
  computeCenteredGaussianReference,
  computeWaveletField,
  kernelContext,
  logPriceEdgesToReturns,
} from "../src/engine/wavelet.ts";

type Test = { readonly name: string; readonly run: () => void | Promise<void> };
const tests: Test[] = [];

function test(name: string, run: Test["run"]): void {
  tests.push({ name, run });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function approx(actual: number, expected: number, tolerance = 1e-12): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`expected ${expected} ± ${tolerance}, got ${actual}`);
  }
}

test("PriceSeries validates and collapses duplicate timestamps", () => {
  const series = PriceSeries.from([
    { t: 2, price: 20 },
    { t: 1, price: 10 },
    { t: 2, price: 21 },
  ]);
  assert(series.observations.length === 2, "duplicate timestamp was not collapsed");
  assert(series.observations[1]!.price === 21, "last duplicate did not win");
  let threw = false;
  try {
    PriceSeries.from([{ t: 0, price: 0 }]);
  } catch {
    threw = true;
  }
  assert(threw, "non-positive price was accepted");
});

test("staircase returns NaN when empty and holds the final observation", () => {
  const evalTime = new Float64Array([0, 10, 20]);
  const empty = evaluateStaircase([], evalTime);
  assert(empty.value.every(Number.isNaN), "empty store did not return NaN");

  const store = new ChunkedLevelStore();
  store.insertBatch(new Float64Array([5, 15]), new Float64Array([1, 2]));
  const sampled = evaluateStaircase(store.chunks, evalTime).value;
  assert(Number.isNaN(sampled[0]!), "value before first observation was defined");
  assert(sampled[1] === 1 && sampled[2] === 2, "ZOH evaluation is incorrect");
});

test("return pyramid preserves signed mass and absolute activity", () => {
  const pyramid = ReturnPyramid.from(
    [
      { t: 1, deltaLogPrice: 1 },
      { t: 6, deltaLogPrice: -0.25 },
      { t: 11, deltaLogPrice: 0.5 },
    ],
    10,
  );
  const bins = pyramid.query(Range.create(0, 20), 20);
  assert(bins.length === 1, "expected one dyadic parent bin");
  approx(bins[0]!.sum, 1.25);
  approx(bins[0]!.absoluteSum, 1.75);
  assert(bins[0]!.count === 3, "return count was not aggregated");
});

test("centered Gaussian is symmetric and crop invariant away from boundaries", () => {
  const returns = new Float64Array(401);
  returns[200] = 0.1;
  const scales = new Float64Array([10]);
  const full = computeWaveletField(returns, 1, scales, "centered");
  assert(full.values[200]! > 0, "impulse response is not positive at its center");
  for (let d = 1; d <= 40; d++) approx(full.values[200 - d]!, full.values[200 + d]!, 1e-15);

  const croppedInput = returns.slice(100, 301);
  const cropped = computeWaveletField(croppedInput, 1, scales, "centered");
  for (let i = 50; i <= 150; i++) approx(cropped.values[i]!, full.values[i + 100]!, 1e-15);
});

test("FFT Gaussian backend agrees with the direct reference", () => {
  const returns = new Float64Array(257);
  for (let i = 10; i < returns.length; i += 17) returns[i] = Math.sin(i) * 0.01;
  const scales = new Float64Array([2.5, 7, 13]);
  const fast = computeWaveletField(returns, 1, scales, "centered");
  const reference = computeCenteredGaussianReference(returns, 1, scales);
  for (let i = 0; i < fast.values.length; i++) {
    const a = fast.values[i]!;
    const b = reference.values[i]!;
    if (Number.isNaN(a) || Number.isNaN(b)) {
      assert(Number.isNaN(a) && Number.isNaN(b), `validity mismatch at ${i}`);
    } else {
      approx(a, b, 2e-14);
    }
  }
});

test("causal transform never responds before an impulse", () => {
  const returns = new Float64Array(700);
  returns[500] = 0.1;
  const field = computeWaveletField(returns, 1, new Float64Array([10]), "causal");
  for (let i = 200; i < 500; i++) approx(field.values[i]!, 0, 1e-15);
  assert(field.values[500]! > 0, "causal response did not begin at the impulse");
  const context = kernelContext("causal", 10);
  assert(context.rightCells === 0 && context.leftCells > 0, "causal context is not one-sided");
});

test("ZOH returns are timestamp-aligned, causal, and zero-fill unknown data", () => {
  const returns = logPriceEdgesToReturns(new Float64Array([10, 10, 11, NaN, 12, 12]));
  assert(returns.length === 6, "return grid no longer matches the edge grid");
  approx(returns[0]!, 0);
  approx(returns[1]!, 0);
  approx(returns[2]!, 1);
  approx(returns[3]!, 0);
  approx(returns[4]!, 0);
  approx(returns[5]!, 0);

  const field = computeWaveletField(returns, 1, new Float64Array([1]), "causal", {
    causalStages: 1,
  });
  approx(field.values[1]!, 0);
  assert(field.values[2]! > 0, "causal response was drawn before the price-change timestamp");
});

test("broker fetches a finer level after a coarse range is cached", async () => {
  const requests: number[] = [];
  const native = [1_000, 5_000] as const;
  const fetcher: Fetcher = {
    nativePeriodsMs: native,
    async fetchRange({ range, maxDeltaTMs }) {
      const resolutionMs = pickResolution(native, maxDeltaTMs);
      requests.push(resolutionMs);
      const points = [];
      for (let t = range.min - resolutionMs; t <= range.max; t += resolutionMs) {
        points.push({ t, price: 100 + t / 1_000_000 });
      }
      return {
        points,
        resolutionMs,
        coverage: { kind: "complete", range },
      };
    },
  };
  const broker = new Broker(fetcher);
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(requests.includes(5_000), "coarse level was not fetched");
  assert(requests.includes(1_000), "fine level was suppressed by coarse coverage");
});

test("broker exposes pending spans and scrolling requests uncovered ranges", () => {
  const requests: Range[] = [];
  const fetcher: Fetcher = {
    nativePeriodsMs: [1_000],
    fetchRange({ range }) {
      requests.push(range);
      return new Promise(() => undefined);
    },
  };
  const broker = new Broker(fetcher);
  const first = broker.query({
    evalTime: new Float64Array([0, 1_000, 2_000]),
    maxDeltaTMs: 1_000,
  });
  assert(
    first.resolution.some((segment) => segment.state === "pending"),
    "pending gap hidden",
  );
  broker.query({
    evalTime: new Float64Array([2_000, 3_000, 4_000]),
    maxDeltaTMs: 1_000,
  });
  assert(requests.length === 2, `scroll did not request the new gap (requests=${requests.length})`);
  assert(requests[1]!.min === 2_000 && requests[1]!.max === 4_000, "wrong scrolled gap");
});

test("broker exposes failed spans with the API error", async () => {
  const fetcher: Fetcher = {
    nativePeriodsMs: [1_000],
    async fetchRange() {
      throw new Error("upstream unavailable");
    },
  };
  const broker = new Broker(fetcher);
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = broker.query({ evalTime, maxDeltaTMs: 1_000 });
  const failed = result.resolution.find((segment) => segment.state === "failed");
  assert(failed !== undefined, "failed request was still presented as pending");
  assert(failed.message === "upstream unavailable", "failure detail was lost");
  broker.dispose();
});

let failures = 0;
for (const entry of tests) {
  try {
    await entry.run();
    console.log(`✓ ${entry.name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${entry.name}`);
    console.error(error);
  }
}
if (failures > 0) throw new Error(`${failures} test(s) failed`);
