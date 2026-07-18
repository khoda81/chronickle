import type { NewsEvent, RssFeed } from "../src/domain.ts";
import { EventBroker } from "../src/data/events/broker.ts";
import { Broker as PriceBroker } from "../src/data/signal/broker.ts";
import type { BrokerOptions, Subscription, SignalView } from "../src/data/signal/broker.ts";
import { createBinanceAdapter } from "../src/data/signal/market/adapters/binanceFetcher.ts";
import { createNobitexAdapter } from "../src/data/signal/market/adapters/nobitexFetcher.ts";
import {
  chooseYahooInterval,
  createYahooAdapter,
} from "../src/data/signal/market/adapters/yahoo.ts";
import { logPriceSamples } from "../src/data/signal/market/price.ts";
import {
  createPollingSignalSource,
  demandSampleSpacingMs,
  type AdapterBatch,
  type SignalAdapter,
  type SignalDemand,
} from "../src/data/signal/fetcher.ts";
import { priceSignalSource } from "../src/data/signal/market/market.ts";
import { filterMarketSymbols, parseNobitexMarketKey } from "../src/data/signal/market/symbols.ts";
import { NumericSeriesStore } from "../src/data/signal/store.ts";
import { signalReportFrontier } from "../src/data/signal/reports.ts";
import type { Sample } from "../src/data/signal/sample.ts";
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
import type { Frame } from "../src/engine/gfx/context.ts";
import { SignalRows } from "../src/engine/gfx/signalRow.ts";
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

interface QueryRequest {
  readonly evalTime: Float64Array;
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

  override subscribe(fn: () => void, signal: AbortSignal = this.lifetime.signal): Subscription {
    return super.subscribe(fn, signal);
  }

  query(opts: QueryRequest): SignalView {
    this.compatibilitySubscription ??= this.subscribe(() => undefined);
    return this.compatibilitySubscription.read(opts.evalTime);
  }

