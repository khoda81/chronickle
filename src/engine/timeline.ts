/** One shared, vertically-resizable news and market timeline. */

import type { EventSet, NewsEvent } from "../domain.ts";
import type { EventQueryResult } from "../data/events/broker.ts";
import type { QueryResult } from "../data/price/broker.ts";
import { Range } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { Plot } from "./plot.ts";
import { hitTestEvent } from "./hittest.ts";
import { setRampPalette, type PaletteName } from "./ramp.ts";
import { kernelContext, type WaveletMode } from "./wavelet.ts";
import { DEFAULT_MIN_TICK_PX } from "./gfx/axis.ts";
import type { Frame } from "./gfx/context.ts";
import {
  DEFAULT_NEWS_HEIGHT,
  fitStackLayout,
  MIN_NEWS_HEIGHT,
  MIN_PRICE_ROW_HEIGHT,
  RESIZE_HANDLE_RADIUS,
  RESOLUTION_BAR_HEIGHT,
  maxSigmaFor,
} from "./gfx/layout.ts";

export type DataSource = (evalTime: Float64Array, maxDeltaTMs: number) => QueryResult;
export type EventSource = (range: Range) => EventQueryResult;

export interface PriceRow {
  readonly id: string;
  readonly label: string;
  readonly dataSource: DataSource;
}

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly feedId: string;
  readonly summary: string;
  readonly t: number;
  readonly px: number;
  readonly py: number;
}

export interface TimelineCallbacks {
  onHover?: (event: HoverInfo | null) => void;
  onViewportChange?: (viewport: { min: number; max: number }, priceScale: number) => void;
}

export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialTimeRange: Range;
  readonly priceRows?: readonly PriceRow[];
  readonly eventSource: EventSource;
  readonly feedColorOf: (feedId: string) => string;
  readonly callbacks?: TimelineCallbacks;
  readonly config?: Partial<TimelineConfig>;
}

interface TimelineState {
  events: EventSet;
  timeRange: Range;
  priceScale: number;
  waveletMode: WaveletMode;
  hovered: number | null;
  newsHeight: number;
}

export interface TimelineConfig {
  readonly wheelLineHeight: number;
  readonly wheelSensitivity: number;
  readonly timeScrollSensitivity: number;
  readonly nowWidth: number;
  readonly nowStroke: string;
  readonly minTickPx: number;
}

export const DEFAULT_TIMELINE_CONFIG: TimelineConfig = {
  wheelLineHeight: 16,
  wheelSensitivity: 0.003,
  timeScrollSensitivity: 3,
  nowWidth: 2,
  nowStroke: "rgba(255, 255, 255, 0.55)",
  minTickPx: DEFAULT_MIN_TICK_PX,
};

