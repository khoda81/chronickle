/**
 * Timeline controller.
 *
 * Owns the canvas, the render loop (requestAnimationFrame), and the input
 * handlers (pan via drag, zoom via wheel, hover/click on event nodes).
 *
 * State model (minimal mutation):
 *  - `timeRange`: the only mutable view state, replaced wholesale on pan/zoom.
 *  - `hovered`: event index under cursor, or null.
 *  - `series` / `events`: immutable data references, swapped by the app.
 *
 * The render loop runs continuously but only redraws when `dirty` is set,
 * avoiding wasted work when idle. Panning sets dirty every frame. Drawing is
 * driven through the `Plot`'s disposable `Frame` (immediate mode).
 *
 * DPR: the canvas backing store is resized to `cssSize * dpr` on resize, but
 * the DPR-scaled ctx transform is applied per-frame by `Frame` (not here), so
 * it can never be lost across nested save/restore.
 *
 * Wheel: `deltaY` is normalized to pixels across `deltaMode`s (pixels, lines,
 * pages) before being mapped to a zoom factor. Lines use the CSS line height.
 */

import { PriceSeries } from "../domain.ts";
import type { EventSet, NewsEvent } from "../domain.ts";
import { Range } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { Plot } from "./plot.ts";
import { hitTestEvent } from "./hittest.ts";
import { setRampPalette } from "./ramp.ts";

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly source: string;
  readonly t: number;
  /** Cursor x in canvas-relative CSS pixels. */
  readonly px: number;
  /** Cursor y in canvas-relative CSS pixels. */
  readonly py: number;
}

export interface TimelineCallbacks {
  /** Called when the user hovers an event (or leaves it). */
  onHover?: (event: HoverInfo | null) => void;
}

export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialTimeRange: Range;
  readonly callbacks?: TimelineCallbacks;
}

interface TimelineState {
  series: PriceSeries;
  events: EventSet;
  timeRange: Range;
  // TODO: Maybe this should be in the transform state instead?
  priceScale: number;
  hovered: number | null;
  // TODO: Instead of a dirty flag, just request a draw using requestAnimationFrame
  dirty: boolean;
}

const EMPTY_EVENTS: EventSet = { events: [] };

/** CSS line height used to normalize wheel `deltaMode: 1` (lines). */
const WHEEL_LINE_HEIGHT = 16;
/** Zoom sensitivity per normalized pixel of wheel delta. */
const WHEEL_SENSITIVITY = 0.003;
/** Time scroll sensitivity per normalized pixel of wheel delta. */
const TIMESCROLL_SENSITIVITY = 3;

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private state: TimelineState;
  private rafId: number | null = null;

  // Pan scratch (no allocation in handlers).
  private dragging = false;
  private lastX = 0;

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    this.plot = new Plot({
      canvas: opts.canvas,
      initialTimeRange: opts.initialTimeRange,
    });
    this.callbacks = opts.callbacks ?? {};
    this.state = {
      series: PriceSeries.EMPTY,
      events: EMPTY_EVENTS,
      timeRange: opts.initialTimeRange,
      priceScale: 19,
      hovered: null,
      dirty: true,
    };

    this.bindEvents();
    this.resize();
    this.loop();
  }

  /** Replace the price series. Triggers a redraw. */
  setSeries(series: PriceSeries): void {
    this.state = { ...this.state, series, dirty: true };
  }

  /** Replace the event set. Triggers a redraw. */
  setEvents(events: EventSet): void {
    this.state = { ...this.state, events, hovered: null, dirty: true };
  }

  /** Replace the visible time range (e.g. fit-to-data). Triggers a redraw. */
  setTimeRange(r: Range): void {
    this.state = { ...this.state, timeRange: r, dirty: true };
    this.plot.setTimeRange(r);
  }

  /** Switch the heatmap color palette by name. Triggers a redraw. */
  setPalette(name: string): void {
    setRampPalette(name);
    this.state = { ...this.state, dirty: true };
  }

  /** Stop the render loop and detach listeners. */
  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.unbindEvents();
  }

  // --- internals ---

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
    const dpr = window.devicePixelRatio || 1;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    // Note: no setTransform here — the Frame applies the DPR transform per
    // draw, so it can never be lost across save/restore.
    this.state = { ...this.state, dirty: true };
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (!this.state.dirty) return;
    this.state = { ...this.state, dirty: false };

    using frame = this.plot.beginFrame();
    const { series, events, hovered, priceScale } = this.state;

    // Background.
    frame.fillRectPx(0, 0, frame.width, frame.height, "#05070d");

    // Layers.
    const heat = frame.heatmap();
    heat.drawBoxStack(series, priceScale);
    // heat.drawFadeOverlay();
    frame.events().drawRow(events, hovered);
    frame.axis().drawTimeAxis();
  };

  private onResize = (): void => this.resize();

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    this.lastX = e.clientX;
    const width = this.plot.cssWidth;
    if (width <= 0) return;
    const span = this.state.timeRange.max - this.state.timeRange.min;
    const dtMs = (dx / width) * span;
    this.setTimeRange(Range.pan(this.state.timeRange, -dtMs));
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const width = this.plot.cssWidth;
    if (width <= 0) return;

    // Normalize deltaY to pixels across deltaModes.
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= WHEEL_LINE_HEIGHT;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= this.plot.cssHeight;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) dy *= 1;

    // Apply horizontal scrolling
    if (width > 0) {
      const span = this.state.timeRange.max - this.state.timeRange.min;
      const dt = (TIMESCROLL_SENSITIVITY * (span * e.deltaX)) / width;
      this.setTimeRange(Range.pan(this.state.timeRange, dt));
      this.state.dirty = true;
    }

    if (e.shiftKey) {
      this.state.priceScale -= dy * WHEEL_SENSITIVITY;
      this.state.dirty = true;
      return;
    }
    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, width),
      Range.create(0, this.plot.cssHeight),
    );
    const tFocus = tx.xToTime(px);
    const factor = Math.exp(-dy * WHEEL_SENSITIVITY);
    this.setTimeRange(Range.zoom(this.state.timeRange, tFocus, factor));
  };

  private onHoverMove = (e: PointerEvent): void => {
    if (this.dragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (width <= 0 || height <= 0) return;

    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, width),
      Range.create(0, height),
    );
    const idx = hitTestEvent(this.state.events, tx, px, py);
    if (idx !== this.state.hovered) {
      this.state = { ...this.state, hovered: idx, dirty: true };
      this.fireHover(idx, px, py);
    }
  };

  private onClick = (_e: PointerEvent): void => {
    if (this.state.hovered === null) return;
    const ev = this.eventAt(this.state.hovered);
    window.open(ev.link, "_blank", "noopener,noreferrer");
  };

  private eventAt(i: number): NewsEvent {
    const e = this.state.events.events[i];
    if (e === undefined) {
      throw new Error(`Event index out of range: ${i}`);
    }
    return e;
  }

  private fireHover(idx: number | null, px: number, py: number): void {
    if (!this.callbacks.onHover) return;
    if (idx === null) {
      this.callbacks.onHover(null);
      return;
    }
    const ev = this.eventAt(idx);
    this.callbacks.onHover({
      index: idx,
      title: ev.title,
      link: ev.link,
      source: ev.source,
      t: ev.t,
      px,
      py,
    });
  }
}
