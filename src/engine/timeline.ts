/** One shared, vertically-resizable news and market timeline. */

import type { EventSet } from "../domain.ts";
import type { EventQueryResult } from "../data/events/broker.ts";
import type { Subscription, SignalView } from "../data/signal/broker.ts";
import type { MutableSample } from "../data/signal/sample.ts";
import { Interval } from "../core/interval.ts";
import type { MutableCanvasSize } from "./coordinates.ts";
import { Plot } from "./plot.ts";
import type { PaletteName } from "./ramp.ts";
import type { WaveletMode } from "./wavelet.ts";
import { DEFAULT_MIN_TICK_PX } from "./gfx/axis.ts";
import type { Frame } from "./gfx/context.ts";
import { fitStackLayout, signalRowCollapseProgress } from "./gfx/layout.ts";
import {
  TimelineInteractionModel,
  normalizePlayback,
  type HoverInfo,
  type TimelineInteractionState,
  type TimelineLayout,
  type TimelinePlayback,
} from "./timelineInteractionModel.ts";

export type { HoverInfo, TimelineLayout, TimelinePlayback } from "./timelineInteractionModel.ts";

export type SampleAtReader = (time: number, out: MutableSample) => boolean;
export type DataSubscriber = (onChange: () => void, signal: AbortSignal) => Subscription;
export type EventSource = (range: Interval) => EventQueryResult;

export interface SignalRow {
  readonly id: string;
  readonly readSampleAt: SampleAtReader;
  readonly subscribe: DataSubscriber;
  readonly palette: PaletteName;
  readonly waveletMode: WaveletMode;
  readonly verticalOffset: number;
  readonly height: number;
}

interface ActiveSignalSubscription {
  readonly subscription: Subscription;
  readonly controller: AbortController;
}

interface SignalRowRuntime {
  readonly row: SignalRow;
  height: number;
  palette: PaletteName;
  waveletMode: WaveletMode;
  verticalOffset: number;
  readonly hoverSample: MutableSample;
  subscription: ActiveSignalSubscription | null;
}

export interface TimelineOverlaySink {
  setNowLine(visible: boolean, x: number, width: number, stroke: string): void;
  setCrosshair(visible: boolean, x: number, time: number, viewportWidth: number): void;
  setEventTooltipAnchor(
    visible: boolean,
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void;
  setRowTop(id: string, top: number): void;
  setRowCollapseProgress(id: string, progress: number): void;
  hideSignalTooltips(): void;
  setSignalTooltip(
    id: string,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
}

export interface TimelineCallbacks {
  onHover?: (event: HoverInfo | null) => void;
  onViewportChange?: (viewport: Interval, priceScale: number) => void;
  onPlaybackChange?: (playback: TimelinePlayback) => void;
  onLayoutChange?: (layout: TimelineLayout, collapsedRowIds: readonly string[]) => void;
}

export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly signal: AbortSignal;
  readonly initialTimeInterval: Interval;
  readonly initialPlayback: TimelinePlayback;
  readonly initialNewsHeight: number;
  readonly signalRows: readonly SignalRow[];
  readonly eventSource: EventSource;
  readonly feedColorOf: (feedId: string) => string;
  readonly overlay?: TimelineOverlaySink;
  readonly callbacks?: TimelineCallbacks;
  readonly config?: Partial<TimelineConfig>;
}

export interface TimelineConfig {
  readonly wheelLineHeight: number;
  readonly wheelSensitivity: number;
  readonly timeScrollSensitivity: number;
  readonly nowWidth: number;
  readonly nowStroke: string;
  readonly minTickPx: number;
}

const DEFAULT_TIMELINE_CONFIG: TimelineConfig = {
  wheelLineHeight: 16,
  wheelSensitivity: 0.003,
  timeScrollSensitivity: 3,
  nowWidth: 2,
  nowStroke: "rgba(255, 255, 255, 0.55)",
  minTickPx: DEFAULT_MIN_TICK_PX,
};

const EMPTY_EVENTS: EventSet = { events: [] };
const RIGHT_EDGE_NOW_ANCHOR = 1;
export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly eventSource: EventSource;
  private readonly feedColorOf: (feedId: string) => string;
  private readonly overlay: TimelineOverlaySink | undefined;
  private readonly config: TimelineConfig;
  private readonly signal: AbortSignal;
  private readonly canvasSize: MutableCanvasSize = { width: 0, height: 0 };
  private readonly interaction: TimelineInteractionModel;
  // App state owns persistence; Timeline owns the live mutable row runtime.
  private rows: SignalRowRuntime[];
  private latestDpr = 1;
  private pendingInitialNewsHeight: number | null;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private state: TimelineInteractionState;
  private nowTimer: number | null = null;

