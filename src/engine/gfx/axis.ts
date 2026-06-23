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

    // Offset at the start of the visible window (minutes, negated → ms).
    // Using tLo as the reference point is fine for spans shorter than a DST
    // transition (see note below).
    const offsetMs = -new Date(tLo).getTimezoneOffset() * 60_000;

    // Align to local-time epoch instead of UTC epoch.
    const firstTick = Math.ceil((tLo + offsetMs) / step) * step - offsetMs;

    for (let t = firstTick; t <= tHi; t += step) {
      frame.vlineAt(t, y, y + 4, TICK_COLOR);
      const formattedTime = Intl.DateTimeFormat("en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(t)
        .replace(",", "");
      frame.textAt(formattedTime, t, y - 6, LABEL_FONT, LABEL_COLOR);
    }
  }
}
