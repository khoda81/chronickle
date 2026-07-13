import { PriceSeries, type NewsEvent, type RssFeed } from "../src/domain.ts";
import { EventBroker } from "../src/data/events/broker.ts";
import { Broker } from "../src/data/price/broker.ts";
import { CoverageIndex } from "../src/data/price/coverage.ts";
import { createBinanceFetcher } from "../src/data/price/exchanges/binanceFetcher.ts";
import type { Fetcher, FetchRangeResult } from "../src/data/price/fetcher.ts";
import { ReturnPyramid } from "../src/data/price/returnPyramid.ts";
import { ChunkedLevelStore } from "../src/data/price/store.ts";
import { evaluateStaircase } from "../src/data/price/staircase.ts";
import { Range } from "../src/engine/range.ts";
import { fitStackLayout } from "../src/engine/gfx/layout.ts";
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

function count(items: readonly unknown[]): number {
  return items.length;
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

test("stack layout fills the canvas and preserves every resizable row", () => {
  const layout = fitStackLayout(110, [220, 180, 140], 800);
  const used = layout.newsHeight + layout.rowHeights.reduce((sum, height) => sum + height, 0);
  approx(used, 800, 1e-9);
  assert(layout.rowHeights.length === 3, "a price row disappeared");
  assert(layout.newsHeight >= 64, "news row fell below its preferred minimum");
  assert(layout.rowHeights.every((height) => height >= 130), "price row fell below minimum");

  const compact = fitStackLayout(110, [220, 180, 140], 240);
  const compactUsed =
    compact.newsHeight + compact.rowHeights.reduce((sum, height) => sum + height, 0);
  approx(compactUsed, 240, 1e-9);
  assert(compact.rowHeights.every((height) => height > 0), "compact row collapsed");
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

test("broker fetches finer data after coarse observations are cached", async () => {
  const requests: number[] = [];
  const fetcher: Fetcher = {
    async fetchRange({ range, maxDeltaTMs }) {
      const resolutionMs = maxDeltaTMs >= 5_000 ? 5_000 : 1_000;
      requests.push(resolutionMs);
      const points = [];
      for (let t = range.min - resolutionMs; t <= range.max; t += resolutionMs) {
        points.push({ t, price: 100 + t / 1_000_000 });
      }
      return {
        points,
        resolutionHintMs: resolutionMs,
        searchedRange: range,
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

test("broker clamps fetches to now and later renders fetch elapsed time", async () => {
  let now = 10_000;
  const requests: Range[] = [];
  const fetcher: Fetcher = {
    async fetchRange({ range }) {
      requests.push(range);
      return { points: [], searchedRange: range };
    },
  };
  const broker = new Broker(fetcher, { now: () => now });
  broker.query({
    evalTime: new Float64Array([0, 10_000, 20_000]),
    maxDeltaTMs: 1_000,
  });
  assert(requests[0]!.max === 10_000, "future time leaked into the fetch range");
  await new Promise((resolve) => setTimeout(resolve, 0));

  now = 12_000;
  broker.query({
    evalTime: new Float64Array([0, 10_000, 20_000]),
    maxDeltaTMs: 1_000,
  });
  assert(requests.length === 2, "elapsed wall-clock range was not fetched");
  assert(requests[1]!.min === 10_000 && requests[1]!.max === 12_000, "wrong live gap");
});

test("last-point coverage and returned future points never extend past now", async () => {
  const warnings: string[] = [];
  const fetcher: Fetcher = {
    async fetchRange({ range }) {
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
          { t: 10_000, price: 12 }, // invalid future timestamp for this request
        ],
        searchedRange: range,
      };
    },
  };
  const broker = new Broker(fetcher, {
    now: () => 7_500,
    onWarning: (message) => warnings.push(message),
  });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = broker.query({ evalTime, maxDeltaTMs: 5_000 });
  const ready = result.resolution.filter((segment) => segment.state === "ready");
  assert(
    ready.every((segment) => segment.range.max <= 7_500),
    "ready coverage entered future",
  );
  assert(
    warnings.some((message) => message.includes("10000")),
    "future API point was silent",
  );
});

test("finer ready evidence removes overlapping coarser empty evidence", () => {
  const coverage = new CoverageIndex();
  coverage.addEmpty(5_000, Range.create(0, 10_000));
  coverage.addReady(1_000, Range.create(2_000, 8_000));
  const segments = coverage.segments(Range.create(0, 10_000), 5_000);
  const ready = segments.filter((segment) => segment.state === "ready");
  const empty = segments.filter((segment) => segment.state === "empty");
  for (const r of ready) {
    for (const e of empty) {
      assert(r.range.max <= e.range.min || r.range.min >= e.range.max, "ready/empty overlap");
    }
  }
});

test("broker trusts the returned searched range, not the requested range", async () => {
  const requests: Range[] = [];
  const fetcher: Fetcher = {
    fetchRange({ range }) {
      requests.push(range);
      if (requests.length > 1) return new Promise(() => undefined);
      return Promise.resolve({
        points: [
          { t: 5_000, price: 10 },
          { t: 6_000, price: 11 },
          { t: 7_000, price: 12 },
        ],
        resolutionHintMs: 60_000, // deliberately wrong: timestamps win
        searchedRange: Range.create(5_000, 7_000),
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(requests.length === 3, `unsearched prefix/suffix were hidden (${requests.length} calls)`);
  assert(requests[1]!.min === 0 && requests[1]!.max === 5_000, "prefix was marked covered");
  assert(requests[2]!.min === 7_000 && requests[2]!.max === 10_000, "suffix was marked covered");
});

test("empty and coarse evidence never suppress a finer request", async () => {
  const requests: number[] = [];
  const fetcher: Fetcher = {
    fetchRange({ range, maxDeltaTMs }) {
      requests.push(maxDeltaTMs);
      if (requests.length > 1) return new Promise(() => undefined);
      return Promise.resolve({
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
          { t: 10_000, price: 12 },
        ],
        resolutionHintMs: 1_000,
        searchedRange: range,
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  assert(count(requests) === 1, "observed finer/equal data did not satisfy coarse query");
  broker.query({ evalTime, maxDeltaTMs: 500 });
  assert(count(requests) === 2 && requests[1] === 500, "finer request was suppressed");
});

test("finer pending work suppresses only coarser duplicate requests", () => {
  const requests: number[] = [];
  const fetcher: Fetcher = {
    fetchRange({ maxDeltaTMs }) {
      requests.push(maxDeltaTMs);
      return new Promise(() => undefined);
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  const first = broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(
    first.resolution.some((segment) => segment.state === "pending"),
    "pending hidden",
  );
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  assert(count(requests) === 1, "fine pending request did not suppress coarse duplicate");
  broker.query({ evalTime, maxDeltaTMs: 500 });
  assert(count(requests) === 2, "coarse pending request suppressed a finer request");
});

test("a late coarse response cannot overwrite an earlier fine response", async () => {
  let resolveCoarse!: (result: FetchRangeResult) => void;
  let resolveFine!: (result: FetchRangeResult) => void;
  const fetcher: Fetcher = {
    fetchRange({ maxDeltaTMs }) {
      return new Promise((resolve) => {
        if (maxDeltaTMs === 5_000) resolveCoarse = resolve;
        else resolveFine = resolve;
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 5_000 });
  const evalTime = new Float64Array([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  broker.query({ evalTime, maxDeltaTMs: 1_000 });

  resolveFine({
    points: [
      { t: 0, price: 100 },
      { t: 1_000, price: 101 },
      { t: 2_000, price: 102 },
      { t: 3_000, price: 103 },
      { t: 4_000, price: 104 },
      { t: 5_000, price: 105 },
    ],
    searchedRange: Range.create(0, 5_000),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveCoarse({
    points: [
      { t: 0, price: 10 },
      { t: 5_000, price: 15 },
    ],
    searchedRange: Range.create(0, 5_000),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = broker.query({ evalTime, maxDeltaTMs: 1_000 });
  approx(Math.exp(result.value[1]!), 101, 1e-10);
});

test("clearing the price cache ignores stale in-flight responses", async () => {
  const resolvers: ((result: FetchRangeResult) => void)[] = [];
  const fetcher: Fetcher = {
    fetchRange() {
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };
  const broker = new Broker(fetcher, { now: () => 1_000 });
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  broker.clearCache();
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(resolvers.length === 2, "reload did not start a fresh request generation");

  resolvers[0]!({
    points: [
      { t: 0, price: 10 },
      { t: 1_000, price: 11 },
    ],
    searchedRange: Range.create(0, 1_000),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const beforeFresh = broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(beforeFresh.value.every(Number.isNaN), "stale response repopulated the cleared cache");

  resolvers[1]!({
    points: [
      { t: 0, price: 100 },
      { t: 1_000, price: 101 },
    ],
    searchedRange: Range.create(0, 1_000),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fresh = broker.query({ evalTime, maxDeltaTMs: 1_000 });
  approx(Math.exp(fresh.value[0]!), 100, 1e-10);
});

test("clearing the event cache ignores stale walker callbacks", async () => {
  const feed: RssFeed = {
    id: "test",
    source: "Test feed",
    url: "https://example.com/feed.xml",
    color: "red",
    enabled: true,
  };
  const runs: {
    readonly emit: (events: readonly NewsEvent[]) => void;
    readonly resolve: (outcome: "exhausted") => void;
  }[] = [];
  const broker = new EventBroker(
    {},
    () => [feed],
    () => ({
      failureReason: null,
      walk(_targetMin, onEvents) {
        return new Promise((resolve) => runs.push({ emit: onEvents, resolve }));
      },
    }),
    { onDebug: () => undefined },
  );
  const range = Range.create(0, 1_000);
  broker.query(range);
  broker.clearCache();
  broker.query(range);
  assert(runs.length === 2, "event reload did not start a fresh walker generation");

  runs[0]!.emit([{ t: 400, title: "stale", link: "old", summary: "", feedId: feed.id }]);
  runs[0]!.resolve("exhausted");
  await new Promise((resolve) => setTimeout(resolve, 0));
  runs[1]!.emit([{ t: 500, title: "fresh", link: "new", summary: "", feedId: feed.id }]);
  runs[1]!.resolve("exhausted");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = broker.query(range);
  assert(
    result.events.length === 1 && result.events[0]!.title === "fresh",
    "stale events survived",
  );
});

test("Binance adapter maps arbitrary symbols and range resolution", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = input instanceof Request ? input.url : input.toString();
    return new Response(
      JSON.stringify([
        [0, "100"],
        [3_600_000, "101"],
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const fetcher = createBinanceFetcher({ symbol: "ethusdt" });
    const result = await fetcher.fetchRange({
      range: Range.create(0, 7_200_000),
      maxDeltaTMs: 3_600_000,
    });
    const url = new URL(requestedUrl);
    assert(url.searchParams.get("symbol") === "ETHUSDT", "symbol was not normalized");
    assert(url.searchParams.get("interval") === "1h", "wrong Binance interval");
    assert(result.resolutionHintMs === 3_600_000, "wrong returned resolution hint");
    assert(result.points.length === 2, "Binance rows were not converted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("broker exposes failures and uses the fetcher's retry policy", async () => {
  let calls = 0;
  const fetcher: Fetcher = {
    retryDelayMs: () => 100,
    async fetchRange() {
      calls++;
      throw new Error("upstream unavailable");
    },
  };
  const broker = new Broker(fetcher, { onError: () => undefined });
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = broker.query({ evalTime, maxDeltaTMs: 1_000 });
  const failed = result.resolution.find((segment) => segment.state === "failed");
  assert(failed !== undefined, "failed request was still presented as pending");
  assert(failed.message === "upstream unavailable", "failure detail was lost");
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(Number(calls) === 1, "failure backoff did not suppress a retry");
  await new Promise((resolve) => setTimeout(resolve, 120));
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(Number(calls) === 2, "request did not retry after adapter backoff elapsed");
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
