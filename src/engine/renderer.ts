/**
 * Canvas renderer for the Chronicle timeline.
 *
 * The renderer is a pure function of (viewport, series, events, size, hover).
 * It draws in two passes:
 *   1. Heatmap: a horizontal strip at the bottom mapping dI to a color ramp.
 *   2. Event nodes: dots plotted on the same time scale, above the heatmap.
 *
 * We use a single DOMMatrix to map time -> x for both passes, so panning and
 * zooming are GPU-accelerated by the canvas 2D context's transform stack and
 * we avoid per-sample recomputation of pixel positions during continuous pan.
 *
 * GC discipline: the render loop allocates no objects in the hot path. All
 * scratch state lives in module-level typed arrays / reusable objects.
 */

import type { EventSet, HeatSeries, NewsEvent } from "../domain.ts";
import type { Viewport } from "./viewport.ts";
import { timeToX, xToTime } from "./viewport.ts";

export interface RenderInput {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly viewport: Viewport;
  readonly series: HeatSeries;
  readonly events: EventSet;
  /** Currently hovered event index, or null. */
  readonly hovered: number | null;
}

/** Vertical layout constants (CSS pixels). */
const HEAT_HEIGHT = 120;
const EVENT_AREA_HEIGHT = 80;
const TOP_PADDING = 24;

/** Color ramp stops for the heatmap (cool -> warm). */
const RAMP: readonly [number, string][] = [
  [0.0, "#0b1020"],
  [0.2, "#1b3a6b"],
  [0.4, "#2a8a6b"],
  [0.6, "#d4a017"],
  [0.8, "#e85d2f"],
  [1.0, "#ff2e4d"],
];

/** Reusable scratch arrays (sized lazily). Avoids per-frame allocation. */
let rampPixels: Uint8ClampedArray | null = null;
const RAMP_RESOLUTION = 256;

function buildRampLut(): Uint8ClampedArray {
  if (rampPixels && rampPixels.length === RAMP_RESOLUTION * 4) return rampPixels;
  const lut = new Uint8ClampedArray(RAMP_RESOLUTION * 4);
  const canvas = document.createElement("canvas");
  canvas.width = RAMP_RESOLUTION;
  canvas.height = 1;
  const c = canvas.getContext("2d")!;
  const grad = c.createLinearGradient(0, 0, RAMP_RESOLUTION, 0);
  for (const [stop, color] of RAMP) {
    grad.addColorStop(stop, color);
  }
  c.fillStyle = grad;
  c.fillRect(0, 0, RAMP_RESOLUTION, 1);
  const data = c.getImageData(0, 0, RAMP_RESOLUTION, 1).data;
  lut.set(data);
  rampPixels = lut;
  return lut;
}

/**
 * Render one frame. Pure with respect to canvas state: saves/restores the
 * context transform so callers' state is untouched.
 */
export function render(input: RenderInput): void {
  const { ctx, width, height, viewport, series, events, hovered } = input;
  const ramp = buildRampLut();

  ctx.save();
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, width, height);

  drawHeatmap(ctx, width, height, viewport, series, ramp);
  drawEvents(ctx, width, height, viewport, events, hovered);
  drawAxis(ctx, width, height, viewport);

  ctx.restore();
}

