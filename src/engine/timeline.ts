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
import { nearestEventIndex } from "./hittest.ts";
import { PALETTES, paletteCssGradient, type PaletteName } from "./ramp.ts";
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
  clampHeatmapOffset,
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
  readonly palette: PaletteName;
  readonly verticalOffset: number;
  readonly onRemove?: () => void;
  readonly onDataChange?: () => void;
  readonly onPaletteChange?: (palette: PaletteName) => void;
  readonly onVerticalOffsetChange?: (offset: number) => void;
}

interface PriceRowChrome {
  readonly root: HTMLDivElement;
  readonly palette: HTMLButtonElement;
  readonly paletteBar: HTMLSpanElement;
  readonly paletteMenu: HTMLDivElement;
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
  private rowPalettes: PaletteName[];
  private rowVerticalOffsets: number[];
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
  private verticalPanRow: number | null = null;
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
  private readonly timeHover: HTMLDivElement;
  private nowTimer: number | null = null;
  private pointerInside = false;
  private pointerPx = 0;
  private pointerPy = 0;
  private crosshairPinned = false;
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
    this.rowPalettes = this.priceRows.map((row) => row.palette);
    this.rowVerticalOffsets = this.priceRows.map((row) => row.verticalOffset);
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
    this.timeHover = document.createElement("div");
    this.timeHover.className = "timeline-time-hover";
    this.timeHover.hidden = true;
    parent.append(this.nowLine, this.hoverLine, this.timeHover);
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
    this.rowPalettes = rows.map((row) => row.palette);
    this.rowVerticalOffsets = rows.map((row) => row.verticalOffset);
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

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposePriceSubscriptions();
    this.nowLine.remove();
    this.hoverLine.remove();
    this.timeHover.remove();
    for (const chrome of this.rowChrome.values()) {
      chrome.root.remove();
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
    document.addEventListener("pointerdown", this.onDocumentPointerDown);
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
    document.removeEventListener("pointerdown", this.onDocumentPointerDown);
    window.removeEventListener("resize", this.onResize);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.hideCrosshair();
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
    }
    this.rowChrome.clear();
    const parent = this.canvas.parentElement;
    if (parent === null) throw new Error("Timeline canvas must have a parent element");
    for (let index = 0; index < this.priceRows.length; index++) {
      const row = this.priceRows[index]!;
      const root = document.createElement("div");
      root.className = "timeline-price-header";
      root.title = "Drag this heatmap vertically to move through its fixed scale field";
      const label = document.createElement("span");
      label.textContent = row.label;
      root.append(label);
      const palette = document.createElement("button");
      palette.type = "button";
      palette.className = "timeline-price-palette";
      palette.title = `Change ${row.label} color map`;
      palette.setAttribute("aria-label", `Change ${row.label} color map`);
      palette.setAttribute("aria-haspopup", "listbox");
      palette.setAttribute("aria-expanded", "false");
      const paletteBar = document.createElement("span");
      paletteBar.className = "timeline-price-palette-bar";
      paletteBar.style.backgroundImage = paletteCssGradient(this.rowPalettes[index]!);
      const caret = document.createElement("span");
      caret.className = "timeline-price-palette-caret";
      caret.textContent = "▾";
      caret.setAttribute("aria-hidden", "true");
      palette.append(paletteBar, caret);
      const paletteMenu = document.createElement("div");
      paletteMenu.className = "timeline-price-palette-menu";
      paletteMenu.setAttribute("role", "listbox");
      paletteMenu.setAttribute("aria-label", `${row.label} color maps`);
      paletteMenu.hidden = true;
      for (const name of Object.keys(PALETTES) as PaletteName[]) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "timeline-price-palette-option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-label", name);
        option.setAttribute("aria-selected", String(name === this.rowPalettes[index]));
        const optionBar = document.createElement("span");
        optionBar.className = "timeline-price-palette-option-bar";
        optionBar.style.backgroundImage = paletteCssGradient(name);
        option.append(optionBar);
        option.addEventListener("click", (event) => {
          event.stopPropagation();
          this.setRowPalette(index, name);
          this.closePaletteMenus();
        });
        paletteMenu.append(option);
      }
      palette.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = paletteMenu.hidden;
        this.closePaletteMenus();
        paletteMenu.hidden = !willOpen;
        palette.setAttribute("aria-expanded", String(willOpen));
        root.classList.toggle("palette-open", willOpen);
      });
      palette.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        this.closePaletteMenus();
        palette.focus();
      });
      root.append(palette, paletteMenu);
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
      parent.append(root);
      this.rowChrome.set(row.id, { root, palette, paletteBar, paletteMenu });
    }
  }

  private positionRowChrome(row: PriceRow, rowY: number): void {
    const chrome = this.rowChrome.get(row.id);
    if (chrome === undefined) return;
    chrome.root.style.transform = `translate3d(5px, ${rowY + 5}px, 0)`;
    const index = this.priceRows.indexOf(row);
    if (index >= 0) chrome.root.dataset.verticalOffset = String(this.rowVerticalOffsets[index]);
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
    if (!(this.plot.cssWidth > 0) || !(this.plot.cssHeight > 0)) return;
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
      const verticalOffset = clampHeatmapOffset(this.rowVerticalOffsets[index]!, heatHeight);
      if (verticalOffset !== this.rowVerticalOffsets[index]) {
        this.rowVerticalOffsets[index] = verticalOffset;
        row.onVerticalOffsetChange?.(verticalOffset);
      }
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
        verticalOffset,
        this.rowPalettes[index]!,
      );
      frame.resolution().draw(result.resolution, result.targetResolutionMs, rowY + heatHeight);
      this.positionRowChrome(row, rowY);
      rowY += rowHeight;
      frame.fillRectPx(0, rowY - 1, width, 1, "rgba(255,255,255,0.18)");
    }
    this.updateCrosshairOverlay();
    this.drawPriceHoverTooltips(frame);

    // The only time axis lives on the news/price boundary.
    frame.fillRectPx(0, this.state.newsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.state.newsHeight, this.config.minTickPx);
    this.drawResizeHandles(frame);
    this.updateNowLine(timePerPx);
  };

  private updateCrosshairOverlay(): void {
    if (
      !this.pointerInside ||
      this.dragging ||
      this.resizingBoundary !== null ||
      this.latestNumPx <= 0 ||
      this.boundaryAt(this.pointerPy) !== null
    ) {
      this.hideCrosshair();
      return;
    }

    const width = this.plot.cssWidth;
    if (!(width > 0)) {
      this.hideCrosshair();
      return;
    }
    const x = Math.max(0, Math.min(width, this.pointerPx));
    this.hoverLine.hidden = false;
    this.hoverLine.style.transform = `translate3d(${x - 0.5}px, 0, 0)`;
    const hoverTime =
      this.state.timeRange.min +
      (x / width) * (this.state.timeRange.max - this.state.timeRange.min);
    this.timeHover.textContent = formatHoverTime(hoverTime);
    this.timeHover.hidden = false;
    const timeWidth = this.timeHover.offsetWidth;
    const timeX = x + timeWidth + 18 <= width ? x + 9 : Math.max(5, x - timeWidth - 9);
    this.timeHover.style.transform = `translate3d(${timeX}px, 10px, 0)`;
  }

  private drawPriceHoverTooltips(frame: Frame): void {
    if (
      !this.pointerInside ||
      this.dragging ||
      this.resizingBoundary !== null ||
      this.latestNumPx <= 0 ||
      this.boundaryAt(this.pointerPy) !== null
    ) {
      return;
    }

    const x = Math.max(0, Math.min(frame.width, this.pointerPx));
    const deviceX = Math.max(0, Math.min(this.latestNumPx, Math.floor(x * this.latestDpr)));
    const sampleIndex = this.latestPadLeft + deviceX;
    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.priceRows.length; index++) {
      const rowHeight = this.rowHeights[index]!;
      const heatHeight = Math.max(2, rowHeight - RESOLUTION_BAR_HEIGHT);
      const logPrice = this.latestPriceValues[index]?.[sampleIndex];
      const text =
        logPrice !== undefined && Number.isFinite(logPrice)
          ? formatPrice(Math.exp(logPrice))
          : "loading…";
      drawPriceTooltip(frame, x, rowY + heatHeight / 2, text);
      rowY += rowHeight;
    }
  }

  private hideCrosshair(): void {
    this.hoverLine.hidden = true;
    this.timeHover.hidden = true;
  }

  private setRowPalette(index: number, palette: PaletteName): void {
    this.rowPalettes[index] = palette;
    const row = this.priceRows[index];
    if (row !== undefined) {
      const chrome = this.rowChrome.get(row.id);
      if (chrome !== undefined) {
        chrome.paletteBar.style.backgroundImage = paletteCssGradient(palette);
        for (const option of chrome.paletteMenu.querySelectorAll<HTMLElement>(
          ".timeline-price-palette-option",
        )) {
          option.setAttribute(
            "aria-selected",
            String(option.getAttribute("aria-label") === palette),
          );
        }
      }
      row.onPaletteChange?.(palette);
    }
    this.reqDraw();
  }

  private closePaletteMenus(): void {
    for (const chrome of this.rowChrome.values()) {
      chrome.paletteMenu.hidden = true;
      chrome.palette.setAttribute("aria-expanded", "false");
      chrome.root.classList.remove("palette-open");
    }
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

  private rowAt(y: number): number | null {
    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.rowHeights.length; index++) {
      const nextY = rowY + this.rowHeights[index]!;
      if (y >= rowY && y < nextY - RESOLUTION_BAR_HEIGHT) return index;
      rowY = nextY;
    }
    return null;
  }

  private panRowVertically(index: number | null, delta: number): void {
    if (index === null || delta === 0) return;
    const viewportHeight = Math.max(2, this.rowHeights[index]! - RESOLUTION_BAR_HEIGHT);
    const next = clampHeatmapOffset(this.rowVerticalOffsets[index]! + delta, viewportHeight);
    if (next === this.rowVerticalOffsets[index]) return;
    this.rowVerticalOffsets[index] = next;
    this.priceRows[index]?.onVerticalOffsetChange?.(next);
    this.reqDraw();
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
    this.crosshairPinned = false;
    this.hideCrosshair();
    this.reqDraw();
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
      this.verticalPanRow = null;
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
    this.lastY = this.pointerPy;
    this.verticalPanRow = this.rowAt(this.pointerPy);
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
    this.updatePointer(event);
    const dx = event.clientX - this.lastX;
    const dy = this.pointerPy - this.lastY;
    this.lastX = event.clientX;
    this.lastY = this.pointerPy;
    this.markGestureMoved(event.clientX, event.clientY);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const span = this.state.timeRange.max - this.state.timeRange.min;
    if (dx !== 0) this.setTimeRange(Range.pan(this.state.timeRange, -(dx / rect.width) * span));
    this.panRowVertically(this.verticalPanRow, dy);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchEnd(event);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragging = false;
    this.resizingBoundary = null;
    this.verticalPanRow = null;
    this.dragPointerId = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.updatePointer(event);
    this.updateCrosshairOverlay();
    this.reqDraw();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchEnd(event, true);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = null;
    this.dragging = false;
    this.resizingBoundary = null;
    this.verticalPanRow = null;
    this.hideCrosshair();
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
    this.updateCrosshairOverlay();
    if (this.dragging || this.resizingBoundary !== null) return;
    this.updateHoverAtCurrentTransform();
    this.reqDraw();
  };

  private onHoverLeave = (): void => {
    if (this.crosshairPinned) return;
    this.pointerInside = false;
    this.hideCrosshair();
    if (!this.dragging && this.resizingBoundary === null) this.clearHover();
    this.reqDraw();
  };

  private onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".timeline-price-palette, .timeline-price-palette-menu") !== null
    ) {
      return;
    }
    this.closePaletteMenus();
  };

  private onClick = (event: PointerEvent): void => {
    if (this.gestureMoved) {
      this.gestureMoved = false;
      return;
    }
    this.updatePointer(event);
    this.crosshairPinned = true;
    if (this.updateHoverAtCurrentTransform()) this.reqDraw();
    this.updateCrosshairOverlay();
    this.reqDraw();
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
        this.verticalPanRow = null;
        this.lastY = this.pointerPy;
        this.canvas.style.cursor = "ns-resize";
      } else {
        this.resizingBoundary = null;
        this.verticalPanRow = this.rowAt(this.pointerPy);
        this.lastY = this.pointerPy;
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
        const previousCenterY = (previousAY + previousBY) / 2;
        const currentCenterY = (this.touchAY + this.touchBY) / 2;
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
        if (rect.height > 0) {
          this.panRowVertically(
            this.verticalPanRow,
            (currentCenterY - previousCenterY) * (this.plot.cssHeight / rect.height),
          );
        }
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
      if (dx !== 0) this.setTimeRange(Range.pan(this.state.timeRange, -(dx / rect.width) * span));
      if (rect.height > 0) {
        this.panRowVertically(
          this.verticalPanRow,
          (this.touchAY - previousAY) * (this.plot.cssHeight / rect.height),
        );
      }
    }
    this.markGestureMoved(event.clientX, event.clientY);
    event.preventDefault();
  }

  private onTouchEnd(event: PointerEvent, cancelled = false): void {
    this.updatePointer(event);
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
      this.verticalPanRow = null;
      this.crosshairPinned = !cancelled && this.pointerInside;
      this.canvas.style.cursor = "";
    } else {
      this.dragging = true;
      this.gestureStartX = this.touchAX;
      this.gestureStartY = this.touchAY;
    }
    if (cancelled) {
      this.pointerInside = false;
      this.hideCrosshair();
      this.clearHover();
    } else if (this.touchAId === null) {
      this.updateCrosshairOverlay();
      this.updateHoverAtCurrentTransform();
    }
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
        ? nearestEventIndex(this.state.events, tx, this.pointerPx)
        : null;
    this.state.hovered = index;
    if (index === null) {
      this.clearHover();
      return previous !== null;
    }

    const event = this.eventAt(index);
    const anchorX = Math.max(0, Math.min(width, this.pointerPx));
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

const HOVER_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function formatHoverTime(time: number): string {
  return HOVER_TIME_FORMAT.format(new Date(time));
}

function drawPriceTooltip(frame: Frame, anchorX: number, anchorY: number, text: string): void {
  const ctx = frame.ctx;
  const font = "600 11px ui-monospace, monospace";
  const paddingX = 7;
  const height = 23;
  const gap = 9;
  const margin = 5;
  ctx.save();
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + paddingX * 2;
  const left =
    anchorX + gap + width <= frame.width - margin
      ? anchorX + gap
      : Math.max(margin, anchorX - gap - width);
  const top = Math.max(margin, Math.min(frame.height - height - margin, anchorY - height / 2));

  ctx.strokeStyle = "rgba(226, 232, 240, 0.58)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(left > anchorX ? left : left + width, anchorY);
  ctx.stroke();

  roundedRectPath(ctx, left, top, width, height, 5);
  ctx.fillStyle = "rgba(5, 7, 13, 0.94)";
  ctx.fill();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.62)";
  ctx.stroke();
  ctx.fillStyle = "#f8fafc";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, left + paddingX, top + height / 2);
  ctx.beginPath();
  ctx.arc(anchorX, anchorY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#f8fafc";
  ctx.fill();
  ctx.restore();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
