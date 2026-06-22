/**
 * Timeline controller.
 *
 * Owns the canvas, the render loop (requestAnimationFrame), and the input
 * handlers (pan via drag, zoom via wheel, hover/click on event nodes).
 *
 * State model (minimal mutation):
 *  - `viewport`: the only mutable field, replaced wholesale on pan/zoom.
 *  - `hovered`: event index under cursor, or null.
 *  - `series` / `events`: immutable data references, swapped by the app.
 *
 * The render loop runs continuously but only redraws when `dirty` is set,
 * avoiding wasted work when idle. Panning sets dirty every frame.
 */

import type { EventSet, HeatSeries } from "../domain.ts";
import { render, hitTestEvent, eventAt } from "./renderer.ts";
import { Viewport, xToTime } from "./viewport.ts";

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
  readonly initialViewport: Viewport;
  readonly callbacks?: TimelineCallbacks;
}

interface TimelineState {
  series: HeatSeries;
  events: EventSet;
  viewport: Viewport;
  hovered: number | null;
  dirty: boolean;
}

const EMPTY_SERIES: HeatSeries = { samples: [], dt: 1, maxDI: 0 };
const EMPTY_EVENTS: EventSet = { events: [] };

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: TimelineCallbacks;
  private state: TimelineState;
  private rafId: number | null = null;

  // Pan scratch (no allocation in handlers).
  private dragging = false;
  private lastX = 0;
  private dpr = 1;

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    this.callbacks = opts.callbacks ?? {};
    this.state = {
      series: EMPTY_SERIES,
      events: EMPTY_EVENTS,
      viewport: opts.initialViewport,
      hovered: null,
      dirty: true,
    };

    this.bindEvents();
    this.resize();
    this.loop();
  }

  /** Replace the heatmap series. Triggers a redraw. */
  setSeries(series: HeatSeries): void {
    this.state = { ...this.state, series, dirty: true };
  }

  /** Replace the event set. Triggers a redraw. */
  setEvents(events: EventSet): void {
    this.state = { ...this.state, events, hovered: null, dirty: true };
  }

  /** Replace the viewport (e.g. fit-to-data). Triggers a redraw. */
  setViewport(viewport: Viewport): void {
    this.state = { ...this.state, viewport, dirty: true };
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
    this.dpr = dpr;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.state = { ...this.state, dirty: true };
  }

  private get cssWidth(): number {
    return this.canvas.width / this.dpr;
  }
  private get cssHeight(): number {
    return this.canvas.height / this.dpr;
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (!this.state.dirty) return;
    this.state = { ...this.state, dirty: false };
    render({
      ctx: this.ctx,
      width: this.cssWidth,
      height: this.cssHeight,
      viewport: this.state.viewport,
      series: this.state.series,
      events: this.state.events,
      hovered: this.state.hovered,
    });
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
    const width = this.cssWidth;
    if (width <= 0) return;
    const dtMs =
      (dx / width) * (this.state.viewport.tEnd - this.state.viewport.tStart);
    this.state = {
      ...this.state,
      viewport: Viewport.pan(this.state.viewport, -dtMs),
      dirty: true,
    };
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const width = this.cssWidth;
    if (width <= 0) return;
    const tFocus = xToTime(this.state.viewport, width, px);
    // Smooth zoom: deltaY -> factor. Negative deltaY (scroll up) zooms in.
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.state = {
      ...this.state,
      viewport: Viewport.zoom(this.state.viewport, tFocus, factor),
      dirty: true,
    };
  };

  private onHoverMove = (e: PointerEvent): void => {
    if (this.dragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const idx = hitTestEvent(
      this.state.events,
      this.state.viewport,
      this.cssWidth,
      px,
      py,
    );
    if (idx !== this.state.hovered) {
      this.state = { ...this.state, hovered: idx, dirty: true };
      this.fireHover(idx, px, py);
    }
  };

  private onClick = (e: PointerEvent): void => {
    if (this.state.hovered === null) return;
    const ev = eventAt(this.state.events, this.state.hovered);
    window.open(ev.link, "_blank", "noopener,noreferrer");
  };

  private fireHover(idx: number | null, px: number, py: number): void {
    if (!this.callbacks.onHover) return;
    if (idx === null) {
      this.callbacks.onHover(null);
      return;
    }
    const ev = eventAt(this.state.events, idx);
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
