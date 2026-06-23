/**
 * Heatmap L2 layer.
 *
 * Draws the volatility heatmap as a stack of color boxes: the price series is
 * sampled at every pixel boundary, the per-pixel log-return rate is computed,
 * normalized against `series.maxRate`, and mapped through the color ramp.
 * Adjacent pixels sharing the same ramp index are coalesced into a single
 * `fillRect` run to minimize draw calls.
 *
 * The per-pixel price buffer is `frame.scratch` (owned by `Plot`, resized as
 * needed) — no per-frame allocation happens here.
 */

import type { PriceSeries } from "../../domain.ts";
import type { Frame } from "./context.ts";
import { HEAT_HEIGHT, heatTopY } from "./layout.ts";
import { rampLut, rampIndex, rampCss } from "../ramp.ts";

export interface HeatmapLayer {
  /** Draw the colored volatility strip. */
  drawBoxStack(series: PriceSeries): void;
  /** Draw the vertical fade overlay on top of the strip. */
  drawFadeOverlay(): void;
}

export const Heatmap = {
  create(frame: Frame): HeatmapLayer {
    return new HeatmapImpl(frame);
  },
};

class HeatmapImpl implements HeatmapLayer {
  constructor(private readonly frame: Frame) {}

  drawBoxStack(series: PriceSeries): void {
    const { frame } = this;
    const { tx, scratch, raw: ctx } = frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;
    const obs = series.observations;
    if (obs.length === 0 || width <= 0) return;

    const y = heatTopY(height);
    const maxRate = series.maxRate > 0 ? series.maxRate : 1;
    const first = obs[0]!;
    const last = obs[obs.length - 1]!;
    const prices = scratch;

    // Evaluate the piecewise-linear price function at every pixel boundary.
    // Merge two sorted sequences: pixel boundaries (monotonic in t) and
    // observations (monotonic in t). Clamp outside the data range.
    let oi = 0;
    for (let x = 0; x <= width; x++) {
      const t = tx.xToTime(x);
      while (oi + 1 < obs.length && obs[oi + 1]!.t <= t) oi++;
      const a = obs[oi]!;
      const b = obs[oi + 1];
      if (t <= a.t) {
        prices[x] = first.price;
      } else if (b === undefined || t >= b.t) {
        prices[x] = last.price;
      } else {
        const f = (t - a.t) / (b.t - a.t);
        prices[x] = a.price + (b.price - a.price) * f;
      }
    }

    // Per-pixel rate, coalescing identical adjacent ramp indices into runs.
    const ramp = rampLut();
    let currentIdx = -1;
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      let idx = -1;
      if (x < width) {
        const t0 = tx.xToTime(x);
        const t1 = tx.xToTime(x + 1);
        const dt = t1 - t0;
        const rate =
          dt > 0 ? Math.abs(Math.log(prices[x + 1]! / prices[x]!)) / dt : 0;
        idx = rampIndex(rate / maxRate);
      }
      if (idx !== currentIdx) {
        if (currentIdx >= 0 && runStart !== -1) {
          ctx.fillStyle = rampCss(ramp, currentIdx);
          ctx.fillRect(runStart, y, x - runStart, HEAT_HEIGHT);
        }
        currentIdx = idx;
        runStart = x;
      }
    }
  }

  drawFadeOverlay(): void {
    const { frame } = this;
    const { tx, raw: ctx } = frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;
    const y = heatTopY(height);
    const grad = ctx.createLinearGradient(0, y, 0, y + HEAT_HEIGHT);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, width, HEAT_HEIGHT);
  }
}
