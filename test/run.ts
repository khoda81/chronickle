import type { NewsEvent, RssFeed } from "../src/domain.ts";
import { EventBroker } from "../src/data/events/broker.ts";
import { Broker as PriceBroker } from "../src/data/signal/broker.ts";
import type {
  BrokerOptions,
  Subscription,
  ReadRequest,
  SignalView,
  BrokerDemand,
} from "../src/data/signal/broker.ts";
import { createBinanceAdapter } from "../src/data/signal/market/adapters/binanceFetcher.ts";
import { createNobitexAdapter } from "../src/data/signal/market/adapters/nobitexFetcher.ts";
import {
  chooseYahooInterval,
  createYahooAdapter,
} from "../src/data/signal/market/adapters/yahoo.ts";
import { logPriceSamples } from "../src/data/signal/market/price.ts";
import {
  createPollingSignalSource,
  type AcquisitionActivity,
  type AdapterBatch,
  type AdapterDelivery,
  type SignalAdapter,
} from "../src/data/signal/fetcher.ts";
import { priceSignalSource } from "../src/data/signal/market/market.ts";
import { filterMarketSymbols, parseNobitexMarketKey } from "../src/data/signal/market/symbols.ts";
import { SignalSegmentStore } from "../src/data/signal/store.ts";
import { Interval, IntervalSet } from "../src/core/interval.ts";
import { deserializePersistedUiState } from "../src/app/persistence.ts";
import {
  fitStackLayout,
  heatmapScaleWindow,
  ROW_REMOVE_THRESHOLD,
  signalRowCollapseProgress,
  signalRowContainsHeatmap,
  signalRowLayout,
} from "../src/engine/gfx/layout.ts";
import { formatResolution } from "../src/engine/gfx/resolution.ts";
import { eventIndexAtOrBefore, eventIndexNearPoint } from "../src/engine/hittest.ts";
import { DataTransform } from "../src/engine/transform.ts";
import { GestureSession, transformTouchInterval } from "../src/engine/gesture.ts";
import {
  TimelineGestureController,
  type TimelineGestureHost,
} from "../src/engine/timelineGestureController.ts";
import { placeTooltip } from "../src/app/timeline/TimelineOverlayController.ts";
import {
  computeCenteredGaussianReference,
  computeWaveletField,
  kernelContext,
  signalEdgesToDeltas,
  usedSampleDensity,
} from "../src/engine/wavelet.ts";

type Test = { readonly name: string; readonly run: () => void | Promise<void> };
const tests: Test[] = [];

test("Interval normalizes reversed bounds to an empty half-open interval", () => {
  const interval = Interval.create(10, 5);
  assert(interval.start === 10 && interval.end === 10, "reversed interval was not normalized");
  assert(Interval.isEmpty(interval), "normalized interval was not empty");
  assert(!Interval.contains(interval, 10), "empty interval contained its boundary");
});

test("persisted UI state migrates v3 range bounds to a branded interval", () => {
  const fallback = {
    version: 4 as const,
    viewport: Interval.create(0, 1),
    playback: { mode: "following" as const, anchor: 0.85 },
    newsHeight: 110,
    charts: [],
  };
  const restored = deserializePersistedUiState(
    JSON.stringify({
      version: 3,
      viewport: { min: 100, max: 200 },
      playback: { mode: "paused" },
      newsHeight: 120,
      charts: [{ sourceId: "yahoo", symbol: "CL=F", height: 80 }],
    }),
    fallback,
  );

  assert(restored.version === 4, "persisted state version was not migrated");
  assert(
    restored.viewport.start === 100 && restored.viewport.end === 200,
    "legacy viewport was not migrated",
  );
  assert(restored.playback.mode === "paused", "playback state was not restored");
  assert(restored.newsHeight === 120, "news row height was not restored");
  assert(restored.charts[0]?.height === 80, "chart layout was not restored");
  assert(restored.charts[0]?.verticalOffset === 0, "chart offset was not defaulted");
  assert(restored.charts[0]?.waveletMode === "centered", "chart wavelet mode was not defaulted");
});

interface FetchIntervalResult {
  readonly points: readonly { readonly t: number; readonly price: number }[];
  readonly resolutionHintMs?: number;
  readonly searchedInterval?: Interval;
}

interface Fetcher {
  readonly sourceWideBackoff?: boolean;
  readonly liveRetryDelayMs?: number;
  readonly publicationGraceMs?: number;
  fetchInterval(request: {
    readonly range: Interval;
    readonly maxDeltaTMs: number;
    readonly signal: AbortSignal;
  }): Promise<FetchIntervalResult>;
  retryDelayMs?(error: unknown, attempt: number): number;
  clearCache?(): void;
}

const brokers = new Set<Broker>();

interface TestBrokerOptions extends Omit<BrokerOptions, "signal"> {
  /** Test adapter clock; the broker itself is deliberately clock-free. */
  readonly now?: () => number;
}

interface QueryRequest extends ReadRequest {
  /** Compatibility helper turns this into subscription demand before reading. */
  readonly maxSampleGapMs: number;
}

class Broker extends PriceBroker {
  private compatibilitySubscription: Subscription | null = null;
  private readonly lifetime: AbortController;

  constructor(source: Fetcher | SignalAdapter, opts: TestBrokerOptions = {}) {
    const lifetime = new AbortController();
    const { now = Date.now, ...brokerOptions } = opts;
    super(isAdapter(source) ? source : adaptFetcher(source, now), {
      ...brokerOptions,
      signal: lifetime.signal,
    });
    this.lifetime = lifetime;
    brokers.add(this);
  }

  override subscribe(
    demand: BrokerDemand,
    fn: () => void,
    signal: AbortSignal = this.lifetime.signal,
  ): Subscription {
    return super.subscribe(demand, fn, signal);
  }

  query(opts: QueryRequest): SignalView {
    if (opts.evalTime.length >= 2) {
      const demand = {
        range: Interval.create(opts.evalTime[0]!, opts.evalTime[opts.evalTime.length - 1]!),
        maxDeltaTMs: opts.maxSampleGapMs,
      };
      if (this.compatibilitySubscription === null) {
        this.compatibilitySubscription = this.subscribe(demand, () => undefined);
      } else {
        this.compatibilitySubscription.update(demand);
      }
    }
    return this.read({ evalTime: opts.evalTime });
  }

  close(): void {
    this.compatibilitySubscription = null;
    this.lifetime.abort();
    brokers.delete(this);
  }
}

function isAdapter(source: Fetcher | SignalAdapter): source is SignalAdapter {
  return "connect" in source;
}

function adaptFetcher(fetcher: Fetcher, now: () => number): SignalAdapter {
  return createPollingSignalSource({
    sourceWideBackoff: fetcher.sourceWideBackoff,
    livePollDelayMs: fetcher.liveRetryDelayMs,
    publicationGraceMs: fetcher.publicationGraceMs,
    now,
    resolve: demand => demand.maxDeltaTMs,
    retryDelayMs: fetcher.retryDelayMs?.bind(fetcher),
    clearCache: fetcher.clearCache?.bind(fetcher),
    async fetchInterval(plan, signal) {
      const result = await fetcher.fetchInterval({
        range: plan.range,
        maxDeltaTMs: plan.resolutionMs,
        signal,
      });
      return {
        samples: logPriceSamples(result.points),
        searchedInterval: result.searchedInterval ?? plan.range,
      };
    },
  });
}

function fetchOnce(adapter: SignalAdapter, demand: BrokerDemand): Promise<AdapterDelivery> {
  return new Promise((resolve, reject) => {
    const lifetime = new AbortController();
    const session = adapter.connect(
      {
        next: batch => {
          lifetime.abort();
          resolve(batch);
        },
        status: () => undefined,
        error: error => {
          lifetime.abort();
          reject(error);
        },
      },
      lifetime.signal,
    );
    session.setDemands([demand]);
  });
}