const EMPTY_EVENTS: EventSet = { events: [] };

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly eventSource: EventSource;
  private readonly feedColorOf: (feedId: string) => string;
  private readonly config: TimelineConfig;
  private priceRows: readonly PriceRow[];
  private rowHeights: number[];
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private state: TimelineState;
  private dragging = false;
  private resizingBoundary: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private evalTime = new Float64Array(0);
  private nowTimer: number | null = null;

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.callbacks = opts.callbacks ?? {};
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
    this.priceRows = opts.priceRows ?? [];
    this.rowHeights = this.priceRows.map(() => MIN_PRICE_ROW_HEIGHT);
    this.plot = new Plot({ canvas: opts.canvas, initialTimeRange: opts.initialTimeRange });
    this.state = {
      events: EMPTY_EVENTS,
      timeRange: opts.initialTimeRange,
      priceScale: 22,
      waveletMode: "centered",
      hovered: null,
      newsHeight: DEFAULT_NEWS_HEIGHT,
    };

    this.bindEvents();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
    this.reqDraw();
  }

  reqDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  setPriceRows(rows: readonly PriceRow[]): void {
    const hadPriceRows = this.priceRows.length > 0;
    const oldHeight = new Map(
      this.priceRows.map((row, index) => [row.id, this.rowHeights[index]!]),
    );
    const fallback =
      this.rowHeights.length > 0
        ? this.rowHeights.reduce((sum, height) => sum + height, 0) / this.rowHeights.length
        : MIN_PRICE_ROW_HEIGHT;
    this.priceRows = [...rows];
    this.rowHeights = rows.map((row) => oldHeight.get(row.id) ?? fallback);
    if (!hadPriceRows && rows.length > 0) this.state.newsHeight = DEFAULT_NEWS_HEIGHT;
    this.fitLayout();
    this.state.hovered = null;
    this.reqDraw();
  }

  refreshEvents(): void {
    const { events } = this.eventSource(this.state.timeRange);
    this.state.events = { events };
    this.state.hovered = null;
    this.reqDraw();
  }

  setTimeRange(range: Range): void {
    this.state.timeRange = range;
    this.plot.setTimeRange(range);
    this.notifyViewportChange();
    this.reqDraw();
  }

  getTimeRange(): Range {
    return this.state.timeRange;
  }

  setPriceScale(scale: number): void {
    this.state.priceScale = scale;
    this.notifyViewportChange();
    this.reqDraw();
  }

  getPriceScale(): number {
    return this.state.priceScale;
  }

  setWaveletMode(mode: WaveletMode): void {
    this.state.waveletMode = mode;
    this.reqDraw();
  }

  getWaveletMode(): WaveletMode {
    return this.state.waveletMode;
  }

  setPalette(name: PaletteName): void {
    setRampPalette(name);
    this.reqDraw();
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unbindEvents();
  }

  private notifyViewportChange(): void {
    this.callbacks.onViewportChange?.(
      { min: this.state.timeRange.min, max: this.state.timeRange.max },
      this.state.priceScale,
    );
  }

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointermove", this.onHoverMove);
    this.canvas.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointermove", this.onHoverMove);
    this.canvas.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.fitLayout();
    this.reqDraw();
  }

  private fitLayout(): void {
    const fitted = fitStackLayout(this.state.newsHeight, this.rowHeights, this.plot.cssHeight);
    this.state.newsHeight = fitted.newsHeight;
    this.rowHeights = [...fitted.rowHeights];
  }

  private onResize = (): void => this.resize();

  private draw = (): void => {
    using frame = this.plot.beginFrame();
    const { width, height, dpr } = frame;
    const { hovered, priceScale, timeRange, waveletMode } = this.state;
    frame.fillRectPx(0, 0, width, height, "#05070d");

    const numPx = Math.ceil(width * dpr);
    if (numPx <= 0) return;
    const maxSigma = maxSigmaFor(numPx);
    const timePerPx = (timeRange.max - timeRange.min) / numPx;
    const context = kernelContext(waveletMode, maxSigma);
    const padLeft = context.leftCells;
    const padRight = context.rightCells;
    const edgeCount = padLeft + numPx + padRight + 1;
    if (this.evalTime.length < edgeCount) this.evalTime = new Float64Array(edgeCount);
    for (let index = 0; index < edgeCount; index++) {
      this.evalTime[index] = timeRange.min + (index - padLeft) * timePerPx;
    }
    const evalView = this.evalTime.subarray(0, edgeCount) as Float64Array;

    const eventResult = this.eventSource(timeRange);
    this.state.events = { events: eventResult.events };
    const eventY = this.state.newsHeight / 2;
    frame.text("NEWS", 8, 9, "10px ui-monospace, monospace", "#94a3b8", "left", "top");
    frame.events().drawRow(this.state.events, this.feedColorOf, hovered, eventY);

    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.priceRows.length; index++) {
      const row = this.priceRows[index]!;
      const rowHeight = this.rowHeights[index]!;
      const heatHeight = Math.max(2, rowHeight - RESOLUTION_BAR_HEIGHT);
      const result = row.dataSource(evalView, timePerPx);
      frame.heatmap(row.id).drawWaveletField(
        {
          evalTime: evalView,
          value: result.value,
          padLeft,
          padRight,
          revision: result.revision,
        },
        priceScale,
        waveletMode,
        rowY,
        heatHeight,
      );
      frame.resolution().draw(result.resolution, result.targetResolutionMs, rowY + heatHeight);
      frame.fillRectPx(
        5,
        rowY + 5,
        Math.min(width - 10, 12 + row.label.length * 7),
        20,
        "rgba(5,7,13,0.78)",
      );
      frame.text(
        row.label,
        11,
        rowY + 15,
        "11px ui-monospace, monospace",
        "#f8fafc",
        "left",
        "middle",
      );
      rowY += rowHeight;
      frame.fillRectPx(0, rowY - 1, width, 1, "rgba(255,255,255,0.18)");
    }

    // The only time axis lives on the news/price boundary.
    frame.fillRectPx(0, this.state.newsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.state.newsHeight, this.config.minTickPx);
    this.drawResizeHandles(frame);
    this.drawNow(frame, timePerPx);
  };

  private drawResizeHandles(frame: Frame): void {
    for (const y of this.boundaryYs()) {
      frame.fillRectPx(frame.width / 2 - 20, y - 2, 40, 4, "rgba(203,213,225,0.62)");
    }
  }

  private boundaryYs(): number[] {
    if (this.priceRows.length === 0) return [];
    const ys = [this.state.newsHeight];
    let y = this.state.newsHeight;
    for (let index = 0; index < this.rowHeights.length - 1; index++) {
      y += this.rowHeights[index]!;
      ys.push(y);
    }
    return ys;
  }

  private boundaryAt(y: number): number | null {
    const ys = this.boundaryYs();
    for (let index = 0; index < ys.length; index++) {
      if (Math.abs(y - ys[index]!) <= RESIZE_HANDLE_RADIUS) return index;
    }
    return null;
  }

  private moveBoundary(boundary: number, delta: number): void {
    if (this.rowHeights.length === 0 || delta === 0) return;
    const total = this.plot.cssHeight;
    const count = this.rowHeights.length;
    const minNews = Math.min(MIN_NEWS_HEIGHT, total / (count + 1));
    const minPrice = Math.min(MIN_PRICE_ROW_HEIGHT, (total - minNews) / count);
    if (boundary === 0) {
      const pair = this.state.newsHeight + this.rowHeights[0]!;
      const newsHeight = Math.max(
        minNews,
        Math.min(pair - minPrice, this.state.newsHeight + delta),
      );
      this.rowHeights[0] = pair - newsHeight;
      this.state.newsHeight = newsHeight;
      return;
    }
    const left = boundary - 1;
    const right = boundary;
    const pair = this.rowHeights[left]! + this.rowHeights[right]!;
    const leftHeight = Math.max(
      minPrice,
      Math.min(pair - minPrice, this.rowHeights[left]! + delta),
    );
    this.rowHeights[left] = leftHeight;
    this.rowHeights[right] = pair - leftHeight;
  }

  private drawNow(frame: Frame, timePerPx: number): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.nowTimer = null;
    const now = Date.now();
    const { timeRange } = this.state;
    if (now > timeRange.max) return;
    frame.vline(
      frame.tx.timeToX(now),
      0,
      frame.height,
      this.config.nowStroke,
      this.config.nowWidth,
    );
    const delayMs = Math.max(timeRange.min - now, timePerPx / 10);
    this.nowTimer = setTimeout(() => {
      this.nowTimer = null;
      this.reqDraw();
    }, delayMs) as unknown as number;
  }

  private onPointerDown = (event: PointerEvent): void => {
    const boundary = this.boundaryAt(this.pointerY(event));
    if (boundary !== null) {
      this.resizingBoundary = boundary;
      this.dragging = false;
      this.lastY = this.pointerY(event);
      this.state.hovered = null;
      this.canvas.style.cursor = "ns-resize";
      this.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    this.dragging = true;
    this.lastX = event.clientX;
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.resizingBoundary !== null) {
      const y = this.pointerY(event);
      this.moveBoundary(this.resizingBoundary, y - this.lastY);
      this.lastY = y;
      this.reqDraw();
      return;
    }
    if (!this.dragging) return;
    const dx = event.clientX - this.lastX;
    this.lastX = event.clientX;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const span = this.state.timeRange.max - this.state.timeRange.min;
    this.setTimeRange(Range.pan(this.state.timeRange, -(dx / rect.width) * span));
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.dragging = false;
    this.resizingBoundary = null;
    this.canvas.releasePointerCapture?.(event.pointerId);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = this.plot.cssWidth;
    const cssHeight = this.plot.cssHeight;
    if (cssWidth <= 0 || rect.width <= 0) return;
    const px = (event.clientX - rect.left) * (cssWidth / rect.width);
    let dy = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= this.config.wheelLineHeight;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= cssHeight;
    const span = this.state.timeRange.max - this.state.timeRange.min;
    const dt = (this.config.timeScrollSensitivity * span * event.deltaX) / cssWidth;
    if (dt !== 0) this.setTimeRange(Range.pan(this.state.timeRange, dt));
    if (event.shiftKey) {
      this.setPriceScale(this.state.priceScale - dy * this.config.wheelSensitivity);
      return;
    }
    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, cssWidth),
      Range.create(0, cssHeight),
    );
    const factor = Math.exp(-dy * this.config.wheelSensitivity);
    this.setTimeRange(Range.zoom(this.state.timeRange, tx.xToTime(px), factor));
  };

  private onHoverMove = (event: PointerEvent): void => {
    if (this.dragging || this.resizingBoundary !== null) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const cssWidth = this.plot.cssWidth;
    const cssHeight = this.plot.cssHeight;
    const px = (event.clientX - rect.left) * (cssWidth / rect.width);
    const py = (event.clientY - rect.top) * (cssHeight / rect.height);
    this.canvas.style.cursor = this.boundaryAt(py) === null ? "" : "ns-resize";
    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, cssWidth),
      Range.create(0, cssHeight),
    );
    const index = hitTestEvent(this.state.events, tx, px, py, this.state.newsHeight / 2);
    if (index !== this.state.hovered) {
      this.state.hovered = index;
      this.reqDraw();
      this.fireHover(index, px, py);
    }
  };

  private onClick = (): void => {
    if (this.state.hovered === null) return;
    window.open(this.eventAt(this.state.hovered).link, "_blank", "noopener,noreferrer");
  };

  private pointerY(event: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return rect.height <= 0 ? 0 : (event.clientY - rect.top) * (this.plot.cssHeight / rect.height);
  }

  private eventAt(index: number): NewsEvent {
    const event = this.state.events.events[index];
    if (event === undefined) throw new Error(`Event index out of range: ${index}`);
    return event;
  }

  private fireHover(index: number | null, px: number, py: number): void {
    if (this.callbacks.onHover === undefined) return;
    if (index === null) {
      this.callbacks.onHover(null);
      return;
    }
    const event = this.eventAt(index);
    this.callbacks.onHover({
      index,
      title: event.title,
      link: event.link,
      feedId: event.feedId,
      summary: event.summary,
      t: event.t,
      px,
      py,
    });
  }
}
