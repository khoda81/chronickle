/**
 * Frame — the disposable per-frame immediate-mode drawing context.
 *
 * Built fresh each frame by `Plot.draw(...)`. It owns:
 *   - the underlying `CanvasRenderingContext2D` (exposed as `raw` for escape-
 *     hatch custom drawing — this is a deliberately leaky abstraction),
 *   - the `DataTransform` mapping time/screen/y domains for this frame,
 *   - a managed `save/restore` stack (depth-tracked for fail-fast balance
 *     checks on dispose),
 *   - access to L2 domain layers via `frame.signalRows()`, `frame.heatmap()`,
 *     `frame.events()`, and `frame.axis()` (constructed per call and bound to
 *     this frame).
 *
 * DPR handling: the constructor saves the current ctx transform, then applies
 * `setTransform(dpr, 0, 0, dpr, 0, 0)` so the entire frame draws in CSS pixels
 * at device resolution. `dispose()` restores the prior transform. This fixes
 * the previous bug where DPR was set only in `resize()` and could be lost
 * across nested save/restore.
 *
 * GC discipline: the frame itself is the only per-frame allocation. L2 layers
 * are tiny bound objects (one per call), while row-owned rendering resources
 * retain the hot-path typed arrays.
 */

import type { DataTransform } from "../transform.ts";
import type { HeatmapLayer } from "./heatmap.ts";
import type { EventLayer } from "./events.ts";
import type { AxisLayer } from "./axis.ts";
import type { StatusBarLayer } from "./resolution.ts";
import type { SignalRowStack } from "./signalRow.ts";
import { Heatmap } from "./heatmap.ts";
import { Events } from "./events.ts";
import { Axis } from "./axis.ts";
import { StatusBar } from "./resolution.ts";
import { SignalRows } from "./signalRow.ts";

export class Frame implements Disposable {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly tx: DataTransform,
    readonly dpr: number,
  ) {
    // Establish a DPR-scaled identity for this frame. Any prior caller state
    // is preserved by the matching restore() in dispose().
    this.ctx.save();
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** CSS pixel width of the drawing surface (derived from the transform). */
  get width(): number {
    return this.tx.screenDomain.end - this.tx.screenDomain.start;
  }

  /** CSS pixel height of the drawing surface (derived from the transform). */
  get height(): number {
    return this.tx.yDomain.end - this.tx.yDomain.start;
  }

  /** Physical horizontal pixels available to time-domain rendering. */
  get deviceWidth(): number {
    return Math.max(0, Math.round(this.width * this.dpr));
  }

  // --- L1: pixel primitives ----------------------------------------------

  fillRectPx(x: number, y: number, w: number, h: number, fill: string): void {
    this.ctx.fillStyle = fill;
    this.ctx.fillRect(x, y, w, h);
  }

  clearRectPx(x: number, y: number, w: number, h: number): void {
    this.ctx.clearRect(x, y, w, h);
  }

  dot(x: number, y: number, r: number, fill: string, stroke?: string, strokeWidth = 1): void {
    const c = this.ctx;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    if (stroke !== undefined) {
      c.strokeStyle = stroke;
      c.lineWidth = strokeWidth;
      c.stroke();
    }
  }

  vline(x: number, y0: number, y1: number, stroke: string, width = 1): void {
    const c = this.ctx;
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(x, y0);
    c.lineTo(x, y1);
    c.stroke();
  }

  text(
    str: string,
    x: number,
    y: number,
    font: string,
    fill: string,
    align: CanvasTextAlign = "left",
    baseline: CanvasTextBaseline = "alphabetic",
  ): void {
    const c = this.ctx;
    c.font = font;
    c.fillStyle = fill;
    c.textAlign = align;
    c.textBaseline = baseline;
    c.fillText(str, x, y);
  }

  // --- L1: time-aware primitives (use the transform) ---------------------

  /** Fill a vertical strip spanning time [t0, t1] at vertical [y, y+h]. */
  fillTimeRect(t0: number, t1: number, y: number, h: number, fill: string): void {
    const x0 = this.tx.timeToX(t0);
    const x1 = this.tx.timeToX(t1);
    this.fillRectPx(x0, y, x1 - x0, h, fill);
  }

  /** Vertical line at time `t`. */
  vlineAt(t: number, y0: number, y1: number, stroke: string, width = 1): void {
    this.vline(this.tx.timeToX(t), y0, y1, stroke, width);
  }

  /** Dot at time `t`, screen y. */
  dotAt(
    t: number,
    y: number,
    r: number,
    fill: string,
    stroke?: string,
    strokeWidth?: number,
  ): void {
    this.dot(this.tx.timeToX(t), y, r, fill, stroke, strokeWidth);
  }

  /** Text centered at time `t`, screen y. */
  textAt(
    str: string,
    t: number,
    y: number,
    font: string,
    fill: string,
    baseline: CanvasTextBaseline = "alphabetic",
  ): void {
    this.text(str, this.tx.timeToX(t), y, font, fill, "center", baseline);
  }

  // --- L2: domain layers (constructed per call, stateless) ----------------

  heatmap(rowId: string): HeatmapLayer {
    return Heatmap.create(this, rowId);
  }

  events(): EventLayer {
    return Events.create(this);
  }

  axis(): AxisLayer {
    return Axis.create(this);
  }

  statusBar(): StatusBarLayer {
    return StatusBar.create(this);
  }

  /** Create a vertically advancing cursor for a contiguous stack of signal rows. */
  signalRows(top: number): SignalRowStack {
    return SignalRows.stack(this, top);
  }

  /** Draw the time axis with an explicit minimum tick spacing (CSS px). */
  drawTimeAxis(y: number, minTickPx?: number): void {
    this.axis().drawTimeAxis(y, minTickPx);
  }

  // --- lifecycle ---------------------------------------------------------

  [Symbol.dispose](): void {
    // Restore to the pre-frame transform. We always opened one save() in the
    // constructor; any unmatched push() is a programmer error.
    this.ctx.restore();
  }
}
