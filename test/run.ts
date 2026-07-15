import { PriceSeries, type NewsEvent, type RssFeed } from "../src/domain.ts";
import { EventBroker } from "../src/data/events/broker.ts";
import { RangeSet } from "../src/data/rangeSet.ts";
import {
  Broker as PriceBroker,
  type BrokerOptions,
  type BrokerSubscription,
  type QueryOptions,
  type QueryResult,
} from "../src/data/price/broker.ts";
import { FetchedCoverageIndex } from "../src/data/price/coverage.ts";
import { createBinanceAdapter } from "../src/data/price/exchanges/binanceFetcher.ts";
import { chooseYahooInterval, createYahooAdapter } from "../src/data/price/exchanges/yahoo.ts";
import {
  createPollingAdapter,
  type AdapterBatch,
  type AdapterDemand,
  type PriceAdapter,
} from "../src/data/price/fetcher.ts";
import { marketSource } from "../src/data/price/markets.ts";
import { filterMarketSymbols, parseNobitexMarketKey } from "../src/data/price/symbols.ts";
import { PriceSpanStore } from "../src/data/price/store.ts";
import { Range } from "../src/engine/range.ts";
import { fitStackLayout, heatmapScaleWindow } from "../src/engine/gfx/layout.ts";
import { placeTooltip } from "../src/ui/tooltip.ts";
import {
  computeCenteredGaussianReference,
  computeWaveletField,
  kernelContext,
  logPriceEdgesToReturns,
} from "../src/engine/wavelet.ts";

type Test = { readonly name: string; readonly run: () => void | Promise<void> };
const tests: Test[] = [];

interface FetchRangeResult {
  readonly points: readonly { readonly t: number; readonly price: number }[];
  readonly resolutionHintMs?: number;
  readonly searchedRange?: Range;
}

interface Fetcher {
  readonly serializeRequests?: boolean;
  readonly sourceWideBackoff?: boolean;
  readonly liveRetryDelayMs?: number;
  readonly publicationGraceMs?: number;
  fetchRange(request: {
    readonly range: Range;
    readonly maxDeltaTMs: number;
    readonly signal: AbortSignal;
  }): Promise<FetchRangeResult>;
  retryDelayMs?(error: unknown, attempt: number): number;
  clearCache?(): void;
}

const brokers = new Set<Broker>();

class Broker extends PriceBroker {
  private compatibilitySubscription: BrokerSubscription | null = null;

  constructor(source: Fetcher | PriceAdapter, opts: BrokerOptions = {}) {
    super(isAdapter(source) ? source : adaptFetcher(source, opts.now ?? Date.now), opts);
    brokers.add(this);
  }

  query(opts: QueryOptions): QueryResult {
    if (opts.evalTime.length >= 2) {
      const demand = {
        range: Range.create(opts.evalTime[0]!, opts.evalTime[opts.evalTime.length - 1]!),
        maxDeltaTMs: opts.maxDeltaTMs,
      };
      if (this.compatibilitySubscription === null) {
        this.compatibilitySubscription = this.subscribe(demand, () => undefined);
      } else {
        this.compatibilitySubscription.update(demand);
      }
    }
    return this.read(opts);
  }

  override dispose(): void {
    this.compatibilitySubscription?.dispose();
    this.compatibilitySubscription = null;
    super.dispose();
    brokers.delete(this);
  }
}

function isAdapter(source: Fetcher | PriceAdapter): source is PriceAdapter {
  return "plan" in source;
}

function adaptFetcher(fetcher: Fetcher, now: () => number): PriceAdapter {
  return createPollingAdapter({
    serializeRequests: fetcher.serializeRequests,
    sourceWideBackoff: fetcher.sourceWideBackoff,
    livePollDelayMs: fetcher.liveRetryDelayMs,
    publicationGraceMs: fetcher.publicationGraceMs,
    now,
    resolve: (demand) => demand.maxDeltaTMs,
    retryDelayMs: fetcher.retryDelayMs?.bind(fetcher),
    clearCache: fetcher.clearCache?.bind(fetcher),
    async fetchRange(plan, signal) {
      const result = await fetcher.fetchRange({ ...plan, signal });
      return {
        points: result.points,
        searchedRange: result.searchedRange ?? plan.range,
      };
    },
  });
}