function retryOnce(
  adapter: SignalAdapter,
  demand: BrokerDemand,
): Promise<{ readonly error: unknown; readonly retryAtMs: number }> {
  return new Promise(resolve => {
    const lifetime = new AbortController();
    const session = adapter.connect(
      {
        next: () => undefined,
        status: () => undefined,
        error: (error, activity) => {
          lifetime.abort();
          resolve({ error, retryAtMs: activity.retryAtMs! });
        },
      },
      lifetime.signal,
    );
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

function heldSegment(
  rangeStart: number,
  rangeEnd: number,
  sampleTime: number,
  value: number,
  resolutionMs: number,
) {
  return { range: Interval.create(rangeStart, rangeEnd), sampleTime, value, resolutionMs } as const;
}

function assertPoint(
  sample: { readonly t: number; readonly value: number },
  expectedT: number,
  expectedValue: number,
  message: string,
): void {
  assert(sample.t === expectedT && sample.value === expectedValue, message);
}

function count(items: readonly unknown[]): number {
  return items.length;
}

function clientPoint(clientX: number, clientY: number) {
  return { clientX, clientY } as const;
}

class FakeCanvasTarget extends EventTarget {
  readonly style = { cursor: "" };
  readonly capturedPointers = new Set<number>();

  getBoundingClientRect(): DOMRect {
    return {
      left: 10,
      top: 20,
      right: 110,
      bottom: 70,
      width: 100,
      height: 50,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    };
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointers.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointers.delete(pointerId);
  }
}

interface SyntheticInputOptions {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaMode?: number;
  readonly shiftKey?: boolean;
}

function syntheticInput(type: string, options: SyntheticInputOptions): Event {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(options)) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

function withFakeWindow(run: (target: EventTarget) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  try {
    run(target);
  } finally {
    if (descriptor === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", descriptor);
  }
}

test("gesture session suppresses exactly one click after a real drag", () => {
  const gesture = new GestureSession();
  assert(gesture.beginPointer(1, null, 3, clientPoint(10, 20)), "pointer drag did not start");
  const started = gesture.state;
  assert(started.kind === "drag" && started.row === 3, "drag target row was lost");
  const point = started.point;

  gesture.move(1, clientPoint(13, 24));
  assert(gesture.state === started, "pointer move replaced the gesture state object");
  assert(
    started.point === point && point.clientX === 13 && point.clientY === 24,
    "point was not mutated in place",
  );
  assert(started.moved, "five-pixel drag did not cross the movement threshold");
  assert(gesture.end(1), "pointer drag did not end");
  assert(gesture.consumeSuppressedClick(), "drag click was not suppressed");
  assert(!gesture.consumeSuppressedClick(), "click suppression was not consumed once");
});

test("gesture session keeps taps clickable and cancellations inert", () => {
  const gesture = new GestureSession();
  gesture.beginPointer(1, 2, null, clientPoint(10, 20));
  assert(gesture.activeBoundary === 2, "resize boundary was not represented by state");
  gesture.move(1, clientPoint(12, 21));
  gesture.end(1);
  assert(!gesture.consumeSuppressedClick(), "sub-threshold tap was suppressed");

  gesture.beginPointer(2, null, null, clientPoint(0, 0));
  gesture.move(2, clientPoint(20, 0));
  gesture.end(2, true);
  assert(!gesture.consumeSuppressedClick(), "cancelled gesture leaked click suppression");
});

test("gesture session transitions touch drag through pinch without parallel flags", () => {
  const gesture = new GestureSession();
  assert(gesture.beginTouch(4, null, 7, clientPoint(10, 20)), "first touch did not start");
  assert(gesture.beginTouch(5, null, 9, clientPoint(30, 40)), "second touch did not start pinch");
  const pinch = gesture.state;
  assert(pinch.kind === "pinch" && pinch.row === 7, "pinch did not retain the first touch row");
  assert(
    !gesture.beginTouch(6, null, null, clientPoint(50, 60)),
    "third touch was incorrectly tracked",
  );

  gesture.move(5, clientPoint(35, 45));
  assert(
    pinch.secondary.clientX === 35 && pinch.secondary.clientY === 45,
    "pinch point did not update",
  );
  assert(gesture.end(4), "first pinch pointer did not end");
  const remaining = gesture.state;
  assert(
    remaining.kind === "drag" &&
    remaining.input === "touch" &&
    remaining.pointerId === 5 &&
    remaining.row === 7 &&
    remaining.moved,
    "pinch did not become a moved drag for the remaining touch",
  );
  assert(gesture.end(5), "remaining touch did not end");
  assert(gesture.consumeSuppressedClick(), "pinch-generated click was not suppressed");
});

test("pinch transform combines centroid movement and scale in one interval update", () => {
  const transformed = transformTouchInterval(Interval.create(0, 100), 100, 50, 60, 20, 40);
  assert(
    transformed.start === 20 && transformed.end === 70,
    "pinch scale and translation were applied in the wrong coordinate frame",
  );
});

test("timeline gesture controller owns native drag events and canvas projection", () => {
  withFakeWindow(windowTarget => {
    const canvasTarget = new FakeCanvasTarget();
    const canvas = canvasTarget as unknown as HTMLCanvasElement;
    const lifetime = new AbortController();
    let starts = 0;
    let ends = 0;
    let taps = 0;
    let targetX = Number.NaN;
    let targetY = Number.NaN;
    let panX = Number.NaN;
    let panWidth = Number.NaN;
    let panRow = Number.NaN;
    let panY = Number.NaN;

    const host: TimelineGestureHost = {
      targetAt(point) {
        targetX = point.x;
        targetY = point.y;
        return { kind: "viewport", row: 4 };
      },
      gestureStarted() {
        starts++;
      },
      gestureEnded() {
        ends++;
      },
      panTimeByPixels(deltaX, viewportWidth) {
        panX = deltaX;
        panWidth = viewportWidth;
      },
      panRow(row, deltaY) {
        panRow = row ?? Number.NaN;
        panY = deltaY;
      },
      resizeBoundary() { },
      pinchTime() { },
      wheel() { },
      hoverMoved() { },
      pointerLeft() { },
      tap() {
        taps++;
      },
      doubleTap() { },
    };
    const controller = new TimelineGestureController({
      canvas,
      viewport: { width: 200, height: 100 },
      wheelLineHeight: 16,
      host,
      signal: lifetime.signal,
    });

    canvasTarget.dispatchEvent(
      syntheticInput("pointerdown", {
        clientX: 60,
        clientY: 30,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
    windowTarget.dispatchEvent(
      syntheticInput("pointermove", {
        clientX: 70,
        clientY: 35,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
    windowTarget.dispatchEvent(
      syntheticInput("pointerup", { clientX: 70, clientY: 35, pointerId: 1, pointerType: "mouse" }),
    );
    canvasTarget.dispatchEvent(syntheticInput("click", { clientX: 70, clientY: 35 }));

    assert(targetX === 100 && targetY === 20, "client point was not projected into canvas space");
    assert(panX === 10 && panWidth === 100, "horizontal drag was not normalized");
    assert(panRow === 4 && panY === 10, "vertical drag was not normalized to canvas pixels");
    assert(starts === 1 && ends === 1 && !controller.active, "drag lifecycle was not closed");
    assert(taps === 0, "drag-generated click reached the timeline host");
    assert(canvasTarget.capturedPointers.size === 0, "pointer capture was not released");

    lifetime.abort();
    canvasTarget.dispatchEvent(
      syntheticInput("pointerdown", {
        clientX: 60,
        clientY: 30,
        pointerId: 2,
        pointerType: "mouse",
      }),
    );
    assert(starts === 1, "aborted controller still received native events");
  });
});

test("timeline gesture controller combines two touch pointers into one pinch update", () => {
  withFakeWindow(windowTarget => {
    const canvasTarget = new FakeCanvasTarget();
    const lifetime = new AbortController();
    let previousCenterX = Number.NaN;
    let currentCenterX = Number.NaN;
    let previousDistance = Number.NaN;
    let currentDistance = Number.NaN;
    let row = Number.NaN;
    let verticalDelta = Number.NaN;
    const finishedStates: boolean[] = [];
    const host: TimelineGestureHost = {
      targetAt: () => ({ kind: "viewport", row: 6 }),
      gestureStarted() { },
      gestureEnded(_input, _cancelled, finished) {
        finishedStates.push(finished);
      },
      panTimeByPixels() { },
      panRow(nextRow, deltaY) {
        row = nextRow ?? Number.NaN;
        verticalDelta = deltaY;
      },
      resizeBoundary() { },
      pinchTime(_viewportWidth, previousCenter, currentCenter, previousSpan, currentSpan) {
        previousCenterX = previousCenter;
        currentCenterX = currentCenter;
        previousDistance = previousSpan;
        currentDistance = currentSpan;
      },
      wheel() { },
      hoverMoved() { },
      pointerLeft() { },
      tap() { },
      doubleTap() { },
    };
    const controller = new TimelineGestureController({
      canvas: canvasTarget as unknown as HTMLCanvasElement,
      viewport: { width: 200, height: 100 },
      wheelLineHeight: 16,
      host,
      signal: lifetime.signal,
    });
    canvasTarget.dispatchEvent(
      syntheticInput("pointerdown", {
        clientX: 30,
        clientY: 30,
        pointerId: 1,
        pointerType: "touch",
      }),
    );
    canvasTarget.dispatchEvent(
      syntheticInput("pointerdown", {
        clientX: 70,
        clientY: 30,
        pointerId: 2,
        pointerType: "touch",
      }),
    );
    const move = syntheticInput("pointermove", {
      clientX: 90,
      clientY: 40,
      pointerId: 2,
      pointerType: "touch",
    });
    windowTarget.dispatchEvent(move);

    assert(previousCenterX === 40 && currentCenterX === 50, "pinch centroid was incorrect");
    assert(previousDistance === 40, "previous pinch distance was incorrect");
    approx(currentDistance, Math.hypot(60, 10));
    assert(row === 6 && verticalDelta === 10, "pinch vertical pan used the wrong row or scale");
    assert(move.defaultPrevented, "touch move default action was not prevented");

    windowTarget.dispatchEvent(
      syntheticInput("pointerup", { clientX: 30, clientY: 30, pointerId: 1, pointerType: "touch" }),
    );
    assert(controller.active, "ending one pinch pointer ended the complete gesture");
    windowTarget.dispatchEvent(
      syntheticInput("pointerup", { clientX: 90, clientY: 40, pointerId: 2, pointerType: "touch" }),
    );
    assert(!controller.active, "remaining touch did not finish the gesture");
    assert(
      finishedStates.length === 2 && !finishedStates[0] && finishedStates[1],
      "touch completion states were not preserved",
    );
    lifetime.abort();
  });
});

test("timeline gesture controller normalizes wheel units without allocating a point", () => {
  withFakeWindow(() => {
    const canvasTarget = new FakeCanvasTarget();
    const lifetime = new AbortController();
    let pointX = Number.NaN;
    let pointY = Number.NaN;
    let wheelX = Number.NaN;
    let wheelY = Number.NaN;
    let shifted = false;
    const host: TimelineGestureHost = {
      targetAt: () => ({ kind: "viewport", row: null }),
      gestureStarted() { },
      gestureEnded() { },
      panTimeByPixels() { },
      panRow() { },
      resizeBoundary() { },
      pinchTime() { },
      wheel(point, deltaX, deltaY, shiftKey) {
        pointX = point.x;
        pointY = point.y;
        wheelX = deltaX;
        wheelY = deltaY;
        shifted = shiftKey;
      },
      hoverMoved() { },
      pointerLeft() { },
      tap() { },
      doubleTap() { },
    };
    new TimelineGestureController({
      canvas: canvasTarget as unknown as HTMLCanvasElement,
      viewport: { width: 200, height: 100 },
      wheelLineHeight: 16,
      host,
      signal: lifetime.signal,
    });
    const wheel = syntheticInput("wheel", {
      clientX: 35,
      clientY: 45,
      deltaX: 2,
      deltaY: 3,
      deltaMode: 1,
      shiftKey: true,
    });
    canvasTarget.dispatchEvent(wheel);

    assert(pointX === 50 && pointY === 50, "wheel anchor used the wrong coordinate space");
    assert(wheelX === 32 && wheelY === 48 && shifted, "wheel line units were not normalized");
    assert(wheel.defaultPrevented, "wheel default action was not prevented");
    lifetime.abort();
  });
});

test("persisted UI state rejects unsupported future schemas", () => {
  const fallback = {
    version: 4 as const,
    viewport: Interval.create(0, 1),
    playback: { mode: "following" as const, anchor: 0.85 },
    newsHeight: 110,
    charts: [],
  };
  const restored = deserializePersistedUiState(
    JSON.stringify({
      version: 99,
      viewport: { start: 100, end: 200 },
      playback: { mode: "paused" },
      charts: [{ sourceId: "yahoo", symbol: "CL=F" }],
    }),
    fallback,
  );

  assert(restored === fallback, "future persistence schema was guessed at");
});

test("market prices become normalized log-signal samples", () => {
  const samples = logPriceSamples([
    { t: 2, price: 20 },
    { t: 1, price: 10 },
    { t: 2, price: 21 },
  ]);
  assert(samples.length === 2, "duplicate timestamp was not collapsed");
  approx(Math.exp(samples[1]!.value), 21, 1e-12);
  let threw = false;
  try {
    logPriceSamples([{ t: 0, price: 0 }]);
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
    layout.rowHeights.every(height => height > 0),
    "a signal row collapsed unexpectedly",
  );

  const noMinimum = fitStackLayout(64, [1, 99], 200);
  assert(noMinimum.rowHeights[0]! < 10, "signal rows still have an implicit minimum height");

  const compact = fitStackLayout(110, [220, 180, 140], 240);
  const compactUsed =
    compact.newsHeight + compact.rowHeights.reduce((sum, height) => sum + height, 0);
  approx(compactUsed, 240, 1e-9);
  assert(
    compact.rowHeights.every(height => height > 0),
    "compact row collapsed",
  );
});

test("signal row layout owns status, heatmap, hit-test, and collapse geometry", () => {
  const row = signalRowLayout(100, 130);
  assert(row.heatmapTop === 116, "status-strip height leaked into the caller");
  assert(row.heatmapHeight === 114 && row.heatmapCenter === 173, "bad heatmap geometry");
  assert(row.drawable, "normal row was not drawable");
  assert(!signalRowContainsHeatmap(100, 130, 115), "status strip entered heatmap hit testing");
  assert(signalRowContainsHeatmap(100, 130, 116), "heatmap top was excluded from hit testing");
  assert(!signalRowLayout(100, 18).drawable, "collapsed row retained drawable heatmap space");
  assert(
    signalRowCollapseProgress(1, ROW_REMOVE_THRESHOLD, 1) === 1,
    "active boundary did not fully expose the remove affordance",
  );
  assert(
    signalRowCollapseProgress(2, ROW_REMOVE_THRESHOLD, 1) === 0,
    "unrelated row received collapse progress",
  );
});

test("vertical heatmap pan preserves a device-pixel time grid", () => {
  const neutral = heatmapScaleWindow(2_000, 220, 0);
  const finer = heatmapScaleWindow(2_000, 220, 480);
  const coarser = heatmapScaleWindow(2_000, 220, -480);
  assert(finer.minSigmaPx < neutral.minSigmaPx, "downward pan did not expose finer scales");
  assert(coarser.minSigmaPx > neutral.minSigmaPx, "upward pan did not expose coarser scales");
  assert(neutral.sampleCellCount === 2_000, "neutral grid was not device-pixel aligned");
  assert(finer.sampleCellCount === 2_000, "fine scale changed the device-pixel grid");
  assert(coarser.sampleCellCount === 2_000, "coarse scale changed the device-pixel grid");
  assert(
    neutral.maxSigmaPx > neutral.minSigmaPx,
    "visible heatmap range did not cover multiple convolution scales",
  );
});

test("event cards overlap their anchor and remain vertically centered", () => {
  const left = placeTooltip({
    anchorX: 220,
    anchorY: 90,
    width: 120,
    height: 80,
    viewportWidth: 300,
    viewportHeight: 180,
    gap: 4,
  });

  assert(left.placement === "left", "tooltip did not prefer the left side");
  assert(left.x === 104, "left tooltip x-position was incorrect");
  assert(left.y === 50, "tooltip was not vertically centered");

  const right = placeTooltip({
    anchorX: 20,
    anchorY: 90,
    width: 120,
    height: 80,
    viewportWidth: 300,
    viewportHeight: 180,
    gap: 4,
  });

  assert(right.placement === "right", "tooltip did not flip near the left edge");
  assert(right.x === 16, "right tooltip x-position was incorrect");
  assert(right.y === 50, "flipped tooltip was not vertically centered");
});

test("resolution labels promote large millisecond values to readable units", () => {
  assert(formatResolution(999) === "999ms", "sub-second resolution lost milliseconds");
  assert(formatResolution(19_459) === "19.5s", "seconds were not promoted or rounded");
  assert(formatResolution(90_000) === "1.5m", "minutes were not promoted");
  assert(formatResolution(5_400_000) === "1.5h", "hours were not promoted");
  assert(formatResolution(129_600_000) === "1.5d", "days were not promoted");
});

test("event hover selects the last visible event at or before the pointer", () => {
  const events = {
    events: [
      { t: 10, title: "a", link: "a", summary: "", feedId: "feed" },
      { t: 30, title: "b", link: "b", summary: "", feedId: "feed" },
      { t: 70, title: "c", link: "c", summary: "", feedId: "feed" },
    ],
  } satisfies { readonly events: readonly NewsEvent[] };
  const tx = new DataTransform(
    Interval.create(0, 100),
    Interval.create(0, 100),
    Interval.create(0, 40),
  );
  assert(eventIndexAtOrBefore(events, tx, 5) === null, "hover invented a leading event");
  assert(eventIndexAtOrBefore(events, tx, 29) === 0, "hover selected a future event");
  assert(eventIndexAtOrBefore(events, tx, 30) === 1, "hover missed an exact event");
  assert(eventIndexAtOrBefore(events, tx, 100) === 2, "hover missed the final event");
  assert(
    eventIndexNearPoint(events, tx, { x: 31, y: 20 }, 20) === 1,
    "click hit-test missed a marker",
  );
  assert(
    eventIndexNearPoint(events, tx, { x: 31, y: 35 }, 20) === null,
    "click hit-test ignored row distance",
  );

  const coincident = {
    events: [events.events[0]!, events.events[1]!, { ...events.events[1]!, title: "latest" }],
  };
  assert(
    eventIndexNearPoint(coincident, tx, { x: 30, y: 20 }, 20) === 2,
    "click hit-test did not choose the last coincident event",
  );
});

test("signal segment store returns NaN outside coverage and holds ZOH values", () => {
  const evalTime = new Float64Array([0, 10, 15, 20]);
  const store = new SignalSegmentStore();
  const empty = store.sample(evalTime);
  assert(empty.every(Number.isNaN), "empty store did not return NaN");

  store.insertBatch([heldSegment(5, 15, 5, 1, 10), heldSegment(15, 25, 15, 2, 10)]);
  const sampleTime = new Float64Array(evalTime.length);
  const sampled = store.sample(evalTime, undefined, sampleTime);
  assert(Number.isNaN(sampled[0]!), "value before first observation was defined");
  assert(sampled[1] === 1 && sampled[2] === 2 && sampled[3] === 2, "ZOH evaluation is incorrect");
  assert(Number.isNaN(sampleTime[0]!), "missing value received an observation identity");
  assert(
    sampleTime[1] === 5 && sampleTime[2] === 15 && sampleTime[3] === 15,
    "sample grid lost selected observation identity",
  );

  const selected = { t: Number.NaN, value: Number.NaN };
  assert(!store.readPointAtOrBefore(4, selected), "predecessor lookup invented a leading value");
  assert(store.readPointAtOrBefore(10, selected), "predecessor lookup missed an interior value");
  assertPoint(selected, 5, 1, "interior point lost its observation");
  assert(store.readPointAtOrBefore(15, selected), "predecessor lookup missed a boundary value");
  assertPoint(selected, 15, 2, "boundary point selected the prior segment");
  assert(store.readPointAtOrBefore(30, selected), "held point lookup failed");
  assertPoint(selected, 15, 2, "held value lost its observation timestamp");
});

test("wavelet density measures selected observations rather than reconstructed holds", () => {
  const store = new SignalSegmentStore();
  store.insertBatch([
    heldSegment(0, 2_000, 0, 1, 1_000),
    heldSegment(2_000, 10_000, 2_000, 2, 1_000),
  ]);
  const evalTime = new Float64Array([0, 1_000, 2_000, 3_000, 4_000]);
  const sampleTime = new Float64Array(evalTime.length);
  store.sample(evalTime, undefined, sampleTime);
  const density = usedSampleDensity(sampleTime, 1, 4);
  assert(density[0] === 0 && density[1] === 1, "selected observation was misplaced");
  assert(density[2] === 0 && density[3] === 0, "reconstructed hold invented observations");
});

test("segment coverage is half-open while predecessor lookup keeps the observation", () => {
  const store = new SignalSegmentStore();
  store.insertBatch([heldSegment(5, 15, 5, 1, 10)]);
  assert(
    Number.isNaN(store.sample(new Float64Array([15]))[0]!),
    "segment end leaked into coverage",
  );

  const selected = { t: Number.NaN, value: Number.NaN };
  assert(store.readPointAtOrBefore(15, selected), "predecessor lookup lost the final observation");
  assertPoint(selected, 5, 1, "predecessor lookup changed the final observation");
});

test("signal predecessor lookup holds across uncovered gaps", () => {
  const store = new SignalSegmentStore();
  store.insertBatch([
    heldSegment(10, 20, 10, 1, 10),
    heldSegment(20, 30, 20, 2, 10),
    heldSegment(40, 50, 40, 3, 10),
    heldSegment(50, 60, 50, 4, 10),
  ]);
  const selected = { t: Number.NaN, value: Number.NaN };
  assert(store.readPointAtOrBefore(35, selected), "gap lookup failed");
  assertPoint(selected, 20, 2, "gap lookup did not use the preceding observation");
  assert(store.readPointAtOrBefore(40, selected), "new observation lookup failed");
  assertPoint(selected, 40, 3, "new observation did not take effect at its timestamp");
});

test("equal-valued observations retain their distinct timestamps", () => {
  const store = new SignalSegmentStore();
  store.insertBatch([heldSegment(0, 10, 0, 1, 10), heldSegment(10, 20, 10, 1, 10)]);
  const selected = { t: Number.NaN, value: Number.NaN };
  assert(store.readPointAtOrBefore(15, selected), "equal-value point lookup failed");
  assert(selected.t === 10, "equal values erased the newer observation time");
});

test("broker read is side-effect-free and viewport subscriptions drive fetching", async () => {
  let calls = 0;
  let notifications = 0;
  const fetcher: Fetcher = {
    async fetchInterval({ range }) {
      calls++;
      return {
        points: [
          { t: range.start, price: 100 },
          { t: range.end, price: 101 },
        ],
        searchedInterval: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const request = { evalTime: new Float64Array([0, 1_000, 2_000]), maxSampleGapMs: 1_000 };

  const empty = broker.read(request);
  assert(calls === 0, "read unexpectedly started a network request");
  assert(empty.value.every(Number.isNaN), "empty cache read returned data");

  const subscription = broker.subscribe(
    { range: Interval.create(0, 2_000), maxDeltaTMs: 1_000 },
    () => notifications++,
  );
  assert(Number(calls) === 1, "subscription did not ensure its requested range");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(notifications >= 1, "subscription was not notified when its read changed");
  const loaded = broker.read(request);
  approx(Math.exp(loaded.value[0]!), 100, 1e-10);

  subscription.update({ range: Interval.create(0, 2_000), maxDeltaTMs: 1_000 });
  assert(Number(calls) === 1, "unchanged viewport demand restarted fetching");
  broker.close();
});

test("broker render grid exposes irregular selected observation spacing", async () => {
  const adapter = createPollingSignalSource({
    now: () => 20_000,
    resolve: () => 1_000,
    async fetchInterval(plan) {
      return {
        samples: [
          { t: 0, value: Math.log(100) },
          { t: 10_000, value: Math.log(101) },
        ],
        searchedInterval: plan.range,
      };
    },
  });
  const broker = new Broker(adapter, { now: () => 20_000 });
  broker.subscribe({ range: Interval.create(0, 10_000), maxDeltaTMs: 5_000 }, () => undefined);
  await new Promise(resolve => setTimeout(resolve, 0));

  const result = broker.read({ evalTime: new Float64Array([0, 5_000, 10_000]) });
  const density = usedSampleDensity(result.sampleTime, 1, 2);
  assert(
    density[0] === 0 && density[1] === 1,
    "irregular gap was hidden by reconstructed or searched coverage",
  );
});

test("leaving now updates the adapter session instead of creating another subscription", () => {
  let liveDisposed = 0;
  let connected = 0;
  const adapter: SignalAdapter = {
    connect() {
      connected++;
      let hadLiveDemand = false;
      return {
        setDemands(demands) {
          const hasLiveDemand = demands.some(
            demand => demand.range.start <= 10_000 && demand.range.end >= 10_000,
          );
          if (hadLiveDemand && !hasLiveDemand) liveDisposed++;
          hadLiveDemand = hasLiveDemand;
        },
        clearCache: () => undefined,
      };
    },
  };
  const broker = new Broker(adapter, { now: () => 10_000 });
  const subscription = broker.subscribe(
    { range: Interval.create(0, 10_000), maxDeltaTMs: 1_000 },
    () => undefined,
  );
  subscription.update({ range: Interval.create(0, 5_000), maxDeltaTMs: 1_000 });
  assert(connected === 1, "broker opened more than one adapter session");
  assert(liveDisposed === 1, "adapter session did not observe the historical viewport");
});

test("aborting a broker subscription removes its adapter demand", () => {
  const brokerLifetime = new AbortController();
  const subscriptionLifetime = new AbortController();
  let latestDemands: readonly BrokerDemand[] = [];
  const adapter: SignalAdapter = {
    connect() {
      return {
        setDemands(demands) {
          latestDemands = demands;
        },
        clearCache: () => undefined,
      };
    },
  };
  const broker = new PriceBroker(adapter, { signal: brokerLifetime.signal });
  broker.subscribe(
    { range: Interval.create(0, 10_000), maxDeltaTMs: 1_000 },
    () => undefined,
    subscriptionLifetime.signal,
  );
  assert(latestDemands.length === 1, "subscription demand was not registered");
  subscriptionLifetime.abort();
  assert(Number(latestDemands.length) === 0, "aborted subscription demand remained registered");
  brokerLifetime.abort();
});

test("broker forwards adapter status without interpreting future time", () => {
  let sink: Parameters<SignalAdapter["connect"]>[0] | null = null;
  const adapter: SignalAdapter = {
    connect(nextSink) {
      sink = nextSink;
      return { setDemands: () => undefined, clearCache: () => undefined };
    },
  };
  const broker = new Broker(adapter);
  const evalTime = new Float64Array([50, 100, 150]);
  const initial = broker.read({ evalTime });
  assert(initial.requests.length === 0, "broker invented request status without adapter evidence");
  const initialRevision = initial.sampleRevision;
  const connectedSink = sink as unknown as Parameters<SignalAdapter["connect"]>[0];
  connectedSink.status([{ state: "pending", range: Interval.create(100, 150), resolutionMs: 10 }]);
  const pending = broker.read({ evalTime });
  assert(pending.sampleRevision === initialRevision, "status-only update invalidated samples");
  assert(
    pending.requests.some(
      segment =>
        segment.state === "pending" && segment.range.start === 100 && segment.range.end === 150,
    ),
    "broker did not forward the adapter's future status",
  );
  const delivery = {
    samples: [
      { t: 50, value: 1 },
      { t: 90, value: 2 },
    ],
    searchedInterval: Interval.create(50, 100),
    resolutionMs: 10,
  };
  connectedSink.next(delivery);
  const loadedRevision = broker.read({ evalTime }).sampleRevision;
  assert(loadedRevision === initialRevision + 1, "sample delivery did not advance revision");
  connectedSink.next(delivery);
  assert(
    broker.read({ evalTime }).sampleRevision === loadedRevision,
    "identical redelivery invalidated cached samples",
  );
  broker.close();
});

test("broker can select an observation beyond wall time when the adapter delivered it", () => {
  let sink: Parameters<SignalAdapter["connect"]>[0] | null = null;
  const adapter: SignalAdapter = {
    connect(nextSink) {
      sink = nextSink;
      return { setDemands: () => undefined, clearCache: () => undefined };
    },
  };
  const lifetime = new AbortController();
  const broker = new PriceBroker(adapter, { signal: lifetime.signal });
  const connectedSink = sink as unknown as Parameters<SignalAdapter["connect"]>[0];
  connectedSink.next({
    samples: [{ t: 150, value: 3 }],
    searchedInterval: Interval.create(100, 200),
    resolutionMs: 25,
  });

  const point = { t: Number.NaN, value: Number.NaN };
  assert(broker.readPointAtOrBefore(175, point), "delivered observation was not selectable");
  assertPoint(point, 150, 3, "broker applied an implicit evaluation horizon");
  const view = broker.read({ evalTime: new Float64Array([150, 174]) });
  assert(view.value[0] === 3 && view.value[1] === 3, "future-dated reconstruction was hidden");
  assert(view.sampleTime[0] === 150 && view.sampleTime[1] === 150, "observation identity was lost");
  lifetime.abort();
});

test("an empty signal segment store has no invalid cached range", () => {
  const store = new SignalSegmentStore();
  assert(store.timeInterval() === null, "empty store exposed a cached range");
});

test("finer signal segments replace coarse history and reject late coarse overwrites", () => {
  const store = new SignalSegmentStore();
  store.insertBatch([heldSegment(0, 20, 0, 1, 20)]);
  store.insertBatch([heldSegment(5, 15, 5, 10, 10), heldSegment(15, 25, 15, 11, 10)]);
  store.insertBatch([heldSegment(0, 20, 0, -1, 30)]);
  const sampled = store.sample(new Float64Array([2, 7, 15, 18, 24]));
  assert(sampled[0] === 1, "late coarse response overwrote leading history");
  assert(sampled[1] === 10, "fine history was not selected");
  assert(sampled[2] === 11, "new fine observation did not own its boundary");
  assert(sampled[3] === 11 && sampled[4] === 11, "fine final observation was not held");
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
  const returns = signalEdgesToDeltas(new Float64Array([10, 10, 11, NaN, 12, 12]));
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
    async fetchInterval({ range, maxDeltaTMs }) {
      const resolutionMs = maxDeltaTMs >= 5_000 ? 5_000 : 1_000;
      requests.push(resolutionMs);
      const points = [];
      for (let t = range.start - resolutionMs; t <= range.end; t += resolutionMs) {
        points.push({ t, price: 100 + t / 1_000_000 });
      }
      return { points, resolutionHintMs: resolutionMs, searchedInterval: range };
    },
  };
  const broker = new Broker(fetcher);
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(requests.includes(5_000), "coarse level was not fetched");
  assert(requests.includes(1_000), "fine level was suppressed by coarse coverage");
});

test("live adapter subscriptions fetch elapsed wall-clock time without UI reloads", async () => {
  let now = 10_000;
  const requests: Interval[] = [];
  const fetcher: Fetcher = {
    liveRetryDelayMs: 5,
    async fetchInterval({ range }) {
      requests.push(range);
      return { points: [], searchedInterval: range };
    },
  };
  const broker = new Broker(fetcher, { now: () => now });
  broker.query({ evalTime: new Float64Array([0, 10_000, 20_000]), maxSampleGapMs: 1_000 });
  assert(requests[0]!.end === 10_000, "future time leaked into the fetch range");
  await new Promise(resolve => setTimeout(resolve, 0));

  now = 12_000;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(requests.length >= 2, "adapter did not fetch elapsed wall-clock time");
  assert(
    requests[1]!.start <= 10_000 && requests[1]!.end >= 12_000,
    "expanded live request did not cover the elapsed gap",
  );
});

test("last-point expected lifetime suppresses moving-now micro-requests", async () => {
  let now = 7.5;
  const requests: Interval[] = [];
  const fetcher: Fetcher = {
    publicationGraceMs: 1,
    async fetchInterval({ range }) {
      requests.push(range);
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5, price: 11 },
        ],
        resolutionHintMs: 5,
        searchedInterval: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => now });
  const evalTime = new Float64Array([0, 5, 10, 15]);
  broker.query({ evalTime, maxSampleGapMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(count(requests) === 1, "initial live request was not issued");

  now = 8;
  broker.query({ evalTime, maxSampleGapMs: 5 });
  now = 9.999;
  broker.query({ evalTime, maxSampleGapMs: 5 });
  assert(count(requests) === 1, "wall-clock movement refetched the same candle");

  now = 11.001;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(count(requests) === 2, "crossing the publication grace did not refresh");
  assert(
    requests[1]!.start <= 10 && requests[1]!.end >= 11.001,
    "expanded live refresh did not cover the next sample boundary",
  );
});

test("a lagging live endpoint is polled on its refresh cadence, not every redraw", async () => {
  let now = 10_001;
  let notifications = 0;
  const requests: Interval[] = [];
  const fetcher: Fetcher = {
    liveRetryDelayMs: 5,
    async fetchInterval({ range }) {
      requests.push(range);
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
        ],
        resolutionHintMs: 5_000,
        searchedInterval: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => now });
  const evalTime = new Float64Array([0, 5_000, 10_000, 15_000]);
  broker.subscribe(
    { range: Interval.create(0, 15_000), maxDeltaTMs: 5_000 },
    () => notifications++,
  );
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 0));

  now = 10_003;
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  assert(count(requests) === 1, "redraw bypassed the live refresh lease");

  now = 10_007;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(notifications >= 2, "live refresh timer did not invalidate the subscriber");
  const polled = count(requests);
  assert(polled >= 2, "adapter did not poll the lagging live endpoint");
  now = 10_020;
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  assert(count(requests) === polled, "UI redraw started a live request");
  broker.close();
});

test("follow-now demand updates keep one live lease and do not feed notifications back", async () => {
  let now = 10_000;
  let calls = 0;
  let notifications = 0;
  const adapter = createPollingSignalSource({
    now: () => now,
    livePollDelayMs: 60_000,
    minFetchPoints: 8,
    resolve: () => 1_000,
    async fetchInterval(plan) {
      calls++;
      return { samples: [], searchedInterval: plan.range };
    },
  });
  const broker = new Broker(adapter, { now: () => now });
  const subscription = broker.subscribe(
    { range: Interval.create(2_000, 20_000), maxDeltaTMs: 1_000 },
    () => notifications++,
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(calls === 1, "initial live lease did not fetch");
  const settledNotifications = notifications;

  for (let frame = 0; frame < 500; frame++) {
    now += 1;
    subscription.update({
      range: Interval.create(2_000 + frame, now + 10_000),
      maxDeltaTMs: 1_000,
    });
  }

  assert(calls === 1, `follow updates multiplied live work to ${calls} requests`);
  assert(
    notifications === settledNotifications,
    `follow updates fed ${notifications - settledNotifications} status notifications back`,
  );
  const status = broker.read({ evalTime: new Float64Array([0, now]) });
  assert(status.requests.length === 0, "settled live lease was still presented as pending");
  broker.close();
});

test("a completed empty search leaves no selected observations", async () => {
  let calls = 0;
  const adapter = createPollingSignalSource({
    now: () => 10_000,
    resolve: () => 1_000,
    async fetchInterval(plan) {
      calls++;
      return { samples: [], searchedInterval: plan.range };
    },
  });
  const broker = new Broker(adapter, { now: () => 10_000 });
  const subscription = broker.subscribe(
    { range: Interval.create(0, 5_000), maxDeltaTMs: 5_000 },
    () => undefined,
  );
  await new Promise(resolve => setTimeout(resolve, 0));

  subscription.update({ range: Interval.create(0, 5_000), maxDeltaTMs: 1_500 });
  const view = broker.read({ evalTime: new Float64Array([0, 2_500, 5_000]) });
  assert(calls === 1, "native fine coverage was refetched for a nearby zoom level");
  assert(view.sampleTime.every(Number.isNaN), "empty search invented data availability");
  broker.close();
});

test("adapter expands tiny demands and broker caches the complete delivery", async () => {
  let calls = 0;
  let fetched: Interval | null = null;
  const adapter = createPollingSignalSource({
    now: () => 100_000,
    minFetchPoints: 8,
    resolve: () => 1_000,
    async fetchInterval(plan) {
      calls++;
      fetched = plan.range;
      return {
        samples: [
          { t: plan.range.start, value: Math.log(100) },
          { t: plan.range.end, value: Math.log(101) },
        ],
        searchedInterval: plan.range,
      };
    },
  });
  const broker = new Broker(adapter, { now: () => 100_000 });
  const subscription = broker.subscribe(
    { range: Interval.create(50_000, 50_001), maxDeltaTMs: 1_000 },
    () => undefined,
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  const expanded = fetched as Interval | null;
  assert(
    expanded !== null && expanded.end - expanded.start >= 8_000,
    "tiny demand was not expanded",
  );

  subscription.update({
    range: Interval.create(expanded.start + 1_000, expanded.end - 1_000),
    maxDeltaTMs: 1_000,
  });
  assert(calls === 1, "broker discarded useful data outside the original demand");
  broker.close();
});

test("a demand ending at wall now remains historical", () => {
  const states: string[] = [];
  let activityEnds: readonly number[] = [];
  const lifetime = new AbortController();
  const adapter = createPollingSignalSource({
    now: () => 10_000,
    resolve: () => 1_000,
    fetchInterval: () => new Promise<AdapterBatch>(() => undefined),
  });
  const session = adapter.connect(
    {
      next: () => undefined,
      status: activities => {
        states.splice(0, states.length, ...activities.map(activity => activity.state));
        activityEnds = activities.map(activity => activity.range.end);
      },
      error: () => undefined,
    },
    lifetime.signal,
  );

  session.setDemands([{ range: Interval.create(0, 10_000), maxDeltaTMs: 1_000 }]);
  assert(states.includes("pending"), "historical request was not reported as pending");
  assert(
    activityEnds.every(end => end <= 10_000),
    "half-open demand end invented future work",
  );
  lifetime.abort();
});

test("adapter presents future-only demand as pending", () => {
  const activities: AcquisitionActivity[] = [];
  const lifetime = new AbortController();
  const adapter = createPollingSignalSource({
    now: () => 10_000,
    resolve: () => 1_000,
    fetchInterval: () => Promise.resolve({ samples: [], searchedInterval: Interval.empty(0) }),
  });
  const session = adapter.connect(
    {
      next: () => undefined,
      status: next => activities.splice(0, activities.length, ...next),
      error: () => undefined,
    },
    lifetime.signal,
  );

  session.setDemands([{ range: Interval.create(15_000, 20_000), maxDeltaTMs: 1_000 }]);
  assert(
    activities.some(
      activity =>
        activity.state === "pending" &&
        activity.range.start === 15_000 &&
        activity.range.end === 20_000,
    ),
    "adapter did not translate future demand into pending status",
  );
  lifetime.abort();
});

test("adapter keeps a live lease warm for its configured grace period", async () => {
  let now = 10_000;
  let calls = 0;
  const lifetime = new AbortController();
  const adapter = createPollingSignalSource({
    now: () => now,
    liveRetentionMs: 20,
    livePollDelayMs: 5,
    minFetchPoints: 2,
    resolve: () => 1_000,
    async fetchInterval(plan) {
      calls++;
      return { samples: [], searchedInterval: plan.range };
    },
  });
  const session = adapter.connect(
    { next: () => undefined, status: () => undefined, error: () => undefined },
    lifetime.signal,
  );
  session.setDemands([{ range: Interval.create(8_000, 20_000), maxDeltaTMs: 1_000 }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  session.setDemands([]);
  now += 6;
  session.setDemands([]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(calls === 2, `live lease grace period produced ${calls} total fetches`);

  now += 21;
  session.setDemands([]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(calls === 2, "expired live lease kept polling");
  lifetime.abort();
});

test("points after the adapter's searched range are discarded with a warning", async () => {
  const warnings: string[] = [];
  const fetcher: Fetcher = {
    async fetchInterval({ range }) {
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
          { t: 10_000, price: 12 }, // outside this delivery's declared searched range
        ],
        searchedInterval: range,
      };
    },
  };
  const broker = new Broker(fetcher, {
    now: () => 7_500,
    onWarning: message => warnings.push(message),
  });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = broker.query({ evalTime, maxSampleGapMs: 5_000 });
  assert(Number.isNaN(result.sampleTime[2]!), "out-of-range observation entered the render grid");
  assert(Number.isNaN(result.value[2]!), "out-of-range value was rendered");
  const latest = { t: Number.NaN, value: Number.NaN };
  assert(broker.readPointAtOrBefore(10_000, latest), "latest cached observation was missing");
  assert(latest.t === 5_000, "range clipping selected the wrong timestamp");
  approx(Math.exp(latest.value), 11, 1e-12);
  assert(
    warnings.some(message => message.includes("10000")),
    "out-of-range API point was silent",
  );
});

test("wavelet density ignores cached observations not selected for rendering", () => {
  const store = new SignalSegmentStore();
  store.insertBatch([heldSegment(0, 100, 0, 1, 100)]);
  store.insertBatch([heldSegment(20, 40, 20, 2, 20), heldSegment(40, 60, 40, 3, 20)]);
  const evalTime = new Float64Array([0, 20, 40, 60, 80]);
  const sampleTime = new Float64Array(evalTime.length);
  store.sample(evalTime, undefined, sampleTime);
  const density = usedSampleDensity(sampleTime, 1, 4);
  assert(density[0] === 1 && density[1] === 1, "selected fine observations were missing");
  assert(density[2] === 0, "resumed older coarse evidence became a new observation");
  assert(density[3] === 0, "unused cached evidence leaked into density");
});

test("wavelet density exposes holds, gaps, and resumed observations", () => {
  const density = usedSampleDensity(new Float64Array([NaN, 0, 0, NaN, 4, 4]), 1, 5);
  assert(density[0] === 1, "first available observation was missing");
  assert(density[1] === 0, "held observation was counted twice");
  assert(density[2] === 0, "unavailable edge invented an observation");
  assert(density[3] === 1, "observation after a gap was missing");
  assert(density[4] === 0, "resumed hold was counted twice");
});

test("IntervalSet preserves many chronological fragments without full-list rebuilds", () => {
  const ranges = new IntervalSet();
  for (let index = 0; index < 20_000; index++) {
    ranges.add(Interval.create(index * 4, index * 4 + 1));
  }
  assert(ranges.intervals().length === 20_000, "disjoint ranges were merged or lost");
  assert(ranges.contains(40_000), "binary lookup missed an inserted range");
  assert(!ranges.contains(40_001), "half-open range included its right endpoint");
  assert(!ranges.contains(40_002), "binary lookup crossed a gap");
});

test("searched market closures do not create an intermediate-zoom fetch storm", async () => {
  let calls = 0;
  const fetcher: Fetcher = {
    fetchInterval({ range }) {
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
        searchedInterval: range,
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 11_000 });
  const evalTime = Float64Array.from({ length: 12 }, (_, index) => index * 1_000);
  broker.query({ evalTime, maxSampleGapMs: 1_001.25 });
  await new Promise(resolve => setTimeout(resolve, 0));

  const intermediate = broker.query({ evalTime, maxSampleGapMs: 5_432.1 });
  assert(calls === 1, `market closure triggered ${calls - 1} redundant request(s)`);
  const density = usedSampleDensity(intermediate.sampleTime, 1, 11);
  assert(
    density.slice(2, 9).every(value => value === 0),
    "market closure was hidden by reconstructed data",
  );
  broker.close();
});

test("broker trusts the returned searched range, not the requested range", async () => {
  const requests: Interval[] = [];
  const fetcher: Fetcher = {
    fetchInterval({ range }) {
      requests.push(range);
      if (requests.length > 1) return new Promise(() => undefined);
      return Promise.resolve({
        points: [
          { t: 5_000, price: 10 },
          { t: 6_000, price: 11 },
          { t: 7_000, price: 12 },
        ],
        resolutionHintMs: 60_000, // deliberately wrong: timestamps win
        searchedInterval: Interval.create(5_000, 7_000),
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 20_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(requests.length === 2, `bounded scheduler started ${requests.length} calls`);
  assert(
    requests[1]!.start <= 0 && requests[1]!.end >= 5_000,
    "unsearched prefix was marked covered",
  );
});

test("empty and coarse evidence never suppress a finer request", async () => {
  const requests: number[] = [];
  const fetcher: Fetcher = {
    fetchInterval({ range, maxDeltaTMs }) {
      requests.push(maxDeltaTMs);
      if (requests.length > 1) return new Promise(() => undefined);
      return Promise.resolve({
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
          { t: 10_000, price: 12 },
        ],
        resolutionHintMs: 1_000,
        searchedInterval: range,
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 0));

  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  assert(count(requests) === 1, "observed finer/equal data did not satisfy coarse query");
  broker.query({ evalTime, maxSampleGapMs: 500 });
  assert(count(requests) === 2 && requests[1] === 500, "finer request was suppressed");
});

test("finer pending work suppresses only coarser duplicate requests", () => {
  const requests: number[] = [];
  const fetcher: Fetcher = {
    fetchInterval({ maxDeltaTMs }) {
      requests.push(maxDeltaTMs);
      return new Promise(() => undefined);
    },
  };
  const broker = new Broker(fetcher, { now: () => 10_000 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  const first = broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(
    first.requests.some(segment => segment.state === "pending"),
    "active request was not exposed as pending",
  );
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  assert(count(requests) === 1, "fine pending request did not suppress coarse duplicate");
  broker.query({ evalTime, maxSampleGapMs: 500 });
  assert(count(requests) === 2, "coarse pending request suppressed a finer request");
});

test("serialized acquisition exposes demanded work waiting behind the active request", () => {
  let latest: readonly string[] = [];
  const lifetime = new AbortController();
  const adapter = createPollingSignalSource({
    now: () => 10_000,
    minFetchPoints: 1,
    resolve: demand => demand.maxDeltaTMs,
    fetchInterval: () => new Promise<AdapterBatch>(() => undefined),
  });
  const session = adapter.connect(
    {
      next: () => undefined,
      status: activities => {
        latest = activities.map(activity => activity.state);
      },
      error: () => undefined,
    },
    lifetime.signal,
  );
  session.setDemands([
    { range: Interval.create(0, 1_000), maxDeltaTMs: 1_000 },
    { range: Interval.create(5_000, 6_000), maxDeltaTMs: 1_000 },
  ]);
  assert(latest.length >= 2, "active or queued demand was hidden");
  assert(
    latest.every(state => state === "pending"),
    "broker-visible pending states diverged",
  );
  lifetime.abort();
});

test("moving demand aborts stale serialized work before starting the latest range", async () => {
  let calls = 0;
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let aborted = 0;
  let finish!: (result: FetchIntervalResult) => void;
  const fetcher: Fetcher = {
    fetchInterval({ signal }) {
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
        finish = result => {
          signal.removeEventListener("abort", abort);
          activeCalls--;
          resolve(result);
        };
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 3_000 });
  broker.query({ evalTime: new Float64Array([0, 1_000]), maxSampleGapMs: 1_000 });
  broker.query({ evalTime: new Float64Array([2_000, 3_000]), maxSampleGapMs: 1_000 });
  assert(calls === 2, "latest viewport did not replace stale serialized work");
  assert(aborted === 1 && maxActiveCalls === 1, "stale and current requests overlapped");
  finish({ points: [], searchedInterval: Interval.create(2_000, 3_000) });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.close();
});

test("source-wide backoff suppresses new moving-tail ranges", async () => {
  let calls = 0;
  const fetcher: Fetcher = {
    sourceWideBackoff: true,
    retryDelayMs: () => 1_000,
    async fetchInterval() {
      calls++;
      throw new Error("rate limited");
    },
  };
  const broker = new Broker(fetcher, { now: () => 3_000, onError: () => undefined });
  broker.query({ evalTime: new Float64Array([0, 1_000]), maxSampleGapMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.query({ evalTime: new Float64Array([2_000, 3_000]), maxSampleGapMs: 1_000 });
  assert(calls === 1, "a disjoint moving-tail range bypassed source-wide backoff");
  broker.close();
});

test("subscriber failures are not reclassified as fetch failures", async () => {
  const errors: string[] = [];
  const fetcher: Fetcher = {
    async fetchInterval({ range }) {
      return { points: [{ t: 500, price: 100 }], resolutionHintMs: 1_000, searchedInterval: range };
    },
  };
  const broker = new Broker(fetcher, {
    now: () => 1_000,
    onError: message => errors.push(message),
  });
  const query = { evalTime: new Float64Array([0, 1_000]), maxSampleGapMs: 1_000 };
  broker.subscribe({ range: Interval.create(0, 1_000), maxDeltaTMs: 1_000 }, () => {
    throw new Error("UI failed");
  });
  broker.query(query);
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = broker.query(query);
  assert(
    result.requests.every(segment => segment.state !== "retrying"),
    "subscriber exception became a failed exchange range",
  );
  assert(errors.includes("[Broker] subscriber failed"), "subscriber exception was hidden");
  assert(!errors.some(message => message.includes("fetch failed")), "fetch was blamed for UI");
  const cached = broker.cachedInterval();
  assert(
    cached !== null && cached.start === 500 && cached.end === 1_500,
    "singleton hold range was lost",
  );
  broker.close();
});

test("a late coarse response cannot overwrite an earlier fine response", async () => {
  let resolveCoarse!: (result: FetchIntervalResult) => void;
  let resolveFine!: (result: FetchIntervalResult) => void;
  const fetcher: Fetcher = {
    fetchInterval({ maxDeltaTMs }) {
      return new Promise(resolve => {
        if (maxDeltaTMs === 5_000) resolveCoarse = resolve;
        else resolveFine = resolve;
      });
    },
  };
  const broker = new Broker(fetcher, { now: () => 5_000 });
  const evalTime = new Float64Array([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
  broker.query({ evalTime, maxSampleGapMs: 5_000 });
  broker.query({ evalTime, maxSampleGapMs: 1_000 });

  resolveFine({
    points: [
      { t: 0, price: 100 },
      { t: 1_000, price: 101 },
      { t: 2_000, price: 102 },
      { t: 3_000, price: 103 },
      { t: 4_000, price: 104 },
      { t: 5_000, price: 105 },
    ],
    searchedInterval: Interval.create(0, 5_000),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  resolveCoarse({
    points: [
      { t: 0, price: 10 },
      { t: 5_000, price: 15 },
    ],
    searchedInterval: Interval.create(0, 5_000),
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  const result = broker.query({ evalTime, maxSampleGapMs: 1_000 });
  approx(Math.exp(result.value[1]!), 101, 1e-10);
});

test("clearing the price cache ignores stale in-flight responses", async () => {
  const resolvers: ((result: FetchIntervalResult) => void)[] = [];
  const fetcher: Fetcher = {
    fetchInterval() {
      return new Promise(resolve => resolvers.push(resolve));
    },
  };
  const broker = new Broker(fetcher, { now: () => 1_000 });
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  broker.clearCache();
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(resolvers.length === 2, "reload did not start a fresh request generation");

  resolvers[0]!({
    points: [
      { t: 0, price: 10 },
      { t: 1_000, price: 11 },
    ],
    searchedInterval: Interval.create(0, 1_000),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const beforeFresh = broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(beforeFresh.value.every(Number.isNaN), "stale response repopulated the cleared cache");

  resolvers[1]!({
    points: [
      { t: 0, price: 100 },
      { t: 1_000, price: 101 },
    ],
    searchedInterval: Interval.create(0, 1_000),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const fresh = broker.query({ evalTime, maxSampleGapMs: 1_000 });
  approx(Math.exp(fresh.value[0]!), 100, 1e-10);
});

test("clearing the event cache cancels stale walks and ignores their callbacks", async () => {
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
    readonly signal: AbortSignal;
  }[] = [];
  const lifetime = new AbortController();
  const broker = new EventBroker(
    {},
    () => [feed],
    lifetime.signal,
    () => ({
      failureReason: null,
      walk(_targetMin, onEvents, signal) {
        return new Promise(resolve => runs.push({ emit: onEvents, resolve, signal }));
      },
    }),
    { onDebug: () => undefined },
  );
  const range = Interval.create(0, 1_000);
  broker.query(range);
  broker.clearCache();
  assert(runs[0]!.signal.aborted, "event reload left the stale walk running");
  broker.query(range);
  assert(runs.length === 2, "event reload did not start a fresh walker generation");

  runs[0]!.emit([{ t: 400, title: "stale", link: "old", summary: "", feedId: feed.id }]);
  runs[0]!.resolve("exhausted");
  await new Promise(resolve => setTimeout(resolve, 0));
  runs[1]!.emit([{ t: 500, title: "fresh", link: "new", summary: "", feedId: feed.id }]);
  runs[1]!.resolve("exhausted");
  await new Promise(resolve => setTimeout(resolve, 0));

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
    const demand = { range: Interval.create(0, 7_200_000), maxDeltaTMs: 3_600_000 };
    const result = await fetchOnce(adapter, demand);
    const url = new URL(requestedUrl);
    assert(url.searchParams.get("symbol") === "ETHUSDT", "symbol was not normalized");
    assert(url.searchParams.get("interval") === "1h", "wrong Binance interval");
    assert(result.samples.length === 2, "Binance rows were not converted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Nobitex empty fine history falls back without inventing no-data evidence", async () => {
  const originalFetch = globalThis.fetch;
  const requestedResolutions: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const resolution = url.searchParams.get("resolution") ?? "";
    requestedResolutions.push(resolution);
    const payload =
      resolution === "1"
        ? { s: "no_data", t: [], o: [], h: [], l: [], c: [], v: [] }
        : {
          s: "ok",
          t: [0, 300],
          o: [100, 101],
          h: [100, 101],
          l: [100, 101],
          c: [100, 101],
          v: [1, 1],
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await fetchOnce(createNobitexAdapter({ symbol: "USDTIRT" }), {
      range: Interval.create(0, 600_000),
      maxDeltaTMs: 60_000,
    });
    assert(
      requestedResolutions[0] === "1" && requestedResolutions[1] === "5",
      "Nobitex did not probe the next retained resolution",
    );
    assert(result.samples.length === 2, "coarser retained candles were discarded");
    assert(result.resolutionMs === 300_000, "fallback samples were mislabeled as fine data");
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
          result: [{ timestamp: [0, 3_600], indicators: { quote: [{ open: [75.5, 76.25] }] } }],
          error: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const adapter = createYahooAdapter({ symbol: "bz=f", now: () => 7_200_000 });
    const demand = { range: Interval.create(0, 7_200_000), maxDeltaTMs: 3_600_000 };
    const result = await fetchOnce(adapter, demand);
    const target = new URL(requestedUrl).searchParams.get("url") ?? "";
    assert(target.includes("/BZ%3DF?"), "Brent symbol was not encoded in Yahoo request");
    assert(target.includes("interval=60m"), "wrong Yahoo interval");
    assert(result.samples.length === 2 && result.samples[1]!.t === 3_600_000, "bad Yahoo rows");

    const secondInterval = Interval.create(1_000, 7_200_000);
    const cached = await fetchOnce(adapter, { range: secondInterval, maxDeltaTMs: 3_600_000 });
    assert(calls === 1, "same Yahoo candle window caused another HTTP request");
    assert(
      cached.searchedInterval.start <= secondInterval.start &&
      cached.searchedInterval.end >= secondInterval.end,
      "cached expanded response did not cover the requested range",
    );

    const cacheLifetime = new AbortController();
    const cacheSession = adapter.connect(
      { next: () => undefined, status: () => undefined, error: () => undefined },
      cacheLifetime.signal,
    );
    cacheSession.clearCache();
    cacheLifetime.abort();
    await fetchOnce(adapter, { range: secondInterval, maxDeltaTMs: 3_600_000 });
    assert(Number(calls) === 2, "explicit reload did not clear Yahoo's response cache");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert(
    chooseYahooInterval(60_000, 0, 9 * 86_400_000)?.interval === "2m",
    "Yahoo lookback limit did not select the finest available fallback",
  );
  assert(priceSignalSource("yahoo")?.normalizeSymbol(" cl=f ") === "CL=F", "WTI was rejected");
});

test("Yahoo honors Retry-After on HTTP 429", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("rate limited", { status: 429, headers: { "retry-after": "7" } })) as typeof fetch;
  try {
    const adapter = createYahooAdapter({ symbol: "CL=F", now: () => 120_000 });
    const retry = await retryOnce(adapter, {
      range: Interval.create(60_000, 120_000),
      maxDeltaTMs: 60_000,
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
    async fetchInterval() {
      calls++;
      throw new Error("upstream unavailable");
    },
  };
  const broker = new Broker(fetcher, { onError: () => undefined });
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = broker.query({ evalTime, maxSampleGapMs: 1_000 });
  const retrying = result.requests.find(segment => segment.state === "retrying");
  assert(retrying !== undefined, "failed request was still presented as pending");
  assert(retrying.message === "upstream unavailable", "failure detail was lost");
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(Number(calls) === 1, "failure backoff did not suppress a retry");
  await new Promise(resolve => setTimeout(resolve, 120));
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(Number(calls) === 2, "request did not retry after adapter backoff elapsed");
  broker.close();
});

test("an unexpected AbortError fails visibly instead of deadlocking acquisition", async () => {
  let calls = 0;
  const errors: string[] = [];
  const fetcher: Fetcher = {
    retryDelayMs: () => 100,
    async fetchInterval() {
      calls++;
      throw new DOMException("upstream aborted", "AbortError");
    },
  };
  const broker = new Broker(fetcher, {
    onError: (_message, error) => errors.push(String((error as Error).message)),
  });
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime, maxSampleGapMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = broker.query({ evalTime, maxSampleGapMs: 1_000 });
  assert(
    result.requests.some(segment => segment.state === "retrying"),
    "current AbortError remained silently stuck as fetching",
  );
  assert(errors.includes("upstream aborted"), "current AbortError was not surfaced");
  assert(calls === 1, "current AbortError bypassed retry backoff");
  broker.close();
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
    for (const broker of [...brokers]) broker.close();
  }
}
if (failures > 0) throw new Error(`${failures} test(s) failed`);