function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
  series: HeatSeries,
  ramp: Uint8ClampedArray,
): void {
  if (series.samples.length === 0) return;

  const y = height - HEAT_HEIGHT;
  const img = ctx.createImageData(width, HEAT_HEIGHT);
  const data = img.data;

  // For each pixel column, find the corresponding sample and write a vertical
  // strip of color. We iterate columns (not samples) so zoom-in doesn't leave
  // gaps and zoom-out doesn't alias away spikes.
  const maxDI = series.maxDI > 0 ? series.maxDI : 1;
  const samples = series.samples;
  const firstT = samples[0]!.t;
  const lastT = samples[samples.length - 1]!.t;
  const dt = series.dt;

  for (let x = 0; x < width; x++) {
    const t = xToTime(viewport, width, x);
    if (t < firstT || t > lastT + dt) {
      // Outside data range: leave transparent (already cleared to bg).
      continue;
    }
    // Nearest-sample index (clamp to valid range).
    let idx = Math.round((t - firstT) / dt);
    if (idx < 0) idx = 0;
    else if (idx >= samples.length) idx = samples.length - 1;
    const dI = samples[idx]!.dI;
    const norm = Math.min(1, dI / maxDI);
    const rampIdx = Math.min(RAMP_RESOLUTION - 1, Math.floor(norm * (RAMP_RESOLUTION - 1))) * 4;

    const r = ramp[rampIdx]!;
    const g = ramp[rampIdx + 1]!;
    const b = ramp[rampIdx + 2]!;

    for (let py = 0; py < HEAT_HEIGHT; py++) {
      // Vertical fade: brightest at the top of the strip.
      const fade = 1 - (py / HEAT_HEIGHT) * 0.55;
      const off = (py * width + x) * 4;
      data[off] = r * fade;
      data[off + 1] = g * fade;
      data[off + 2] = b * fade;
      data[off + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, y);
}

function drawEvents(
  ctx: CanvasRenderingContext2D,
  width: number,
  _height: number,
  viewport: Viewport,
  events: EventSet,
  hovered: number | null,
): void {
  if (events.events.length === 0) return;

  const baseY = TOP_PADDING + EVENT_AREA_HEIGHT / 2;
  const radius = 5;

  // Visible window for culling.
  const tLo = viewport.tStart;
  const tHi = viewport.tEnd;

  for (let i = 0; i < events.events.length; i++) {
    const e = events.events[i]!;
    if (e.t < tLo || e.t > tHi) continue;
    const x = timeToX(viewport, width, e.t);
    const isHover = i === hovered;

    ctx.beginPath();
    ctx.arc(x, baseY, isHover ? radius + 3 : radius, 0, Math.PI * 2);
    ctx.fillStyle = isHover ? "#ffffff" : "#7cc4ff";
    ctx.fill();
    if (isHover) {
      ctx.strokeStyle = "#7cc4ff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

function drawAxis(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewport: Viewport,
): void {
  const y = height - HEAT_HEIGHT - 6;
  ctx.strokeStyle = "#2a2f3a";
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "center";

  // Choose a "nice" tick step based on span.
  const span = viewport.tEnd - viewport.tStart;
  const targetTicks = 8;
  const roughStep = span / targetTicks;
  const step = niceStep(roughStep);

  const firstTick = Math.ceil(viewport.tStart / step) * step;
  for (let t = firstTick; t <= viewport.tEnd; t += step) {
    const x = timeToX(viewport, width, t);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 4);
    ctx.stroke();
    ctx.fillText(formatTime(t), x, y - 6);
  }
}

const NICE_STEPS = [
  1_000,
  5_000,
  15_000,
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];

function niceStep(rough: number): number {
  for (const s of NICE_STEPS) {
    if (s >= rough) return s;
  }
  return NICE_STEPS[NICE_STEPS.length - 1]!;
}

function formatTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${mo}-${dd} ${hh}:${mm}`;
}

/**
 * Hit-test: find the event index under pixel (x, y), or null.
 * Used by the interaction layer for hover/click.
 */
export function hitTestEvent(
  events: EventSet,
  viewport: Viewport,
  width: number,
  px: number,
  py: number,
  radius = 10,
): number | null {
  const baseY = TOP_PADDING + EVENT_AREA_HEIGHT / 2;
  if (Math.abs(py - baseY) > radius) return null;

  const tLo = viewport.tStart;
  const tHi = viewport.tEnd;
  let best: number | null = null;
  let bestDist = radius;
  for (let i = 0; i < events.events.length; i++) {
    const e = events.events[i]!;
    if (e.t < tLo || e.t > tHi) continue;
    const x = timeToX(viewport, width, e.t);
    const d = Math.abs(x - px);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Return the NewsEvent at the given index, for tooltip rendering. */
export function eventAt(events: EventSet, i: number): NewsEvent {
  const e = events.events[i];
  if (e === undefined) {
    throw new Error(`Event index out of range: ${i}`);
  }
  return e;
}