function fetchOnce(adapter: PriceAdapter, demand: AdapterDemand): Promise<AdapterBatch> {
  return new Promise((resolve, reject) => {
    const session = adapter.connect({
      next: (batch) => {
        session.dispose();
        resolve(batch);
      },
      status: () => undefined,
      error: (error) => {
        session.dispose();
        reject(error);
      },
    });
    session.setDemands([demand]);
  });
}

function retryOnce(
  adapter: PriceAdapter,
  demand: AdapterDemand,
): Promise<{ readonly error: unknown; readonly retryAtMs: number }> {
  return new Promise((resolve) => {
    const session = adapter.connect({
      next: () => undefined,
      status: () => undefined,
      error: (error, activity) => {
        session.dispose();
        resolve({ error, retryAtMs: activity.retryAtMs! });
      },
    });
    session.setDemands([demand]);
  });
}

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
  assert(
    layout.rowHeights.every((height) => height >= 130),
    "price row fell below minimum",
  );

  const compact = fitStackLayout(110, [220, 180, 140], 240);
  const compactUsed =
    compact.newsHeight + compact.rowHeights.reduce((sum, height) => sum + height, 0);
  approx(compactUsed, 240, 1e-9);
  assert(
    compact.rowHeights.every((height) => height > 0),
    "compact row collapsed",
  );
});

test("vertical heatmap pan selects scale-aware sampling density", () => {
  const neutral = heatmapScaleWindow(2_000, 220, 0);
  const finer = heatmapScaleWindow(2_000, 220, 480);
  const coarser = heatmapScaleWindow(2_000, 220, -480);
  assert(finer.minSigmaPx < neutral.minSigmaPx, "downward pan did not expose finer scales");
  assert(coarser.minSigmaPx > neutral.minSigmaPx, "upward pan did not expose coarser scales");
  assert(
    finer.sampleCellCount > neutral.sampleCellCount,
    "fine scales did not request denser time samples",
  );
  assert(
    coarser.sampleCellCount < neutral.sampleCellCount,
    "coarse scales did not reduce time samples",
  );
  assert(
    neutral.maxSigmaPx > neutral.minSigmaPx,
    "visible heatmap range did not cover multiple convolution scales",
  );
});

test("hover labels flip around their anchor and remain inside the viewport", () => {
  const nearTopRight = placeTooltip({
    anchorX: 292,
    anchorY: 18,
    width: 120,
    height: 80,
    viewportWidth: 300,
    viewportHeight: 180,
  });
  assert(nearTopRight.placement === "below-left", "top-right label did not flip both axes");
  assert(nearTopRight.x >= 8 && nearTopRight.x + 120 <= 292, "label lost its node anchor");
  assert(nearTopRight.y >= 8 && nearTopRight.y + 80 <= 172, "label escaped vertically");

  const cramped = placeTooltip({
    anchorX: 50,
    anchorY: 25,
    width: 140,
    height: 90,
    viewportWidth: 100,
    viewportHeight: 60,
  });
  assert(cramped.x === 8 && cramped.y === 8, "oversized label was not clamped to the viewport");
});

test("price span store returns NaN outside coverage and holds ZOH values", () => {
  const evalTime = new Float64Array([0, 10, 15, 20]);
  const store = new PriceSpanStore();
  const empty = store.sample(evalTime, 20);
  assert(empty.value.every(Number.isNaN), "empty store did not return NaN");

  store.insertBatch([
    {
      startTime: 5,
      endTime: 15,
      startLogPrice: 1,
      endLogPrice: 2,
      resolutionMs: 10,
    },
    {
      startTime: 15,
      endTime: 25,
      startLogPrice: 2,
      endLogPrice: 2,
      resolutionMs: 10,
    },
  ]);
  const sampled = store.sample(evalTime, 20).value;
  assert(Number.isNaN(sampled[0]!), "value before first observation was defined");
  assert(sampled[1] === 1 && sampled[2] === 2 && sampled[3] === 2, "ZOH evaluation is incorrect");
  assert(store.logPriceAtOrBefore(4) === null, "predecessor lookup invented a leading price");
  assert(store.logPriceAtOrBefore(10) === 1, "predecessor lookup missed an interior value");
  assert(store.logPriceAtOrBefore(15) === 2, "predecessor lookup missed a boundary value");
  assert(store.logPriceAtOrBefore(30) === 2, "predecessor lookup did not hold the latest price");
});

