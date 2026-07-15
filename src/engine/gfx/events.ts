/**
 * Events L2 layer.
 *
 * Draws news-event nodes as dots on the event row, culling to the visible time
 * window. Each dot is colored by its feed's identity color (resolved via the
 * `colorOf` callback); hover grows the node and adds a pale focus ring.
 */

import type { EventSet } from "../../domain.ts";
import type { Frame } from "./context.ts";

const RADIUS = 5;
const HOVER_RADIUS = 8;
const HOVER_STROKE_WIDTH = 2;

export interface EventLayer {
  /**
   * Draw all visible events; `hovered` is the index to highlight, or null.
   * `colorOf` resolves a feedId to its color string (oklch or otherwise).
   */
  drawRow(
    events: EventSet,
    colorOf: (feedId: string) => string,
    hovered: number | null,
    y: number,
  ): void;
}

export const Events = {
  create(frame: Frame): EventLayer {
    return new EventsImpl(frame);
  },
};

class EventsImpl implements EventLayer {
  constructor(private readonly frame: Frame) {}

  drawRow(
    events: EventSet,
    colorOf: (feedId: string) => string,
    hovered: number | null,
    y: number,
  ): void {
    const { frame } = this;
    const { tx } = frame;
    if (events.events.length === 0) return;

    for (let i = 0; i < events.events.length; i++) {
      const e = events.events[i]!;
      if (!tx.containsTime(e.t)) continue;
      const isHover = i === hovered;
      const fill = colorOf(e.feedId);
      frame.dotAt(
        e.t,
        y,
        isHover ? HOVER_RADIUS : RADIUS,
        fill,
        // The DOM tooltip redraws this outlet-colored node at the card origin.
        // A pale ring keeps the canvas marker legible during the transition.
        isHover ? "rgba(255,255,255,0.9)" : undefined,
        isHover ? HOVER_STROKE_WIDTH : undefined,
      );
    }
  }
}