  read(opts: { readonly evalTime: Float64Array }): SignalView {
    return this.query(opts);
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
    resolve: demandSampleSpacingMs,
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

function fetchOnce(adapter: SignalAdapter, nextDemand: SignalDemand): Promise<readonly Sample[]> {
  return new Promise((resolve, reject) => {
    const lifetime = new AbortController();
    const session = adapter.connect(
      {
        next: samples => {
          lifetime.abort();
          resolve(samples);
        },
        setReports: () => undefined,
        error: error => {
          lifetime.abort();
          reject(error);
        },
      },
      lifetime.signal,
    );
    session.setDemands([nextDemand]);
  });
}

function failOnce(adapter: SignalAdapter, nextDemand: SignalDemand): Promise<unknown> {
  return new Promise(resolve => {
    const lifetime = new AbortController();
    const session = adapter.connect(
      {
        next: () => undefined,
        setReports: () => undefined,
        error: error => {
          lifetime.abort();
          resolve(error);
        },
      },
      lifetime.signal,
    );
    session.setDemands([nextDemand]);
  });
}

function demand(range: Interval, sampleSpacingMs: number): SignalDemand {
  return { range, sampleCount: Math.max(2, Math.ceil(Interval.span(range) / sampleSpacingMs) + 1) };
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
      resizeBoundary() {},
      pinchTime() {},
      wheel() {},
      hoverMoved() {},
      pointerLeft() {},
      tap() {
        taps++;
      },
      doubleTap() {},
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
    assert(panRow === 4 && panY === -10, "vertical drag was not normalized to canvas pixels");
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
      gestureStarted() {},
      gestureEnded(_input, _cancelled, finished) {
        finishedStates.push(finished);
      },
      panTimeByPixels() {},
      panRow(nextRow, deltaY) {
        row = nextRow ?? Number.NaN;
        verticalDelta = deltaY;
      },
      resizeBoundary() {},
      pinchTime(_viewportWidth, previousCenter, currentCenter, previousSpan, currentSpan) {
        previousCenterX = previousCenter;
        currentCenterX = currentCenter;
        previousDistance = previousSpan;
        currentDistance = currentSpan;
      },
      wheel() {},
      hoverMoved() {},
      pointerLeft() {},
      tap() {},
      doubleTap() {},
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
    assert(row === 6 && verticalDelta === -10, "pinch vertical pan used the wrong row or scale");
    assert(move.defaultPrevented, "touch move default action was not prevented");

    windowTarget.dispatchEvent(
      syntheticInput("pointerup", { clientX: 30, clientY: 30, pointerId: 1, pointerType: "touch" }),
    );
    assert(controller.active, "ending one pinch pointer ended the complete gesture");
    windowTarget.dispatchEvent(
      syntheticInput("pointermove", {
        clientX: 90,
        clientY: 45,
        pointerId: 2,
        pointerType: "touch",
      }),
    );
    assert(verticalDelta === -10, "touch drag did not preserve the vertical pan convention");
    windowTarget.dispatchEvent(
      syntheticInput("pointerup", { clientX: 90, clientY: 45, pointerId: 2, pointerType: "touch" }),
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
      gestureStarted() {},
      gestureEnded() {},
      panTimeByPixels() {},
      panRow() {},
      resizeBoundary() {},
      pinchTime() {},
      wheel(point, deltaX, deltaY, shiftKey) {
        pointX = point.x;
        pointY = point.y;
        wheelX = deltaX;
        wheelY = deltaY;
        shifted = shiftKey;
      },
      hoverMoved() {},
      pointerLeft() {},
      tap() {},
      doubleTap() {},
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
  assert(row.heatmapTop === 100, "bottom status strip shifted the heatmap top");
  assert(row.heatmapHeight === 114 && row.tooltipPosition === 215, "bad heatmap geometry");
  assert(row.drawable, "normal row was not drawable");
  assert(signalRowContainsHeatmap(100, 130, 100), "heatmap top was excluded from hit testing");
  assert(signalRowContainsHeatmap(100, 130, 213), "heatmap bottom pixel was excluded");
  assert(!signalRowContainsHeatmap(100, 130, 214), "status strip entered heatmap hit testing");
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

test("signal row stack advances row geometry without caller-owned y state", () => {
  const rows = SignalRows.stack({} as Frame, 100);
  const first = rows.next("first", 40);
  const second = rows.next("second", 70);
  assert(first.top === 100 && first.height === 40, "first stacked row was misplaced");
  assert(second.top === 140 && second.height === 70, "row stack did not advance by row height");
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

test("numeric series store performs batched predecessor reads", () => {
  const evalTime = new Float64Array([0, 10, 15, 20]);
  const store = new NumericSeriesStore();
  const emptyTime = new Float64Array(evalTime.length);
  const empty = store.findBatchAtOrBefore(evalTime, undefined, emptyTime);
  assert(empty.every(Number.isNaN), "empty store did not return NaN");
  assert(
    emptyTime.every(time => time === Number.NEGATIVE_INFINITY),
    "empty store did not return the missing-time sentinel",
  );

  store.upsertBatch([
    { t: 5, value: 1 },
    { t: 15, value: 2 },
  ]);
  const sampleTime = new Float64Array(evalTime.length);
  const sampled = store.findBatchAtOrBefore(evalTime, undefined, sampleTime);
  assert(Number.isNaN(sampled[0]!), "value before first observation was defined");
  assert(sampled[1] === 1 && sampled[2] === 2 && sampled[3] === 2, "ZOH evaluation is incorrect");
  assert(sampleTime[0] === Number.NEGATIVE_INFINITY, "missing value received a finite timestamp");
  assert(
    sampleTime[1] === 5 && sampleTime[2] === 15 && sampleTime[3] === 15,
    "sample grid lost selected observation identity",
  );

  const selected = { t: Number.NaN, value: Number.NaN };
  assert(!store.findAtOrBefore(4, selected), "predecessor lookup invented a leading value");
  assert(store.findAtOrBefore(10, selected), "predecessor lookup missed an interior value");
  assertPoint(selected, 5, 1, "interior point lost its observation");
  assert(store.findAtOrBefore(15, selected), "predecessor lookup missed a boundary value");
  assertPoint(selected, 15, 2, "boundary point selected the prior segment");
  assert(store.findAtOrBefore(30, selected), "held point lookup failed");
  assertPoint(selected, 15, 2, "held value lost its observation timestamp");
});

test("numeric series store uses last write for duplicate timestamps", () => {
  const store = new NumericSeriesStore();
  assert(
    store.upsertBatch([
      { t: 0, value: 1 },
      { t: 10, value: 2 },
      { t: 10, value: 3 },
      { t: 20, value: 4 },
    ]),
    "initial batch did not change the store",
  );
  assert(store.size === 3, "duplicate timestamp created another entry");
  assert(!store.upsertBatch([{ t: 10, value: 3 }]), "identical upsert changed the store");
  assert(store.upsertBatch([{ t: 10, value: 5 }]), "replacement upsert was ignored");

  const selected = { t: Number.NaN, value: Number.NaN };
  assert(store.findAtOrBefore(10, selected), "exact replacement was not found");
  assertPoint(selected, 10, 5, "last write did not win");
});

test("numeric series store remains ordered across many leaves and middle writes", () => {
  const store = new NumericSeriesStore();
  const samples = Array.from({ length: 4_096 }, (_, index) => ({ t: index * 2, value: index }));
  store.upsertBatch(samples);
  store.upsertBatch([
    { t: 1_999, value: -1 },
    { t: 2_001, value: -2 },
  ]);

  const evalTime = new Float64Array([-1, 0, 1, 1_998, 1_999, 2_000, 2_001, 8_500]);
  const sampleTime = new Float64Array(evalTime.length);
  const value = store.findBatchAtOrBefore(evalTime, undefined, sampleTime);
  assert(
    sampleTime[0] === Number.NEGATIVE_INFINITY && Number.isNaN(value[0]!),
    "leading miss did not use the sentinel pair",
  );
  assert(
    sampleTime[3] === 1_998 &&
      sampleTime[4] === 1_999 &&
      sampleTime[5] === 2_000 &&
      sampleTime[6] === 2_001,
    "middle insertion broke predecessor order",
  );
  assert(value[4] === -1 && value[6] === -2 && value[7] === 4_095, "values were misplaced");
});

test("numeric series store matches a map oracle across mixed batch writes", () => {
  const store = new NumericSeriesStore();
  const oracle = new Map<number, number>();
  let randomState = 0x9e3779b9;
  const random = (): number => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState;
  };

  for (let batchIndex = 0; batchIndex < 200; batchIndex++) {
    const batch = Array.from({ length: 100 }, () => ({
      t: random() % 20_000,
      value: random(),
    })).sort((left, right) => left.t - right.t);
    store.upsertBatch(batch);
    for (const sample of batch) oracle.set(sample.t, sample.value);
  }

  const expected = [...oracle].sort((left, right) => left[0] - right[0]);
  const query = Float64Array.from({ length: 20_002 }, (_, index) => index - 1);
  const sampleTime = new Float64Array(query.length);
  const value = store.findBatchAtOrBefore(query, undefined, sampleTime);
  let expectedIndex = -1;
  for (let index = 0; index < query.length; index++) {
    while (
      expectedIndex + 1 < expected.length &&
      expected[expectedIndex + 1]![0] <= query[index]!
    ) {
      expectedIndex++;
    }
    const entry = expected[expectedIndex];
    assert(
      sampleTime[index] === (entry?.[0] ?? Number.NEGATIVE_INFINITY) &&
        (entry === undefined ? Number.isNaN(value[index]!) : value[index] === entry[1]),
      `map oracle diverged at query ${query[index]}`,
    );
  }
});

test("broker query forwards grid demand and serves the cache synchronously", async () => {
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
  const request = { evalTime: new Float64Array([0, 1_000, 2_000]) };

  const subscription = broker.subscribe(() => notifications++);
  const empty = subscription.read(request.evalTime);
  assert(calls === 1, "query grid did not reach the adapter");
  assert(empty.value.every(Number.isNaN), "empty cache read returned data");

  await new Promise(resolve => setTimeout(resolve, 0));
  assert(notifications >= 1, "subscription was not notified when its read changed");
  const loaded = subscription.read(request.evalTime);
  approx(Math.exp(loaded.value[0]!), 100, 1e-10);

  subscription.read(request.evalTime);
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
  const query = broker.subscribe(() => undefined);
  query.read(new Float64Array([0, 5_000, 10_000]));
  await new Promise(resolve => setTimeout(resolve, 0));

  const result = query.read(new Float64Array([0, 5_000, 10_000]));
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
  const subscription = broker.subscribe(() => undefined);
  subscription.read(new Float64Array([0, 5_000, 10_000]));
  subscription.read(new Float64Array([0, 2_500, 5_000]));
  assert(connected === 1, "broker opened more than one adapter session");
  assert(liveDisposed === 1, "adapter session did not observe the historical viewport");
});

test("aborting a broker subscription removes its adapter demand", () => {
  const brokerLifetime = new AbortController();
  const subscriptionLifetime = new AbortController();
  let latestDemands: readonly SignalDemand[] = [];
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
  const subscription = broker.subscribe(() => undefined, subscriptionLifetime.signal);
  subscription.read(new Float64Array([0, 5_000, 10_000]));
  assert(latestDemands.length === 1, "subscription demand was not registered");
  subscriptionLifetime.abort();
  assert(Number(latestDemands.length) === 0, "aborted subscription demand remained registered");
  brokerLifetime.abort();
});

test("broker invalidates only when delivered samples change the cache", () => {
  let sink: Parameters<SignalAdapter["connect"]>[0] | null = null;
  const adapter: SignalAdapter = {
    connect(nextSink) {
      sink = nextSink;
      return { setDemands: () => undefined, clearCache: () => undefined };
    },
  };
  const broker = new Broker(adapter);
  const evalTime = new Float64Array([50, 100, 150]);
  let notifications = 0;
  const query = broker.subscribe(() => notifications++);
  const initial = query.read(evalTime);
  const initialRevision = initial.sampleRevision;
  const connectedSink = sink as unknown as Parameters<SignalAdapter["connect"]>[0];
  const samples = [
    { t: 50, value: 1 },
    { t: 90, value: 2 },
  ];
  connectedSink.next(samples);
  const loadedRevision = query.read(evalTime).sampleRevision;
  assert(loadedRevision === initialRevision + 1, "sample delivery did not advance revision");
  assert(notifications === 1, "changed samples did not invalidate the query");
  connectedSink.next(samples);
  assert(
    query.read(evalTime).sampleRevision === loadedRevision && notifications === 1,
    "identical redelivery invalidated cached samples",
  );
  broker.close();
});

test("adapter reports invalidate views without changing sample revision", () => {
  let sink: Parameters<SignalAdapter["connect"]>[0] | null = null;
  const adapter: SignalAdapter = {
    connect(nextSink) {
      sink = nextSink;
      return { setDemands: () => undefined, clearCache: () => undefined };
    },
  };
  const broker = new Broker(adapter);
  let notifications = 0;
  const query = broker.subscribe(() => notifications++);
  const initial = query.read(new Float64Array([0, 100]));
  const connectedSink = sink as unknown as Parameters<SignalAdapter["connect"]>[0];
  const reports = [
    { range: Interval.create(20, 80), kind: "warn" as const, message: "Source is sparse" },
  ];

  connectedSink.setReports(reports);
  const reported = query.read(new Float64Array([0, 100]));
  assert(notifications === 1, "new adapter report did not invalidate the view");
  assert(reported.reports[0] === reports[0], "adapter report was not exposed unchanged");
  assert(reported.sampleRevision === initial.sampleRevision, "report changed sample revision");

  connectedSink.setReports(reports);
  assert(notifications === 1, "identical report snapshot caused another redraw");
  broker.close();
});

test("overlapping adapter reports form a severity-ordered frontier", () => {
  const frontier = signalReportFrontier(
    [
      { range: Interval.create(0, 10), kind: "info", message: "info" },
      { range: Interval.create(2, 8), kind: "warn", message: "warn" },
      { range: Interval.create(4, 6), kind: "error", message: "error" },
      { range: Interval.create(7, 9), kind: "warn", message: "new warn" },
    ],
    Interval.create(0, 10),
  );
  const actual = frontier.map(fragment => [
    fragment.range.start,
    fragment.range.end,
    fragment.report.message,
  ]);
  assert(
    JSON.stringify(actual) ===
      JSON.stringify([
        [0, 2, "info"],
        [2, 4, "warn"],
        [4, 6, "error"],
        [6, 7, "warn"],
        [7, 9, "new warn"],
        [9, 10, "info"],
      ]),
    `unexpected report frontier ${JSON.stringify(actual)}`,
  );
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
  connectedSink.next([{ t: 150, value: 3 }]);

  const point = { t: Number.NaN, value: Number.NaN };
  assert(broker.readPointAtOrBefore(175, point), "delivered observation was not selectable");
  assertPoint(point, 150, 3, "broker applied an implicit evaluation horizon");
  const view = broker
    .subscribe(() => undefined, lifetime.signal)
    .read(new Float64Array([150, 174]));
  assert(view.value[0] === 3 && view.value[1] === 3, "future-dated reconstruction was hidden");
  assert(view.sampleTime[0] === 150 && view.sampleTime[1] === 150, "observation identity was lost");
  lifetime.abort();
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
  broker.query({ evalTime: new Float64Array([0, 5_000, 10_000]) });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.query({ evalTime: Float64Array.from({ length: 11 }, (_, index) => index * 1_000) });
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
  broker.query({ evalTime: Float64Array.from({ length: 21 }, (_, index) => index * 1_000) });
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
  broker.query({ evalTime });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(count(requests) === 1, "initial live request was not issued");

  now = 8;
  broker.query({ evalTime });
  now = 9.999;
  broker.query({ evalTime });
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
  const subscription = broker.subscribe(() => notifications++);
  subscription.read(evalTime);
  await new Promise(resolve => setTimeout(resolve, 0));

  now = 10_003;
  subscription.read(evalTime);
  assert(count(requests) === 1, "redraw bypassed the live refresh lease");

  now = 10_007;
  await new Promise(resolve => setTimeout(resolve, 10));
  const polled = count(requests);
  assert(polled >= 2, "adapter did not poll the lagging live endpoint");
  assert(notifications >= 2, "live adapter reports did not redraw the status frontier");
  now = 10_020;
  subscription.read(evalTime);
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
  const subscription = broker.subscribe(() => notifications++);
  subscription.read(new Float64Array([2_000, 20_000]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(calls === 1, "initial live lease did not fetch");
  const settledNotifications = notifications;

  for (let frame = 0; frame < 500; frame++) {
    now += 1;
    subscription.read(new Float64Array([2_000 + frame, now + 10_000]));
  }

  assert(calls === 1, `follow updates multiplied live work to ${calls} requests`);
  assert(
    notifications === settledNotifications,
    `follow updates fed ${notifications - settledNotifications} status notifications back`,
  );
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
  const subscription = broker.subscribe(() => undefined);
  subscription.read(new Float64Array([0, 5_000]));
  await new Promise(resolve => setTimeout(resolve, 0));

  const view = subscription.read(new Float64Array([0, 2_500, 5_000]));
  assert(calls === 1, "native fine coverage was refetched for a nearby zoom level");
  assert(
    view.sampleTime.every(time => time === Number.NEGATIVE_INFINITY),
    "empty search invented data availability",
  );
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
  const subscription = broker.subscribe(() => undefined);
  subscription.read(new Float64Array([50_000, 50_001]));
  await new Promise(resolve => setTimeout(resolve, 0));
  const expanded = fetched as Interval | null;
  assert(
    expanded !== null && expanded.end - expanded.start >= 8_000,
    "tiny demand was not expanded",
  );

  subscription.read(new Float64Array([expanded.start + 1_000, expanded.end - 1_000]));
  assert(calls === 1, "broker discarded useful data outside the original demand");
  broker.close();
});

test("a demand ending at wall now remains historical", () => {
  let requested: Interval | null = null;
  const lifetime = new AbortController();
  const adapter = createPollingSignalSource({
    now: () => 10_000,
    resolve: () => 1_000,
    fetchInterval: plan => {
      requested = plan.range;
      return new Promise<AdapterBatch>(() => undefined);
    },
  });
  const session = adapter.connect(
    { next: () => undefined, setReports: () => undefined, error: () => undefined },
    lifetime.signal,
  );

  session.setDemands([demand(Interval.create(0, 10_000), 1_000)]);
  const requestedRange = requested as Interval | null;
  assert(
    requestedRange !== null && requestedRange.end <= 10_000,
    "half-open demand end invented future work",
  );
  lifetime.abort();
});

test("adapter defers future-only demand until it becomes actionable", () => {
  let calls = 0;
  const lifetime = new AbortController();
  const adapter = createPollingSignalSource({
    now: () => 10_000,
    resolve: () => 1_000,
    fetchInterval: () => {
      calls++;
      return Promise.resolve({ samples: [], searchedInterval: Interval.empty(0) });
    },
  });
  const session = adapter.connect(
    { next: () => undefined, setReports: () => undefined, error: () => undefined },
    lifetime.signal,
  );

  session.setDemands([demand(Interval.create(15_000, 20_000), 1_000)]);
  assert(calls === 0, "future demand started a source request early");
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
    { next: () => undefined, setReports: () => undefined, error: () => undefined },
    lifetime.signal,
  );
  session.setDemands([demand(Interval.create(8_000, 20_000), 1_000)]);
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

test("broker caches every valid sample emitted by the adapter", async () => {
  const fetcher: Fetcher = {
    async fetchInterval({ range }) {
      return {
        points: [
          { t: 0, price: 10 },
          { t: 5_000, price: 11 },
          { t: 10_000, price: 12 },
        ],
        searchedInterval: range,
      };
    },
  };
  const broker = new Broker(fetcher, { now: () => 7_500 });
  const evalTime = new Float64Array([0, 5_000, 10_000]);
  broker.query({ evalTime });
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = broker.query({ evalTime });
  assert(result.sampleTime[2] === 10_000, "adapter sample was filtered by acquisition metadata");
  approx(Math.exp(result.value[2]!), 12, 1e-12);
  const latest = { t: Number.NaN, value: Number.NaN };
  assert(broker.readPointAtOrBefore(10_000, latest), "latest cached observation was missing");
  assert(latest.t === 10_000, "latest emitted sample was not cached");
  approx(Math.exp(latest.value), 12, 1e-12);
});

test("wavelet density counts selected observations rather than held values", () => {
  const store = new NumericSeriesStore();
  store.upsertBatch([
    { t: 0, value: 1 },
    { t: 20, value: 2 },
    { t: 40, value: 3 },
  ]);
  const evalTime = new Float64Array([0, 20, 40, 60, 80]);
  const sampleTime = new Float64Array(evalTime.length);
  store.findBatchAtOrBefore(evalTime, undefined, sampleTime);
  const density = usedSampleDensity(sampleTime, 1, 4);
  assert(density[0] === 1 && density[1] === 1, "selected observations were missing");
  assert(density[2] === 0 && density[3] === 0, "held values became new observations");
});

test("wavelet density exposes holds, gaps, and resumed observations", () => {
  const density = usedSampleDensity(
    new Float64Array([Number.NEGATIVE_INFINITY, 0, 0, Number.NEGATIVE_INFINITY, 4, 4]),
    1,
    5,
  );
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
  broker.query({ evalTime });
  await new Promise(resolve => setTimeout(resolve, 0));

  const intermediate = broker.query({ evalTime });
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
  broker.query({ evalTime });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.query({ evalTime });
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
  const oneSecondGrid = Float64Array.from({ length: 11 }, (_, index) => index * 1_000);
  broker.query({ evalTime: oneSecondGrid });
  await new Promise(resolve => setTimeout(resolve, 0));

  broker.query({ evalTime: new Float64Array([0, 5_000, 10_000]) });
  assert(count(requests) === 1, "observed finer/equal data did not satisfy coarse query");
  broker.query({ evalTime: Float64Array.from({ length: 21 }, (_, index) => index * 500) });
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
  broker.query({ evalTime: Float64Array.from({ length: 11 }, (_, index) => index * 1_000) });
  broker.query({ evalTime: new Float64Array([0, 5_000, 10_000]) });
  assert(count(requests) === 1, "fine pending request did not suppress coarse duplicate");
  broker.query({ evalTime: Float64Array.from({ length: 21 }, (_, index) => index * 500) });
  assert(count(requests) === 2, "coarse pending request suppressed a finer request");
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
  broker.query({ evalTime: new Float64Array([0, 1_000]) });
  broker.query({ evalTime: new Float64Array([2_000, 3_000]) });
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
  broker.query({ evalTime: new Float64Array([0, 1_000]) });
  await new Promise(resolve => setTimeout(resolve, 0));
  broker.query({ evalTime: new Float64Array([2_000, 3_000]) });
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
  const subscription = broker.subscribe(() => {
    throw new Error("UI failed");
  });
  subscription.read(new Float64Array([0, 1_000]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(errors.includes("[Broker] subscriber failed"), "subscriber exception was hidden");
  assert(!errors.includes("[Broker] adapter failed"), "adapter was blamed for subscriber failure");
  broker.close();
});

test("a late batch replaces matching timestamps and retains unmatched observations", () => {
  let sink: Parameters<SignalAdapter["connect"]>[0] | null = null;
  const adapter: SignalAdapter = {
    connect(nextSink) {
      sink = nextSink;
      return { setDemands: () => undefined, clearCache: () => undefined };
    },
  };
  const lifetime = new AbortController();
  const broker = new PriceBroker(adapter, { signal: lifetime.signal });
  const evalTime = new Float64Array([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
  const subscription = broker.subscribe(() => undefined, lifetime.signal);
  const connectedSink = sink as unknown as Parameters<SignalAdapter["connect"]>[0];
  connectedSink.next([
    { t: 0, value: 100 },
    { t: 1_000, value: 101 },
    { t: 2_000, value: 102 },
    { t: 3_000, value: 103 },
    { t: 4_000, value: 104 },
    { t: 5_000, value: 105 },
  ]);
  connectedSink.next([
    { t: 0, value: 10 },
    { t: 5_000, value: 15 },
  ]);

  const result = subscription.read(evalTime);
  assert(result.value[0] === 10, "late value did not replace an exact timestamp");
  assert(result.value[1] === 101, "late batch removed an unmatched observation");
  assert(result.value[5] === 15, "late tail value did not replace an exact timestamp");
  lifetime.abort();
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
  broker.query({ evalTime });
  broker.clearCache();
  broker.query({ evalTime });
  assert(resolvers.length === 2, "reload did not start a fresh request generation");

  resolvers[0]!({
    points: [
      { t: 0, price: 10 },
      { t: 1_000, price: 11 },
    ],
    searchedInterval: Interval.create(0, 1_000),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const beforeFresh = broker.query({ evalTime });
  assert(beforeFresh.value.every(Number.isNaN), "stale response repopulated the cleared cache");

  resolvers[1]!({
    points: [
      { t: 0, price: 100 },
      { t: 1_000, price: 101 },
    ],
    searchedInterval: Interval.create(0, 1_000),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const fresh = broker.query({ evalTime });
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
    const result = await fetchOnce(adapter, demand(Interval.create(0, 7_200_000), 3_600_000));
    const url = new URL(requestedUrl);
    assert(url.searchParams.get("symbol") === "ETHUSDT", "symbol was not normalized");
    assert(url.searchParams.get("interval") === "1h", "wrong Binance interval");
    assert(result.length === 2, "Binance rows were not converted");
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
    const result = await fetchOnce(
      createNobitexAdapter({ symbol: "USDTIRT" }),
      demand(Interval.create(0, 600_000), 60_000),
    );
    assert(
      requestedResolutions[0] === "1" && requestedResolutions[1] === "5",
      "Nobitex did not probe the next retained resolution",
    );
    assert(result.length === 2, "coarser retained candles were discarded");
    assert(result[1]!.t - result[0]!.t === 300_000, "fallback candle cadence was lost");
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
    const result = await fetchOnce(adapter, demand(Interval.create(0, 7_200_000), 3_600_000));
    const target = new URL(requestedUrl).searchParams.get("url") ?? "";
    assert(target.includes("/BZ%3DF?"), "Brent symbol was not encoded in Yahoo request");
    assert(target.includes("interval=60m"), "wrong Yahoo interval");
    assert(result.length === 2 && result[1]!.t === 3_600_000, "bad Yahoo rows");

    const secondInterval = Interval.create(1_000, 7_200_000);
    const cached = await fetchOnce(adapter, { range: secondInterval, sampleCount: 2 });
    assert(calls === 1, "same Yahoo candle window caused another HTTP request");
    assert(cached.length === 2, "cached response did not preserve samples");

    const cacheLifetime = new AbortController();
    const cacheSession = adapter.connect(
      { next: () => undefined, setReports: () => undefined, error: () => undefined },
      cacheLifetime.signal,
    );
    cacheSession.clearCache();
    cacheLifetime.abort();
    await fetchOnce(adapter, { range: secondInterval, sampleCount: 2 });
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
    const error = await failOnce(adapter, demand(Interval.create(60_000, 120_000), 60_000));
    assert(error instanceof Error, "Yahoo 429 did not surface an error");
    assert(
      (error as Error & { readonly retryAfterMs?: number }).retryAfterMs === 7_000,
      "Retry-After was ignored",
    );
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
  const errors: string[] = [];
  const fetcher: Fetcher = {
    retryDelayMs: () => 100,
    async fetchInterval() {
      calls++;
      throw new Error("upstream unavailable");
    },
  };
  const broker = new Broker(fetcher, {
    onError: (_message, error) => errors.push(String((error as Error).message)),
  });
  const evalTime = new Float64Array([0, 1_000]);
  broker.query({ evalTime });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(errors.includes("upstream unavailable"), "failure detail was lost");
  const failed = broker.query({ evalTime });
  assert(
    failed.reports.some(
      report => report.kind === "error" && report.message.includes("upstream unavailable"),
    ),
    "retry failure was not exposed as adapter commentary",
  );
  assert(Number(calls) === 1, "failure backoff did not suppress a retry");
  await new Promise(resolve => setTimeout(resolve, 120));
  broker.query({ evalTime });
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
  broker.query({ evalTime });
  await new Promise(resolve => setTimeout(resolve, 0));
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
