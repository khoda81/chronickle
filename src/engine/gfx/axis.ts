/**
 * Axis L2 layer.
 *
 * Draws a horizontal time axis with "nice" tick steps above the heatmap.
 * Tick step selection picks the smallest standard step that yields roughly
 * `targetTicks` across the visible span.
 */

import type { Frame } from "./context.ts";
import { axisY } from "./layout.ts";

const TICK_COLOR = "#2a2f3a";
const LABEL_COLOR = "#6b7280";
const LABEL_FONT = "11px ui-monospace, monospace";
const TARGET_TICKS = 8;

/** Candidate tick steps (ms), ascending. */
const NICE_STEPS: readonly number[] = [
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

export interface AxisLayer {
  drawTimeAxis(): void;
}

export const Axis = {
  create(frame: Frame): AxisLayer {
    return new AxisImpl(frame);
  },
};

class AxisImpl implements AxisLayer {
  constructor(private readonly frame: Frame) {}

  drawTimeAxis(): void {
    const { frame } = this;
    const { tx } = frame;
    const height = tx.yDomain.max - tx.yDomain.min;
    const y = axisY(height);
    const { min: tLo, max: tHi } = tx.timeDomain;

    const span = tHi - tLo;
    const step = niceStep(span / TARGET_TICKS);
    const firstTick = Math.ceil(tLo / step) * step;

    for (let t = firstTick; t <= tHi; t += step) {
      frame.vlineAt(t, y, y + 4, TICK_COLOR);
      frame.textAt(formatTime(t), t, y - 6, LABEL_FONT, LABEL_COLOR);
    }
  }
}
