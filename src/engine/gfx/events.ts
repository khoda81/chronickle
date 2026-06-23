/**
 * Events L2 layer.
 *
 * Draws news-event nodes as dots on the event row, culling to the visible time
 * window. Hover styling is applied per-index.
 */

import type { EventSet } from "../../domain.ts";
import type { Frame } from "./context.ts";
import { eventRowY } from "./layout.ts";

const RADIUS = 5;
const HOVER_RADIUS = 8;
const NODE_FILL = "#7cc4ff";
const NODE_FILL_HOVER = "#ffffff";
const NODE_STROKE_HOVER = "#7cc4ff";

export interface EventLayer {
  /** Draw all visible events; `hovered` is the index to highlight, or null. */
  drawRow(events: EventSet, hovered: number | null): void;
}

export const Events = {
  create(frame: Frame): EventLayer {
    return new EventsImpl(frame);
  },
};

class EventsImpl implements EventLayer {
  constructor(private readonly frame: Frame) {}

  drawRow(events: EventSet, hovered: number | null): void {
    const { frame } = this;
    const { tx } = frame;
    if (events.events.length === 0) return;

    const height = tx.yDomain.max - tx.yDomain.min;
    const y = eventRowY(height);

    for (let i = 0; i < events.events.length; i++) {
      const e = events.events[i]!;
      if (!tx.containsTime(e.t)) continue;
      const isHover = i === hovered;
      frame.dotAt(
        e.t,
        y,
        isHover ? HOVER_RADIUS : RADIUS,
        isHover ? NODE_FILL_HOVER : NODE_FILL,
        isHover ? NODE_STROKE_HOVER : undefined,
        isHover ? 2 : undefined,
      );
    }
  }
}
