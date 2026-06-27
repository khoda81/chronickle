/**
 * Axis L2 layer.
 *
 * Draws a horizontal time axis with "nice" tick steps above the heatmap.
 *
 * Tick step selection is driven by a *minimum pixel distance* between
 * consecutive ticks (`minTickPx`, passed in at render time). Given the current
 * time→screen transform, we compute the smallest standard step whose on-screen
 * spacing still satisfies `minTickPx`. This keeps labels from overlapping at
 * any zoom level while showing as many ticks as the spacing budget allows.
 *
 * Label formatting: ticks that land exactly on local midnight render as just
 * the date (`mm/dd`); any other tick renders as `mm/dd HH:MM`. This avoids the
 * redundant `00:00` noise when the chosen step is a day or longer.
 */

import type { Frame } from "./context.ts";
import { axisY } from "./layout.ts";

const TICK_COLOR = "#2a2f3a";
const LABEL_COLOR = "#6b7280";
const LABEL_FONT = "11px ui-monospace, monospace";

/** Default minimum on-screen spacing between two consecutive ticks (CSS px). */
export const DEFAULT_MIN_TICK_PX = 128;

/** Candidate tick steps (ms), ascending. Must be sorted. */
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
  2 * 7 * 24 * 60 * 60_000,
  4 * 7 * 24 * 60 * 60_000,
  60 * 24 * 60 * 60_000,
  90 * 24 * 60 * 60_000,
  180 * 24 * 60 * 60_000,
  365 * 24 * 60 * 60_000,
];

/**
 * Pick the smallest nice step whose on-screen spacing is at least `minPx`,
 * given `msPerPx` (epoch ms per CSS pixel).
 *
 * `msPerPx * minPx` is the minimum step in ms. We walk the candidate list
 * ascending and return the first step that satisfies it. If none does
 * (extreme zoom-out), we fall back to the largest available step — labels
 * may then overlap, but that is the best we can do with the fixed ladder.
 */
function niceStepForSpacing(msPerPx: number, minPx: number): number {
  const minStepMs = msPerPx * minPx;
  for (const s of NICE_STEPS) {
    if (s >= minStepMs) return s;
  }
  return NICE_STEPS[NICE_STEPS.length - 1]!;
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  hour12: false,
});
const DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Format a tick timestamp: date-only at local midnight, else date + time. */
function formatTick(t: number): string {
  const d = new Date(t);
  if (d.getHours() === 0 && d.getMinutes() === 0) {
    return DATE_FMT.format(t);
  }
  return DATETIME_FMT.format(t).replace(",", "");
}

export interface AxisLayer {
  drawTimeAxis(minTickPx?: number): void;
}

export const Axis = {
  create(frame: Frame): AxisLayer {
    return new AxisImpl(frame);
  },
};

class AxisImpl implements AxisLayer {
  constructor(private readonly frame: Frame) {}

  drawTimeAxis(minTickPx: number = DEFAULT_MIN_TICK_PX): void {
    if (!(minTickPx > 0)) {
      throw new Error(`minTickPx must be positive, got ${minTickPx}`);
    }
    const { frame } = this;
    const { tx } = frame;
    const height = tx.yDomain.max - tx.yDomain.min;
    const y = axisY(height);
    const { min: tLo, max: tHi } = tx.timeDomain;
    const span = tHi - tLo;
    const screenSpan = tx.screenDomain.max - tx.screenDomain.min;
    const msPerPx = span / screenSpan;
    const step = niceStepForSpacing(msPerPx, minTickPx);

    // Offset at the start of the visible window (minutes, negated → ms).
    // Using tLo as the reference point is fine for spans shorter than a DST
    // transition (see note below).
    const offsetMs = -new Date(tLo).getTimezoneOffset() * 60_000;

    // Align to local-time epoch instead of UTC epoch.
    const firstTick = Math.ceil((tLo + offsetMs) / step) * step - offsetMs;

    for (let t = firstTick; t <= tHi; t += step) {
      frame.vlineAt(t, y, y + 4, TICK_COLOR);
      frame.textAt(formatTick(t), t, y - 6, LABEL_FONT, LABEL_COLOR);
    }
  }
}