test("price predecessor lookup holds across uncovered gaps", () => {
  const store = new PriceSpanStore();
  store.insertBatch([
    {
      startTime: 10,
      endTime: 20,
      startLogPrice: 1,
      endLogPrice: 2,
      resolutionMs: 10,
    },
    {
      startTime: 40,
      endTime: 50,
      startLogPrice: 3,
      endLogPrice: 4,
      resolutionMs: 10,
    },
  ]);
  assert(store.logPriceAtOrBefore(30) === 2, "gap lookup did not use the preceding observation");
  assert(
    store.logPriceAtOrBefore(40) === 3,
    "new observation did not take effect at its timestamp",
  );
});

test("broker read is side-effect-free and viewport subscriptions drive fetching", async () => {
  let calls = 0;
  let notifications = 0;
  const fetcher: Fetcher = {
    async fetchRange({ range }) {
      calls++;
      return {
        points: [
          { t: range.min, price: 100 },
          { t: range.max, price: 101 },
        ],
        searchedRange: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const request = {
    evalTime: new Float64Array([0, 1_000, 2_000]),
    maxDeltaTMs: 1_000,
  };

  const empty = broker.read(request);
  assert(calls === 0, "read unexpectedly started a network request");
  assert(empty.value.every(Number.isNaN), "empty cache read returned data");

  const subscription = broker.subscribe(
    { range: Range.create(0, 2_000), maxDeltaTMs: 1_000 },
    () => notifications++,
  );
  assert(Number(calls) === 1, "subscription did not ensure its requested range");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(notifications >= 1, "subscription was not notified when its read changed");
  const loaded = broker.read(request);
  approx(Math.exp(loaded.value[0]!), 100, 1e-10);

  subscription.update({ range: Range.create(0, 2_000), maxDeltaTMs: 1_000 });
  assert(Number(calls) === 1, "unchanged viewport demand restarted fetching");
  subscription.dispose();
  broker.dispose();
});

test("broker trusts the adapter plan, not irregular observation spacing", async () => {
  const adapter = createPollingAdapter({
    now: () => 20_000,
    resolve: () => 1_000,
    async fetchRange(plan) {
      return {
        points: [
          { t: 0, price: 100 },
          { t: 10_000, price: 101 },
        ],
        searchedRange: plan.range,
      };
    },
  });
  const broker = new Broker(adapter, { now: () => 20_000 });
  broker.subscribe({ range: Range.create(0, 10_000), maxDeltaTMs: 5_000 }, () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = broker.read({
    evalTime: new Float64Array([0, 5_000, 10_000]),
    maxDeltaTMs: 5_000,
  });
  const ready = result.resolution.filter((segment) => segment.state === "ready");
  assert(ready.length > 0, "adapter observations were not cached");
  assert(
    ready.every((segment) => segment.resolutionMs === 1_000),
    "broker inferred resolution from an irregular timestamp gap",
  );
});

test("leaving now updates the adapter session instead of creating another subscription", () => {
  let liveDisposed = 0;
  let connected = 0;
  const adapter: PriceAdapter = {
    plan: (demand) => ({ ...demand, resolutionMs: 1_000 }),
    connect() {
      connected++;
      let hadLiveDemand = false;
      return {
        setDemands(demands) {
          const hasLiveDemand = demands.some(
            (demand) =>
              demand.range.min <= demand.requestedAtMs && demand.range.max >= demand.requestedAtMs,
          );
          if (hadLiveDemand && !hasLiveDemand) liveDisposed++;
          hadLiveDemand = hasLiveDemand;
        },
        clearCache: () => undefined,
        dispose: () => undefined,
      };
    },
  };
  const broker = new Broker(adapter, { now: () => 10_000 });
  const subscription = broker.subscribe(
    { range: Range.create(0, 10_000), maxDeltaTMs: 1_000 },
    () => undefined,
  );
  subscription.update({ range: Range.create(0, 5_000), maxDeltaTMs: 1_000 });
  assert(connected === 1, "broker opened more than one adapter session");
  assert(liveDisposed === 1, "adapter session did not observe the historical viewport");
});

test("an empty price span store has no invalid cached range", () => {
  const store = new PriceSpanStore();
  assert(store.timeRange() === null, "empty store exposed a cached range");
});

test("finer price spans replace coarse history and reject late coarse overwrites", () => {
  const store = new PriceSpanStore();
  store.insertBatch([
    {
      startTime: 0,
      endTime: 20,
      startLogPrice: 1,
      endLogPrice: 2,
      resolutionMs: 20,
    },
  ]);
  store.insertBatch([
    {
      startTime: 5,
      endTime: 15,
      startLogPrice: 10,
      endLogPrice: 11,
      resolutionMs: 10,
    },
  ]);
  store.insertBatch([
    {
      startTime: 0,
      endTime: 20,
      startLogPrice: -1,
      endLogPrice: -2,
      resolutionMs: 30,
    },
  ]);
  const sampled = store.sample(new Float64Array([2, 7, 15, 18]), 20).value;
  assert(sampled[0] === 1, "late coarse response overwrote leading history");
  assert(sampled[1] === 10, "fine history was not selected");
  assert(sampled[2] === 11, "fine endpoint did not own the shared boundary");
  assert(sampled[3] === 1, "late coarse response overwrote trailing history");
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

test("context-padded circular FFT is exact throughout the requested window", () => {
  const radius = 65;
  const visible = 173;
  const returns = new Float64Array(radius + visible + radius);
  for (let i = 0; i < returns.length; i += 11) returns[i] = Math.cos(i * 0.37) * 0.01;
  const scales = new Float64Array([2.5, 7, 13]);
  const full = computeWaveletField(returns, 1, scales, "centered");
  const windowed = computeWaveletField(returns, 1, scales, "centered", undefined, undefined, {
    start: radius,
    count: visible,
  });
  for (let band = 0; band < scales.length; band++) {
    const offset = band * returns.length;
    for (let i = radius; i < radius + visible; i++) {
      approx(windowed.values[offset + i]!, full.values[offset + i]!, 2e-14);
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

test("live adapter subscriptions fetch elapsed wall-clock time without UI reloads", async () => {
  let now = 10_000;
  const requests: Range[] = [];
  const fetcher: Fetcher = {
    liveRetryDelayMs: 5,
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(requests.length >= 2, "adapter did not fetch elapsed wall-clock time");
  assert(
    requests[1]!.min <= 10_000 && requests[1]!.max >= 12_000,
    "expanded live request did not cover the elapsed gap",
  );
});

test("last-point expected lifetime suppresses moving-now micro-requests", async () => {
  let now = 7.5;
  const requests: Range[] = [];
  const fetcher: Fetcher = {
    publicationGraceMs: 1,
    async fetchRange({ range }) {
      requests.push(range);
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5, price: 11 },
        ],
        resolutionHintMs: 5,
        searchedRange: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => now });
  const evalTime = new Float64Array([0, 5, 10, 15]);
  broker.query({ evalTime, maxDeltaTMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(count(requests) === 1, "initial live request was not issued");

  now = 8;
  broker.query({ evalTime, maxDeltaTMs: 5 });
  now = 9.999;
  broker.query({ evalTime, maxDeltaTMs: 5 });
  assert(count(requests) === 1, "wall-clock movement refetched the same candle");

  now = 11.001;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(count(requests) === 2, "crossing the publication grace did not refresh");
  assert(
    requests[1]!.min <= 10 && requests[1]!.max >= 11.001,
    "expanded live refresh did not cover the next sample boundary",
  );
});

test("a lagging live endpoint is polled on its refresh cadence, not every redraw", async () => {
  let now = 10_001;
  let notifications = 0;
  const requests: Range[] = [];
  const fetcher: Fetcher = {
    liveRetryDelayMs: 5,
    async fetchRange({ range }) {
      requests.push(range);
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
        ],
        resolutionHintMs: 5_000,
        searchedRange: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => now });
  const evalTime = new Float64Array([0, 5_000, 10_000, 15_000]);
  broker.subscribe({ range: Range.create(0, 15_000), maxDeltaTMs: 5_000 }, () => notifications++);
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  now = 10_003;
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  assert(count(requests) === 1, "redraw bypassed the live refresh lease");

  now = 10_007;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(notifications >= 2, "live refresh timer did not invalidate the subscriber");
  const polled = count(requests);
  assert(polled >= 2, "adapter did not poll the lagging live endpoint");
  now = 10_020;
  broker.query({ evalTime, maxDeltaTMs: 5_000 });
  assert(count(requests) === polled, "UI redraw started a live request");
  broker.dispose();
});

test("follow-now demand updates keep one live lease and do not feed notifications back", async () => {
  let now = 10_000;
  let calls = 0;
  let notifications = 0;
  const adapter = createPollingAdapter({
    now: () => now,
    livePollDelayMs: 60_000,
    minFetchPoints: 8,
    resolve: () => 1_000,
    async fetchRange(plan) {
      calls++;
      return { points: [], searchedRange: plan.range };
    },
  });
  const broker = new Broker(adapter, { now: () => now });
  const subscription = broker.subscribe(
    { range: Range.create(2_000, 20_000), maxDeltaTMs: 1_000 },
    () => notifications++,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(calls === 1, "initial live lease did not fetch");
  const settledNotifications = notifications;

  for (let frame = 0; frame < 500; frame++) {
    now += 1;
    subscription.update({
      range: Range.create(2_000 + frame, now + 10_000),
      maxDeltaTMs: 1_000,
    });
  }

  assert(calls === 1, `follow updates multiplied live work to ${calls} requests`);
  assert(
    notifications === settledNotifications,
    `follow updates fed ${notifications - settledNotifications} status notifications back`,
  );
  const status = broker.read({
    evalTime: new Float64Array([0, now]),
    maxDeltaTMs: 1_000,
  });
  assert(
    status.resolution.some((segment) => segment.state === "watching"),
    "live lease was missing from acquisition diagnostics",
  );
  subscription.dispose();
  broker.dispose();
});

test("adapter expands tiny demands and broker caches the complete delivery", async () => {
  let calls = 0;
  let fetched: Range | null = null;
  const adapter = createPollingAdapter({
    now: () => 100_000,
    minFetchPoints: 8,
    resolve: () => 1_000,
    async fetchRange(plan) {
      calls++;
      fetched = plan.range;
      return {
        points: [
          { t: plan.range.min, price: 100 },
          { t: plan.range.max, price: 101 },
        ],
        searchedRange: plan.range,
      };
    },
  });
  const broker = new Broker(adapter, { now: () => 100_000 });
  const subscription = broker.subscribe(
    { range: Range.create(50_000, 50_001), maxDeltaTMs: 1_000 },
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const expanded = fetched as Range | null;
  assert(expanded !== null && expanded.max - expanded.min >= 8_000, "tiny demand was not expanded");

  subscription.update({
    range: Range.create(expanded.min + 1_000, expanded.max - 1_000),
    maxDeltaTMs: 1_000,
  });
  assert(calls === 1, "broker discarded useful data outside the original demand");
  subscription.dispose();
  broker.dispose();
});

test("adapter keeps a live lease warm for its configured grace period", async () => {
  let now = 10_000;
  let latestStates: readonly string[] = [];
  const adapter = createPollingAdapter({
    now: () => now,
    liveRetentionMs: 20,
    livePollDelayMs: 60_000,
    minFetchPoints: 2,
    resolve: () => 1_000,
    async fetchRange(plan) {
      return { points: [], searchedRange: plan.range };
    },
  });
  const session = adapter.connect({
    next: () => undefined,
    status: (activities) => {
      latestStates = activities.map((activity) => activity.state);
    },
    error: () => undefined,
  });
  session.setDemands([{ range: Range.create(0, 20_000), maxDeltaTMs: 1_000, requestedAtMs: now }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  session.setDemands([]);
  assert(latestStates.includes("watching"), "live lease closed without its grace period");

  now += 21;
  session.setDemands([]);
  assert(!latestStates.includes("watching"), "expired live lease stayed open");
  session.dispose();
});

test("returned future points are discarded while the last valid sample is held", async () => {
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
    "presented coverage entered the future",
  );
  assert(Number.isNaN(result.value[2]!), "future value was rendered");
  approx(Math.exp(broker.logPriceAtOrBefore(10_000)!), 11, 1e-12);
  assert(
    warnings.some((message) => message.includes("10000")),
    "future API point was silent",
  );
});

test("hierarchical span summaries answer full-range quality without scanning history", () => {
  const store = new PriceSpanStore();
  const spans = Array.from({ length: 2_000 }, (_, index) => ({
    startTime: index * 1_000,
    endTime: (index + 1) * 1_000,
    startLogPrice: index,
    endLogPrice: index + 1,
    resolutionMs: index === 1_000 ? 5_000 : 1_000,
  }));
  store.insertBatch(spans);
  assert(store.answers(Range.create(0, 2_000_000), 5_000), "coarse query was not answered");
  assert(!store.answers(Range.create(0, 2_000_000), 1_000), "coarse interval satisfied fine query");
});

test("coverage summaries isolate gaps at leaf-block boundaries", () => {
  const store = new PriceSpanStore();
  const spans = Array.from({ length: 1_024 }, (_, index) => {
    const gap = index >= 512 ? 10_000 : 0;
    return {
      startTime: index * 1_000 + gap,
      endTime: (index + 1) * 1_000 + gap,
      startLogPrice: index,
      endLogPrice: index + 1,
      resolutionMs: 1_000,
    };
  });
  store.insertBatch(spans);
  assert(
    store.answers(Range.create(522_000, 1_034_000), 1_000),
    "query beginning after a block-boundary gap was rejected",
  );
  assert(
    !store.answers(Range.create(0, 1_034_000), 1_000),
    "block-boundary gap was hidden by the summary tree",
  );
});

test("ready data is projected out of fetched-but-empty coverage", () => {
  const coverage = new FetchedCoverageIndex();
  coverage.add(5_000, Range.create(0, 10_000));
  const ready = new RangeSet();
  ready.add(Range.create(2_000, 8_000));
  const empty = coverage.emptySegments(Range.create(0, 10_000), 5_000, ready);
  for (const segment of empty) {
    assert(segment.range.max <= 2_000 || segment.range.min >= 8_000, "ready/empty overlap");
  }
});

test("finer fetched evidence satisfies coarser continuously varying zoom demands", () => {
  const coverage = new FetchedCoverageIndex();
  coverage.add(1_001.25, Range.create(0, 10_000));
  assert(coverage.answers(Range.create(0, 10_000), 5_432.1), "finer empty evidence was ignored");
  assert(
    !coverage.answers(Range.create(0, 10_000), 500),
    "coarse empty evidence suppressed a finer query",
  );
});

test("RangeSet preserves many chronological fragments without full-list rebuilds", () => {
  const ranges = new RangeSet();
  for (let index = 0; index < 20_000; index++) {
    ranges.add(Range.create(index * 4, index * 4 + 1));
  }
  assert(ranges.ranges().length === 20_000, "disjoint ranges were merged or lost");
  assert(ranges.contains(40_000), "binary lookup missed an inserted range");
  assert(!ranges.contains(40_002), "binary lookup crossed a gap");
});

test("searched market closures do not create an intermediate-zoom fetch storm", async () => {
  let calls = 0;
  const fetcher: Fetcher = {
    fetchRange({ range }) {
      calls++;
      if (calls > 1) return new Promise(() => undefined);
      return Promise.resolve({
        points: [
          { t: 0, price: 10 },
          { t: 1_000, price: 11 },
          { t: 2_000, price: 12 },
          // Simulated overnight/weekend closure.
          { t: 10_000, price: 13 },
          { t: 11_000, price: 14 },
        ],
        resolutionHintMs: 1_000,
        searchedRange: range,
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 11_000 });
  const evalTime = new Float64Array([0, 5_500, 11_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_001.25 });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const intermediate = broker.query({ evalTime, maxDeltaTMs: 5_432.1 });
  assert(intermediate.status === "complete", "market closure became unresolved at mid zoom");
  assert(calls === 1, `market closure triggered ${calls - 1} redundant request(s)`);
  broker.dispose();
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
  const broker = new Broker(fetcher, { now: () => 20_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  broker.query({ evalTime, maxDeltaTMs: 1_000 });
  assert(requests.length === 2, `bounded scheduler started ${requests.length} calls`);
  assert(
    requests[1]!.min <= 0 && requests[1]!.max >= 5_000,
    "unsearched prefix was marked covered",
  );
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

test("moving demand aborts stale serialized work before starting the latest range", async () => {
  let calls = 0;
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let aborted = 0;
  let finish!: (result: FetchRangeResult) => void;
  const fetcher: Fetcher = {
    serializeRequests: true,
    fetchRange({ signal }) {
      calls++;
      activeCalls++;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      return new Promise((resolve, reject) => {
        const abort = (): void => {
          aborted++;
          activeCalls--;
          reject(new DOMException("Disposed", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        finish = (result) => {
          signal.removeEventListener("abort", abort);
          activeCalls--;
          resolve(result);
        };
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 3_000 });
  broker.query({ evalTime: new Float64Array([0, 1_000]), maxDeltaTMs: 1_000 });
  broker.query({ evalTime: new Float64Array([2_000, 3_000]), maxDeltaTMs: 1_000 });
  assert(calls === 2, "latest viewport did not replace stale serialized work");
  assert(aborted === 1 && maxActiveCalls === 1, "stale and current requests overlapped");
  finish({ points: [], searchedRange: Range.create(2_000, 3_000) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  broker.dispose();
});

test("source-wide backoff suppresses new moving-tail ranges", async () => {
  let calls = 0;
  const fetcher: Fetcher = {
    sourceWideBackoff: true,
    retryDelayMs: () => 1_000,
    async fetchRange() {
      calls++;
      throw new Error("rate limited");
    },
  };
  const broker = new Broker(fetcher, { now: () => 3_000, onError: () => undefined });
  broker.query({ evalTime: new Float64Array([0, 1_000]), maxDeltaTMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  broker.query({ evalTime: new Float64Array([2_000, 3_000]), maxDeltaTMs: 1_000 });
  assert(calls === 1, "a disjoint moving-tail range bypassed source-wide backoff");
  broker.dispose();
});

test("subscriber failures are not reclassified as fetch failures", async () => {
  const errors: string[] = [];
  const fetcher: Fetcher = {
    async fetchRange({ range }) {
      return {
        points: [{ t: 500, price: 100 }],
        resolutionHintMs: 1_000,
        searchedRange: range,
      };
    },
  };
  const broker = new Broker(fetcher, {
    now: () => 1_000,
    onError: (message) => errors.push(message),
  });
  const query = { evalTime: new Float64Array([0, 1_000]), maxDeltaTMs: 1_000 };
  broker.subscribe({ range: Range.create(0, 1_000), maxDeltaTMs: 1_000 }, () => {
    throw new Error("UI failed");
  });
  broker.query(query);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = broker.query(query);
  assert(
    result.resolution.every((segment) => segment.state !== "failed"),
    "subscriber exception became a failed exchange range",
  );
  assert(errors.includes("[Broker] subscriber failed"), "subscriber exception was hidden");
  assert(!errors.some((message) => message.includes("fetch failed")), "fetch was blamed for UI");
  const cached = broker.cachedRange();
  assert(
    cached !== null && cached.min === 500 && cached.max === 1_500,
    "singleton hold range was lost",
  );
  broker.dispose();
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
    const adapter = createBinanceAdapter({ symbol: "ethusdt" });
    const demand = {
      range: Range.create(0, 7_200_000),
      maxDeltaTMs: 3_600_000,
      requestedAtMs: 7_200_000,
    };
    const plan = adapter.plan(demand);
    const result = await fetchOnce(adapter, demand);
    const url = new URL(requestedUrl);
    assert(url.searchParams.get("symbol") === "ETHUSDT", "symbol was not normalized");
    assert(url.searchParams.get("interval") === "1h", "wrong Binance interval");
    assert(plan.resolutionMs === 3_600_000, "wrong planned native resolution");
    assert(result.points.length === 2, "Binance rows were not converted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Yahoo adapter supports WTI and Brent futures with range-aware intervals", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    requestedUrl = input instanceof Request ? input.url : input.toString();
    return new Response(
      JSON.stringify({
        chart: {
          result: [
            {
              timestamp: [0, 3_600],
              indicators: { quote: [{ open: [75.5, 76.25] }] },
            },
          ],
          error: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const adapter = createYahooAdapter({ symbol: "bz=f", now: () => 7_200_000 });
    const demand = {
      range: Range.create(0, 7_200_000),
      maxDeltaTMs: 3_600_000,
      requestedAtMs: 7_200_000,
    };
    const plan = adapter.plan(demand);
    const result = await fetchOnce(adapter, demand);
    const target = new URL(requestedUrl).searchParams.get("url") ?? "";
    assert(target.includes("/BZ%3DF?"), "Brent symbol was not encoded in Yahoo request");
    assert(target.includes("interval=60m"), "wrong Yahoo interval");
    assert(result.points.length === 2 && result.points[1]!.t === 3_600_000, "bad Yahoo rows");
    assert(plan.resolutionMs === 3_600_000, "wrong Yahoo native resolution");

    const secondRange = Range.create(1_000, 7_200_000);
    const cached = await fetchOnce(adapter, {
      range: secondRange,
      maxDeltaTMs: 3_600_000,
      requestedAtMs: 7_200_000,
    });
    assert(calls === 1, "same Yahoo candle window caused another HTTP request");
    assert(
      cached.searchedRange.min <= secondRange.min && cached.searchedRange.max >= secondRange.max,
      "cached expanded response did not cover the requested range",
    );

    adapter.clearCache?.();
    await fetchOnce(adapter, {
      range: secondRange,
      maxDeltaTMs: 3_600_000,
      requestedAtMs: 7_200_000,
    });
    assert(Number(calls) === 2, "explicit reload did not clear Yahoo's response cache");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert(
    chooseYahooInterval(60_000, 0, 9 * 86_400_000)?.interval === "2m",
    "Yahoo lookback limit did not select the finest available fallback",
  );
  assert(marketSource("yahoo")?.normalizeSymbol(" cl=f ") === "CL=F", "WTI was rejected");
});

test("Yahoo honors Retry-After on HTTP 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "7" },
    })) as typeof fetch;
  try {
    const adapter = createYahooAdapter({ symbol: "CL=F", now: () => 120_000 });
    const retry = await retryOnce(adapter, {
      range: Range.create(60_000, 120_000),
      maxDeltaTMs: 60_000,
      requestedAtMs: 120_000,
    });
    assert(retry.error instanceof Error, "Yahoo 429 did not surface an error");
    assert(retry.retryAtMs === 127_000, "Retry-After was ignored");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("market symbol discovery normalizes Nobitex pairs and filters without forcing a match", () => {
  const rial = parseNobitexMarketKey("btc-rls");
  assert(rial?.symbol === "BTCIRT", "Nobitex RLS pair was not mapped to its candle symbol");
  const options = [
    { symbol: "BTCUSDT", label: "BTC / USDT" },
    { symbol: "ETHUSDT", label: "ETH / USDT" },
    { symbol: "BTCEUR", label: "BTC / EUR" },
  ];
  const filtered = filterMarketSymbols(options, "btc");
  assert(filtered.length === 2, "autocomplete did not filter by typed value");
  assert(filterMarketSymbols(options, "NEWCOIN").length === 0, "unknown ticker was invented");
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
  } finally {
    for (const broker of [...brokers]) broker.dispose();
  }
}
if (failures > 0) throw new Error(`${failures} test(s) failed`);