  constructor(opts: TimelineOptions) {
    opts.signal.throwIfAborted();
    this.canvas = opts.canvas;
    this.signal = opts.signal;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.overlay = opts.overlay;
    this.callbacks = opts.callbacks ?? {};
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
    this.rows = opts.signalRows.map(row => createSignalRowRuntime(row, row.height));
    this.pendingInitialNewsHeight = this.rows.length === 0 ? opts.initialNewsHeight : null;
    this.plot = new Plot({ canvas: opts.canvas, initialTimeInterval: opts.initialTimeInterval });
    this.state = {
      events: EMPTY_EVENTS,
      timeInterval: opts.initialTimeInterval,
      logGain: 22,
      hovered: null,
      newsHeight: opts.initialNewsHeight,
      playback: normalizePlayback(opts.initialPlayback),
    };
    this.interaction = new TimelineInteractionModel({
      canvas: this.canvas,
      viewport: this.canvasSize,
      signal: this.signal,
      plot: this.plot,
      state: this.state,
      rows: () => this.rows,
      overlay: this.overlay,
      callbacks: this.callbacks,
      requestDraw: () => this.reqDraw(),
      wheelLineHeight: this.config.wheelLineHeight,
      wheelSensitivity: this.config.wheelSensitivity,
      timeScrollSensitivity: this.config.timeScrollSensitivity,
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
    this.reqDraw();
    this.signal.addEventListener("abort", this.close, { once: true });
  }

  reqDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  setSignalRows(rows: readonly SignalRow[]): void {
    const previousById = new Map(this.rows.map(runtime => [runtime.row.id, runtime]));
    const nextIds = new Set(rows.map(row => row.id));
    const hadSignalRows = this.rows.length > 0;

    // A row identity owns its broker subscription and render scratch state.
    // Reordering/removing one row must not tear down every other row's demand.
    for (const runtime of this.rows) {
      if (!nextIds.has(runtime.row.id)) runtime.subscription?.controller.abort();
    }

    this.rows = rows.map(row => {
      const previous = previousById.get(row.id);
      // Zero is valid only while a resize gesture is in progress. Once rows are
      // reconciled, every active row must have a positive recoverable height.
      const height =
        previous === undefined ? row.height : restoredRowHeight(previous.height, row.height);
      return createSignalRowRuntime(row, height, previous);
    });

    if (!hadSignalRows && rows.length > 0) {
      if (this.pendingInitialNewsHeight !== null) {
        this.state.newsHeight = this.pendingInitialNewsHeight;
        this.pendingInitialNewsHeight = null;
      }
    }
    this.fitLayout();
    this.interaction.clearHover();
    this.reqDraw();
  }

  refreshEvents(): void {
    const { events } = this.eventSource(this.state.timeInterval);
    this.state.events = { events };
    this.interaction.clearHover();
    this.reqDraw();
  }

  setTimeInterval(range: Interval): void {
    this.interaction.setTimeInterval(range);
  }

  getTimeInterval(): Interval {
    return this.state.timeInterval;
  }

  setPriceScale(scale: number): void {
    this.interaction.setPriceScale(scale);
  }

  getPriceScale(): number {
    return this.state.logGain;
  }

  setSignalRowWaveletMode(id: string, mode: WaveletMode): void {
    const runtime = this.rows.find(runtime => runtime.row.id === id);
    if (runtime === undefined || runtime.waveletMode === mode) return;
    runtime.waveletMode = mode;
    this.reqDraw();
  }

  getPlayback(): TimelinePlayback {
    return this.state.playback;
  }

  getLayout(): TimelineLayout {
    return this.interaction.getLayout();
  }

  private close = (): void => {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.rafId = null;
    this.nowTimer = null;
    this.interaction.close();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeSignalSubscriptions();
  };

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.canvasSize.width = this.plot.cssWidth;
    this.canvasSize.height = this.plot.cssHeight;
    this.fitLayout();
    this.reqDraw();
  }

  private fitLayout(): void {
    const fitted = fitStackLayout(
      this.state.newsHeight,
      this.rows.map(runtime => runtime.height),
      this.plot.cssHeight,
    );
    this.state.newsHeight = fitted.newsHeight;
    for (let index = 0; index < this.rows.length; index++) {
      this.rows[index]!.height = fitted.rowHeights[index]!;
    }
  }

  private readSignal(index: number, evalTime: Float64Array): SignalView {
    const runtime = this.rows[index];
    if (runtime === undefined) {
      throw new Error(`Missing signal row ${index}`);
    }
    if (runtime.subscription === null) {
      const controller = new AbortController();
      runtime.subscription = {
        controller,
        subscription: runtime.row.subscribe(() => this.reqDraw(), controller.signal),
      };
    }
    return runtime.subscription.subscription.read(evalTime);
  }

  private disposeSignalSubscriptions(): void {
    for (const runtime of this.rows) {
      runtime.subscription?.controller.abort();
      runtime.subscription = null;
    }
  }

  private draw = (): void => {
    if (!(this.plot.cssWidth > 0) || !(this.plot.cssHeight > 0)) return;

    const wallNow = Date.now();
    this.advanceFollowNow(wallNow);

    using frame = this.plot.beginFrame();
    const { width, height } = frame;
    const numDevicePx = frame.deviceWidth;
    if (numDevicePx <= 0) return;
    const { logGain: priceScale, timeInterval } = this.state;
    frame.fillRectPx(0, 0, width, height, "#05070d");

    const timePerDevicePx = (timeInterval.end - timeInterval.start) / numDevicePx;
    this.latestDpr = frame.dpr;

    const eventResult = this.eventSource(timeInterval);
    this.state.events = { events: eventResult.events };
    const eventY = this.state.newsHeight / 2;
    this.interaction.updateHover(frame.tx, eventY, width, height);
    frame.text("NEWS", 8, 9, "10px ui-monospace, monospace", "#94a3b8", "left", "top");
    frame.events().drawRow(this.state.events, this.feedColorOf, this.state.hovered, eventY);

    const signalRows = frame.signalRows(this.state.newsHeight);
    for (let index = 0; index < this.rows.length; index++) {
      const runtime = this.rows[index]!;
      const { row, height: rowHeight, waveletMode } = runtime;
      const signalRow = signalRows.next(row.id, rowHeight);
      this.overlay?.setRowTop(row.id, signalRow.heatmapTop);
      const collapseProgress = signalRowCollapseProgress(
        index,
        rowHeight,
        this.interaction.activeBoundary,
      );
      this.overlay?.setRowCollapseProgress(row.id, collapseProgress);
      signalRow.draw({
        verticalOffset: runtime.verticalOffset,
        logGain: priceScale,
        waveletMode,
        palette: runtime.palette,
        read: evalTime => this.readSignal(index, evalTime),
      });
    }
    this.updateCrosshairOverlay();
    this.drawSignalHoverTooltips(frame);

    // The only time axis lives on the news/price boundary.
    frame.fillRectPx(0, this.state.newsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.state.newsHeight, this.config.minTickPx);
    this.updateNowLine(wallNow);
    this.scheduleClock(timePerDevicePx / 2, wallNow);
  };

  private advanceFollowNow(now: number): void {
    if (this.state.playback.mode !== "following") return;
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    const anchor = this.state.playback.anchor;
    const min = now - span * anchor;
    const range = Interval.create(min, anchor === RIGHT_EDGE_NOW_ANCHOR ? now : min + span);
    this.state.timeInterval = range;
    this.plot.setTimeInterval(range);
  }

  private updateCrosshairOverlay(): void {
    const width = this.plot.cssWidth;
    if (!this.interaction.canShowHoverOverlay() || !(width > 0)) {
      this.overlay?.setCrosshair(false, 0, Number.NaN, width);
      return;
    }

    const x = Math.max(0, Math.min(width, this.interaction.pointer.x));
    const time =
      this.state.timeInterval.start +
      (x / width) * (this.state.timeInterval.end - this.state.timeInterval.start);
    this.overlay?.setCrosshair(true, x, time, width);
  }

  private drawSignalHoverTooltips(frame: Frame): void {
    this.overlay?.hideSignalTooltips();
    if (!this.interaction.canShowHoverOverlay() || this.overlay === undefined) return;

    const x = this.interaction.pointer.x;
    const hoverTime =
      this.state.timeInterval.start +
      (x / frame.width) * (this.state.timeInterval.end - this.state.timeInterval.start);
    const signalRows = frame.signalRows(this.state.newsHeight);
    for (const runtime of this.rows) {
      const { row, height: rowHeight } = runtime;
      const signalRow = signalRows.next(row.id, rowHeight);
      if (!signalRow.drawable) continue;
      const sample = runtime.hoverSample;
      const hasSample = row.readSampleAt(hoverTime, sample);
      const anchorX = hasSample ? frame.tx.timeToX(sample.t) : x;
      const text = !hasSample ? "loading…" : formatPrice(Math.exp(sample.value));
      const placement = signalRow.drawTooltip(anchorX, x, text);
      this.overlay.setSignalTooltip(
        row.id,
        text,
        placement.x,
        placement.y,
        placement.width,
        placement.height,
      );
    }
  }

  public setSignalRowPalette(id: string, palette: PaletteName): void {
    const runtime = this.rows.find(runtime => runtime.row.id === id);
    if (runtime === undefined || runtime.palette === palette) return;
    runtime.palette = palette;
    this.reqDraw();
  }

  private updateNowLine(now: number): void {
    const { timeInterval } = this.state;
    if (now < timeInterval.start || now > timeInterval.end) {
      this.overlay?.setNowLine(false, 0, 0, this.config.nowStroke);
      return;
    }

    const x =
      ((now - timeInterval.start) / (timeInterval.end - timeInterval.start)) * this.plot.cssWidth;
    const deviceWidth = Math.max(1, Math.round(this.config.nowWidth));
    const deviceCanvasWidth = Math.round(this.plot.cssWidth * this.latestDpr);
    const deviceLeft = Math.max(
      0,
      Math.min(deviceCanvasWidth - deviceWidth, Math.round(x * this.latestDpr - deviceWidth / 2)),
    );
    this.overlay?.setNowLine(
      true,
      deviceLeft / this.latestDpr,
      deviceWidth / this.latestDpr,
      this.config.nowStroke,
    );
  }

  private scheduleClock(timePerDevicePx: number, renderedNow: number): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    let delayMs = this.state.timeInterval.start - renderedNow;

    if (this.state.playback.mode === "following") delayMs = timePerDevicePx;
    else if (renderedNow > this.state.timeInterval.end) delayMs = Number.POSITIVE_INFINITY;

    delayMs = Math.max(delayMs, timePerDevicePx);
    if (!Number.isFinite(delayMs)) return;

    this.nowTimer = setTimeout(
      () => {
        this.nowTimer = null;
        this.reqDraw();
      },
      Math.max(delayMs, 16),
    );
  }

  public setEventTooltipHovered(hovered: boolean): void {
    this.interaction.setEventTooltipHovered(hovered);
  }

  public togglePlayback(): void {
    this.interaction.togglePlayback();
  }
}

function createSignalRowRuntime(
  row: SignalRow,
  height: number,
  previous?: SignalRowRuntime,
): SignalRowRuntime {
  return {
    row,
    height,
    palette: row.palette,
    waveletMode: row.waveletMode,
    verticalOffset: row.verticalOffset,
    hoverSample: previous?.hoverSample ?? { t: Number.NaN, value: Number.NaN },
    subscription: previous?.subscription ?? null,
  };
}

function restoredRowHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

const PRICE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 9,
  useGrouping: true,
});

function formatPrice(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return "—";
  return PRICE_FORMAT.format(price);
}
