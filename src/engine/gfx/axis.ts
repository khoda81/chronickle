/**
 * Axis L2 layer.
 *
 * Draws a horizontal time axis with calendar-correct ticks above the heatmap.
 *
 * Tick generation is delegated to d3-time's `timeTicks`, which picks a
 * calendar interval (second/minute/hour/day/week/month/year) and aligns ticks
 * to its boundaries — so month ticks land on month starts, year ticks on year
 * starts, and DST gaps are handled correctly. The number of ticks is derived
 * from a *minimum on-screen spacing* (`minTickPx`): we ask d3 for
 * `floor(spanPx / minPx)` ticks, which yields the most ticks that still
 * satisfy the spacing budget.
 *
 * Label formatting branches on the chosen interval (returned by
 * `timeTickInterval`): finer intervals show date + time (dropping the time at
 * local midnight), day/week intervals show just the date, month intervals
 * show `Mon YYYY`, and year intervals show `YYYY`. This avoids redundant
 * `00:00` / `01/01` noise at coarser steps and keeps the year visible when
 * zoomed out.
 */

import type { Frame } from "./context.ts";
import { timeTicks } from "d3-time";

const TICK_COLOR = "#2a2f3a";
const LABEL_COLOR = "#6b7280";
const LABEL_FONT = "11px ui-monospace, monospace";

/** Default minimum on-screen spacing between two consecutive ticks (CSS px). */
export const DEFAULT_MIN_TICK_PX = 256;

const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
});
const MONTH_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
});
const YEAR_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
});

/**
 * Format a tick timestamp for the chosen interval.
 *
 * - second/minute/hour: `mm/dd HH:MM` (or `mm/dd` at local midnight)
 * - day/week:           `mm/dd`
 * - month:              `Mon YYYY`  (day is always 1, so drop it; keep year)
 * - year:               `YYYY`
 * - null (ms-level):    full `mm/dd HH:MM`
 */
function formatTick(t: number): string {
  const d = new Date(t);
  if (d.getSeconds() !== 0) return TIME_FMT.format(t).replace(",", "");
  if (d.getMinutes() !== 0) return DATETIME_FMT.format(t).replace(",", "");
  if (d.getHours() !== 0) return DATETIME_FMT.format(t).replace(",", "");
  if (d.getDate() !== 1) return DATE_FMT.format(t).replace(",", "");
  if (d.getMonth() !== 0) return MONTH_FMT.format(t);

  return YEAR_FMT.format(t);
}

export interface AxisLayer {
  drawTimeAxis(y: number, minTickPx?: number): void;
}

export const Axis = {
  create(frame: Frame): AxisLayer {
    return new AxisImpl(frame);
  },
};

class AxisImpl implements AxisLayer {
  constructor(private readonly frame: Frame) { }

  drawTimeAxis(y: number, minTickPx: number = DEFAULT_MIN_TICK_PX): void {
    if (!(minTickPx > 0)) {
      throw new Error(`minTickPx must be positive, got ${minTickPx}`);
    }
    const { frame } = this;
    const { tx } = frame;
    const { min: tLo, max: tHi } = tx.timeDomain;
    const screenSpan = tx.screenDomain.max - tx.screenDomain.min;
    if (!(screenSpan > 0)) return;

    // Ask d3 for the most ticks that still respect the min spacing budget.
    // `timeTicks` clamps to a sensible interval regardless of the count.
    const count = Math.max(1, Math.floor(screenSpan / minTickPx));
    const start = new Date(tLo);
    const stop = new Date(tHi);
    const ticks = timeTicks(start, stop, count);

    for (const d of ticks) {
      const t = d.getTime();
      frame.vlineAt(t, y, y + 4, TICK_COLOR);
      frame.textAt(formatTick(t), t, y - 6, LABEL_FONT, LABEL_COLOR);
    }
  }
}
