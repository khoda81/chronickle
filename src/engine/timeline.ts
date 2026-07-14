/** One shared, vertically-resizable news and market timeline. */

import type { EventSet, NewsEvent } from "../domain.ts";
import type { EventQueryResult } from "../data/events/broker.ts";
import type {
  BrokerDemand,
  BrokerSubscription,
  QueryOptions,
  QueryResult,
} from "../data/price/broker.ts";
import { Range } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { transformTouchRange } from "./gesture.ts";
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

export type DataReader = (request: QueryOptions) => QueryResult;
export type DataSubscriber = (demand: BrokerDemand, onChange: () => void) => BrokerSubscription;
export type EventSource = (range: Range) => EventQueryResult;

export interface PriceRow {
  readonly id: string;
  readonly label: string;
  readonly read: DataReader;
  readonly subscribe: DataSubscriber;
  readonly onRemove?: () => void;
  readonly onDataChange?: () => void;
}

interface PriceRowChrome {
  readonly root: HTMLDivElement;
  readonly hover: HTMLDivElement;
}

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly feedId: string;
  readonly summary: string;
  readonly t: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

type MutableHoverInfo = { -readonly [Key in keyof HoverInfo]: HoverInfo[Key] };

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
  private priceSubscriptions: BrokerSubscription[] = [];
  private subscribedDemand: BrokerDemand | null = null;
  private latestPriceValues: Float64Array[] = [];
  private latestDpr = 1;
  private latestPadLeft = 0;
  private latestNumPx = 0;
  private readonly rowChrome = new Map<string, PriceRowChrome>();
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private state: TimelineState;
  private dragging = false;
  private resizingBoundary: number | null = null;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private gestureStartX = 0;
  private gestureStartY = 0;
  private gestureMoved = false;
  private touchAId: number | null = null;
  private touchAX = 0;
  private touchAY = 0;
  private touchBId: number | null = null;
  private touchBX = 0;
  private touchBY = 0;
  private evalTime = new Float64Array(0);
  private readonly nowLine: HTMLDivElement;
  private readonly hoverLine: HTMLDivElement;
  private nowTimer: number | null = null;
  private pointerInside = false;
  private pointerPx = 0;
  private pointerPy = 0;
  private notifiedHoverIndex: number | null = null;
  private notifiedHoverT = Number.NaN;
  private notifiedHoverTitle = "";
  private notifiedHoverLink = "";
  private notifiedHoverFeedId = "";
  private notifiedHoverSummary = "";
  private notifiedAnchorX = Number.NaN;
  private notifiedAnchorY = Number.NaN;
  private notifiedViewportWidth = Number.NaN;
  private notifiedViewportHeight = Number.NaN;
  private readonly hoverInfo: MutableHoverInfo = {
    index: -1,
    title: "",
    link: "",
    feedId: "",
    summary: "",
    t: Number.NaN,
    anchorX: Number.NaN,
    anchorY: Number.NaN,
    viewportWidth: Number.NaN,
    viewportHeight: Number.NaN,
  };

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.callbacks = opts.callbacks ?? {};
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
    this.priceRows = opts.priceRows ?? [];
    this.rowHeights = this.priceRows.map(() => MIN_PRICE_ROW_HEIGHT);
    this.plot = new Plot({ canvas: opts.canvas, initialTimeRange: opts.initialTimeRange });
    const parent = this.canvas.parentElement;
    if (parent === null) throw new Error("Timeline canvas must have a parent element");
    this.nowLine = document.createElement("div");
    this.nowLine.className = "timeline-now-line";
    this.nowLine.style.width = `${this.config.nowWidth}px`;
    this.nowLine.style.background = this.config.nowStroke;
    this.hoverLine = document.createElement("div");
    this.hoverLine.className = "timeline-hover-line";
    this.hoverLine.hidden = true;
    parent.append(this.nowLine, this.hoverLine);
    this.state = {
      events: EMPTY_EVENTS,
      timeRange: opts.initialTimeRange,
      priceScale: 22,
      waveletMode: "centered",
      hovered: null,
      newsHeight: DEFAULT_NEWS_HEIGHT,
    };
    this.rebuildRowChrome();

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
    this.disposePriceSubscriptions();
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
    this.latestPriceValues = rows.map(() => new Float64Array(0));
    this.rebuildRowChrome();
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
    this.disposePriceSubscriptions();
    this.nowLine.remove();
    this.hoverLine.remove();
    for (const chrome of this.rowChrome.values()) {
      chrome.root.remove();
      chrome.hover.remove();
    }
    this.rowChrome.clear();
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
    window.addEventListener("pointercancel", this.onPointerCancel);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointermove", this.onHoverMove);
    this.canvas.addEventListener("pointerleave", this.onHoverLeave);
    this.canvas.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointermove", this.onHoverMove);
    this.canvas.removeEventListener("pointerleave", this.onHoverLeave);
    this.canvas.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.hidePriceHover();
    this.fitLayout();
    this.reqDraw();
  }

  private fitLayout(): void {
    const fitted = fitStackLayout(this.state.newsHeight, this.rowHeights, this.plot.cssHeight);
    this.state.newsHeight = fitted.newsHeight;
    this.rowHeights = [...fitted.rowHeights];
  }

  private onResize = (): void => this.resize();

  private rebuildRowChrome(): void {
    for (const chrome of this.rowChrome.values()) {
      chrome.root.remove();
      chrome.hover.remove();
    }
    this.rowChrome.clear();
    const parent = this.canvas.parentElement;
    if (parent === null) throw new Error("Timeline canvas must have a parent element");
    for (const row of this.priceRows) {
      const root = document.createElement("div");
      root.className = "timeline-price-header";
      const label = document.createElement("span");
      label.textContent = row.label;
      root.append(label);
      if (row.onRemove !== undefined) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "timeline-price-remove";
        remove.textContent = "×";
        remove.title = `Remove ${row.label}`;
        remove.setAttribute("aria-label", `Remove ${row.label}`);
        remove.addEventListener("click", (event) => {
          event.stopPropagation();
          row.onRemove?.();
        });
        root.append(remove);
      }
      const hover = document.createElement("div");
      hover.className = "timeline-price-hover";
      hover.hidden = true;
      parent.append(root, hover);
      this.rowChrome.set(row.id, { root, hover });
    }
  }

  private positionRowChrome(row: PriceRow, rowY: number, _heatHeight: number): void {
    const chrome = this.rowChrome.get(row.id);
    if (chrome === undefined) return;
    chrome.root.style.transform = `translate3d(5px, ${rowY + 5}px, 0)`;
  }

  private syncPriceSubscriptions(demand: BrokerDemand): void {
    const previous = this.subscribedDemand;
    if (
      previous !== null &&
      previous.range.min === demand.range.min &&
      previous.range.max === demand.range.max &&
      previous.maxDeltaTMs === demand.maxDeltaTMs
    ) {
      return;
    }
    this.subscribedDemand = demand;
    if (this.priceSubscriptions.length === 0) {
      this.priceSubscriptions = this.priceRows.map((row) =>
        row.subscribe(demand, () => {
          row.onDataChange?.();
          this.reqDraw();
        }),
      );
      return;
    }
    for (const subscription of this.priceSubscriptions) subscription.update(demand);
  }

  private disposePriceSubscriptions(): void {
    for (const subscription of this.priceSubscriptions) subscription.dispose();
    this.priceSubscriptions = [];
    this.subscribedDemand = null;
  }

  private draw = (): void => {
    using frame = this.plot.beginFrame();
    const { width, height, dpr } = frame;
    const { priceScale, timeRange, waveletMode } = this.state;
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
    this.latestDpr = dpr;
    this.latestPadLeft = padLeft;
    this.latestNumPx = numPx;
    const demand = {
      range: Range.create(evalView[0]!, evalView[evalView.length - 1]!),
      maxDeltaTMs: timePerPx,
    } satisfies BrokerDemand;
    this.syncPriceSubscriptions(demand);

    const eventResult = this.eventSource(timeRange);
    this.state.events = { events: eventResult.events };
    const eventY = this.state.newsHeight / 2;
    this.updateHover(frame.tx, eventY, width, height);
    frame.text("NEWS", 8, 9, "10px ui-monospace, monospace", "#94a3b8", "left", "top");
    frame.events().drawRow(this.state.events, this.feedColorOf, this.state.hovered, eventY);

    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.priceRows.length; index++) {
      const row = this.priceRows[index]!;
      const rowHeight = this.rowHeights[index]!;
      const heatHeight = Math.max(2, rowHeight - RESOLUTION_BAR_HEIGHT);
      const result = row.read({ evalTime: evalView, maxDeltaTMs: timePerPx });
      this.latestPriceValues[index] = result.value;
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
      this.positionRowChrome(row, rowY, heatHeight);
      rowY += rowHeight;
      frame.fillRectPx(0, rowY - 1, width, 1, "rgba(255,255,255,0.18)");
    }
    this.updatePriceHoverOverlay();

    // The only time axis lives on the news/price boundary.
    frame.fillRectPx(0, this.state.newsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.state.newsHeight, this.config.minTickPx);
    this.drawResizeHandles(frame);
    this.updateNowLine(timePerPx);
  };

  private updatePriceHoverOverlay(): void {
    if (
      !this.pointerInside ||
      this.dragging ||
      this.resizingBoundary !== null ||
      this.priceRows.length === 0 ||
      this.latestNumPx <= 0 ||
      this.boundaryAt(this.pointerPy) !== null
    ) {
      this.hidePriceHover();
      return;
    }

    const width = this.plot.cssWidth;
    if (!(width > 0)) {
      this.hidePriceHover();
      return;
    }
    const x = Math.max(0, Math.min(width, this.pointerPx));
    this.hoverLine.hidden = false;
    this.hoverLine.style.transform = `translate3d(${x - 0.5}px, 0, 0)`;
    const deviceX = Math.max(0, Math.min(this.latestNumPx, Math.floor(x * this.latestDpr)));
    const sampleIndex = this.latestPadLeft + deviceX;

    let rowY = this.state.newsHeight;
    const viewportHeight = this.plot.cssHeight;
    for (let index = 0; index < this.priceRows.length; index++) {
      const row = this.priceRows[index]!;
      const rowHeight = this.rowHeights[index]!;
      const heatHeight = Math.max(2, rowHeight - RESOLUTION_BAR_HEIGHT);
      const chrome = this.rowChrome.get(row.id);
      if (chrome === undefined) {
        rowY += rowHeight;
        continue;
      }
      const logPrice = this.latestPriceValues[index]?.[sampleIndex];
      if (logPrice === undefined || !Number.isFinite(logPrice)) {
        chrome.hover.hidden = true;
        rowY += rowHeight;
        continue;
      }
      const text = formatPrice(Math.exp(logPrice));
      if (chrome.hover.textContent !== text) chrome.hover.textContent = text;
      chrome.hover.hidden = false;
      const labelWidth = chrome.hover.offsetWidth;
      const labelHeight = chrome.hover.offsetHeight;
      const margin = 7;
      const preferred = x + 9;
      const labelX =
        preferred + labelWidth <= width - margin ? preferred : Math.max(margin, x - 9 - labelWidth);
      const centeredY = rowY + (heatHeight - labelHeight) / 2;
      const labelY = Math.max(4, Math.min(viewportHeight - labelHeight - 4, centeredY));
      chrome.hover.style.transform = `translate3d(${labelX}px, ${labelY}px, 0)`;
      rowY += rowHeight;
    }
  }

  private hidePriceHover(): void {
    this.hoverLine.hidden = true;
    for (const chrome of this.rowChrome.values()) chrome.hover.hidden = true;
  }

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
    if (this.priceRows.length === 0) return null;
    let boundaryY = this.state.newsHeight;
    if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return 0;
    for (let index = 0; index < this.rowHeights.length - 1; index++) {
      boundaryY += this.rowHeights[index]!;
      if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return index + 1;
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

  /** Move the wall-clock marker without invalidating data or the heatmap. */
  private updateNowLine(timePerPx: number): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.nowTimer = null;
    const now = Date.now();
    const { timeRange } = this.state;
    if (now > timeRange.max) {
      this.nowLine.hidden = true;
      return;
    }
    if (now >= timeRange.min) {
      const x = ((now - timeRange.min) / (timeRange.max - timeRange.min)) * this.plot.cssWidth;
      this.nowLine.hidden = false;
      this.nowLine.style.transform = `translate3d(${x - this.config.nowWidth / 2}px, 0, 0)`;
    } else {
      this.nowLine.hidden = true;
    }

    // Ten updates per horizontal pixel matches the old visual motion, but this
    // timer now changes one compositor transform instead of redrawing/querying
    // the entire timeline. Cap at 120 Hz on extremely zoomed-in views.
    const delayMs = Math.max(1000 / 120, timeRange.min - now, timePerPx / 10);
    this.nowTimer = setTimeout(() => {
      this.nowTimer = null;
      this.updateNowLine(timePerPx);
    }, delayMs) as unknown as number;
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.updatePointer(event);
    this.hidePriceHover();
    if (event.pointerType === "touch") {
      this.onTouchDown(event);
      return;
    }

    this.gestureStartX = event.clientX;
    this.gestureStartY = event.clientY;
    this.gestureMoved = false;
    this.dragPointerId = event.pointerId;
    const boundary = this.boundaryAt(this.pointerPy);
    if (boundary !== null) {
      this.resizingBoundary = boundary;
      this.dragging = false;
      this.lastY = this.pointerPy;
      if (this.clearHover()) this.reqDraw();
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
    if (event.pointerType === "touch") {
      this.onTouchMove(event);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    if (this.resizingBoundary !== null) {
      this.updatePointer(event);
      const y = this.pointerPy;
      this.moveBoundary(this.resizingBoundary, y - this.lastY);
      this.lastY = y;
      this.markGestureMoved(event.clientX, event.clientY);
      this.reqDraw();
      return;
    }
    if (!this.dragging) return;
    const dx = event.clientX - this.lastX;
    this.lastX = event.clientX;
    this.markGestureMoved(event.clientX, event.clientY);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const span = this.state.timeRange.max - this.state.timeRange.min;
    this.setTimeRange(Range.pan(this.state.timeRange, -(dx / rect.width) * span));
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchEnd(event);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragging = false;
    this.resizingBoundary = null;
    this.dragPointerId = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.updatePointer(event);
    this.updatePriceHoverOverlay();
    this.reqDraw();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchEnd(event);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = null;
    this.dragging = false;
    this.resizingBoundary = null;
    this.hidePriceHover();
    this.reqDraw();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.updatePointer(event);
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
    this.updatePointer(event);
    this.canvas.style.cursor = this.boundaryAt(this.pointerPy) === null ? "" : "ns-resize";
    this.updatePriceHoverOverlay();
    if (this.dragging || this.resizingBoundary !== null) return;
    if (this.updateHoverAtCurrentTransform()) this.reqDraw();
  };

  private onHoverLeave = (): void => {
    this.pointerInside = false;
    this.hidePriceHover();
    if (this.dragging || this.resizingBoundary !== null) return;
    if (this.clearHover()) this.reqDraw();
  };

  private onClick = (event: PointerEvent): void => {
    if (this.gestureMoved) {
      this.gestureMoved = false;
      return;
    }
    this.updatePointer(event);
    if (this.updateHoverAtCurrentTransform()) this.reqDraw();
    if (this.state.hovered === null) return;
    window.open(this.eventAt(this.state.hovered).link, "_blank", "noopener,noreferrer");
  };

  private onTouchDown(event: PointerEvent): void {
    if (this.touchAId === null) {
      this.touchAId = event.pointerId;
      this.touchAX = event.clientX;
      this.touchAY = event.clientY;
      this.gestureStartX = event.clientX;
      this.gestureStartY = event.clientY;
      this.gestureMoved = false;
      const boundary = this.boundaryAt(this.pointerPy);
      if (boundary !== null) {
        this.resizingBoundary = boundary;
        this.lastY = this.pointerPy;
        this.canvas.style.cursor = "ns-resize";
      } else {
        this.resizingBoundary = null;
      }
      this.dragging = true;
    } else if (this.touchBId === null && event.pointerId !== this.touchAId) {
      this.touchBId = event.pointerId;
      this.touchBX = event.clientX;
      this.touchBY = event.clientY;
      this.resizingBoundary = null;
      this.gestureMoved = true;
      if (this.clearHover()) this.reqDraw();
    }
    this.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private onTouchMove(event: PointerEvent): void {
    const movingA = event.pointerId === this.touchAId;
    const movingB = event.pointerId === this.touchBId;
    if (!movingA && !movingB) return;

    const previousAX = this.touchAX;
    const previousAY = this.touchAY;
    const previousBX = this.touchBX;
    const previousBY = this.touchBY;
    if (movingA) {
      this.touchAX = event.clientX;
      this.touchAY = event.clientY;
    } else {
      this.touchBX = event.clientX;
      this.touchBY = event.clientY;
    }

    this.updatePointer(event);
    if (this.touchBId !== null) {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width > 0) {
        const previousCenterX = (previousAX + previousBX) / 2 - rect.left;
        const currentCenterX = (this.touchAX + this.touchBX) / 2 - rect.left;
        const previousDistance = Math.hypot(previousBX - previousAX, previousBY - previousAY);
        const currentDistance = Math.hypot(
          this.touchBX - this.touchAX,
          this.touchBY - this.touchAY,
        );
        this.setTimeRange(
          transformTouchRange(
            this.state.timeRange,
            rect.width,
            previousCenterX,
            currentCenterX,
            previousDistance,
            currentDistance,
          ),
        );
      }
      event.preventDefault();
      return;
    }

    if (this.resizingBoundary !== null) {
      const y = this.pointerPy;
      this.moveBoundary(this.resizingBoundary, y - this.lastY);
      this.lastY = y;
      this.markGestureMoved(event.clientX, event.clientY);
      this.reqDraw();
      event.preventDefault();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0) {
      const dx = this.touchAX - previousAX;
      const span = this.state.timeRange.max - this.state.timeRange.min;
      this.setTimeRange(Range.pan(this.state.timeRange, -(dx / rect.width) * span));
    }
    this.markGestureMoved(event.clientX, event.clientY);
    event.preventDefault();
  }

  private onTouchEnd(event: PointerEvent): void {
    if (event.pointerId === this.touchAId) {
      if (this.touchBId !== null) {
        this.touchAId = this.touchBId;
        this.touchAX = this.touchBX;
        this.touchAY = this.touchBY;
        this.touchBId = null;
      } else {
        this.touchAId = null;
      }
    } else if (event.pointerId === this.touchBId) {
      this.touchBId = null;
    } else {
      return;
    }

    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.resizingBoundary = null;
    if (this.touchAId === null) {
      this.dragging = false;
      this.pointerInside = false;
      this.canvas.style.cursor = "";
    } else {
      this.dragging = true;
      this.gestureStartX = this.touchAX;
      this.gestureStartY = this.touchAY;
    }
    this.hidePriceHover();
    this.reqDraw();
  }

  private markGestureMoved(clientX: number, clientY: number): void {
    if (
      !this.gestureMoved &&
      Math.hypot(clientX - this.gestureStartX, clientY - this.gestureStartY) >= 5
    ) {
      this.gestureMoved = true;
    }
  }

  private eventAt(index: number): NewsEvent {
    const event = this.state.events.events[index];
    if (event === undefined) throw new Error(`Event index out of range: ${index}`);
    return event;
  }

  private updatePointer(event: Pick<PointerEvent, "clientX" | "clientY">): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.pointerInside = false;
      return;
    }
    this.pointerInside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    this.pointerPx = (event.clientX - rect.left) * (this.plot.cssWidth / rect.width);
    this.pointerPy = (event.clientY - rect.top) * (this.plot.cssHeight / rect.height);
  }

  private updateHoverAtCurrentTransform(): boolean {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0)) return this.clearHover();
    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, width),
      Range.create(0, height),
    );
    return this.updateHover(tx, this.state.newsHeight / 2, width, height);
  }

  private updateHover(tx: DataTransform, eventY: number, width: number, height: number): boolean {
    const previous = this.state.hovered;
    const index =
      this.pointerInside &&
      !this.dragging &&
      this.resizingBoundary === null &&
      this.boundaryAt(this.pointerPy) === null
        ? hitTestEvent(this.state.events, tx, this.pointerPx, this.pointerPy, eventY)
        : null;
    this.state.hovered = index;
    if (index === null) {
      this.clearHover();
      return previous !== null;
    }

    const event = this.eventAt(index);
    const anchorX = tx.timeToX(event.t);
    const changed =
      index !== this.notifiedHoverIndex ||
      event.t !== this.notifiedHoverT ||
      event.title !== this.notifiedHoverTitle ||
      event.link !== this.notifiedHoverLink ||
      event.feedId !== this.notifiedHoverFeedId ||
      event.summary !== this.notifiedHoverSummary ||
      anchorX !== this.notifiedAnchorX ||
      eventY !== this.notifiedAnchorY ||
      width !== this.notifiedViewportWidth ||
      height !== this.notifiedViewportHeight;
    if (!changed || this.callbacks.onHover === undefined) return previous !== index;

    this.notifiedHoverIndex = index;
    this.notifiedHoverT = event.t;
    this.notifiedHoverTitle = event.title;
    this.notifiedHoverLink = event.link;
    this.notifiedHoverFeedId = event.feedId;
    this.notifiedHoverSummary = event.summary;
    this.notifiedAnchorX = anchorX;
    this.notifiedAnchorY = eventY;
    this.notifiedViewportWidth = width;
    this.notifiedViewportHeight = height;
    const info = this.hoverInfo;
    info.index = index;
    info.title = event.title;
    info.link = event.link;
    info.feedId = event.feedId;
    info.summary = event.summary;
    info.t = event.t;
    info.anchorX = anchorX;
    info.anchorY = eventY;
    info.viewportWidth = width;
    info.viewportHeight = height;
    this.callbacks.onHover(info);
    return previous !== index;
  }

  private clearHover(): boolean {
    const visualChanged = this.state.hovered !== null;
    this.state.hovered = null;
    if (this.notifiedHoverIndex === null) return visualChanged;
    this.notifiedHoverIndex = null;
    this.notifiedHoverT = Number.NaN;
    this.notifiedHoverTitle = "";
    this.notifiedHoverLink = "";
    this.notifiedHoverFeedId = "";
    this.notifiedHoverSummary = "";
    this.notifiedAnchorX = Number.NaN;
    this.notifiedAnchorY = Number.NaN;
    this.notifiedViewportWidth = Number.NaN;
    this.notifiedViewportHeight = Number.NaN;
    this.callbacks.onHover?.(null);
    return visualChanged;
  }
}

const PRICE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 9,
  useGrouping: true,
});

function formatPrice(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return "—";
  return PRICE_FORMAT.format(price);
}
