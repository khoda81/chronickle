import type { TimelineOverlaySink } from "../../engine/timeline.ts";
import { TIMELINE_OVERLAY_METRICS } from "../../ui/timelineOverlayMetrics.ts";

export type TooltipPlacement = "left" | "right";

export interface TooltipPosition {
  readonly x: number;
  readonly y: number;
  readonly placement: TooltipPlacement;
}

export interface TooltipPlacementInput {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly gap?: number;
  readonly margin?: number;
}

/**
 * Place the event tooltip like a card pulled from a horizontal deck.
 *
 * The horizontal `gap` is intentionally an overlap rather than empty spacing:
 * the event dot sits slightly inside the card's edge. The card prefers the
 * left/past side, remains vertically centered on the event dot, and is clamped
 * below the top strip reserved for the timeline's time-hover label.
 */
export function placeTooltip(input: TooltipPlacementInput): TooltipPosition {
  const anchorOverlap = input.gap ?? 9;
  const margin = input.margin ?? 8;

  const maxX = Math.max(margin, input.viewportWidth - margin - input.width);
  const maxY = Math.max(margin, input.viewportHeight - margin - input.height);

  // Deliberately overlap the event dot with the corresponding card edge.
  const leftX = input.anchorX - input.width + anchorOverlap;
  const rightX = input.anchorX - anchorOverlap;

  const leftFits = leftX >= margin;
  const rightFits = rightX + input.width <= input.viewportWidth - margin;
  const placement: TooltipPlacement = leftFits || !rightFits ? "left" : "right";

  const preferredX = placement === "left" ? leftX : rightX;
  const preferredY = input.anchorY - input.height / 2;

  return {
    x: clamp(preferredX, margin, maxX),

    // Keep the event card below the time-hover label at the top of the timeline.
    y: clamp(preferredY, 4 * margin + 15, maxY),

    placement,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface RowElements {
  readonly header: HTMLDivElement;
  readonly tooltip: HTMLDivElement;
}

const HOVER_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * DOM-backed implementation of TimelineOverlaySink.
 *
 * Solid owns creation and lifetime of every node. The canvas controller sees
 * only the sink interface and may update overlay geometry without allocating
 * reactive snapshots on the render hot path.
 */
export class TimelineOverlayController implements TimelineOverlaySink {
  private nowLine: HTMLDivElement | null = null;
  private hoverLine: HTMLDivElement | null = null;
  private timeHover: HTMLDivElement | null = null;
  private eventTooltip: HTMLDivElement | null = null;
  private eventTooltipVisible = false;
  private eventTooltipX = 0;
  private eventTooltipY = 0;
  private eventTooltipViewportWidth = 0;
  private eventTooltipViewportHeight = 0;
  private readonly rows = new Map<string, RowElements>();
  private readonly rowTops = new Map<string, number>();
  private readonly hoverDate = new Date(0);
  private readonly visibleTooltips: HTMLDivElement[] = [];

  attachStaticElements(
    nowLine: HTMLDivElement,
    hoverLine: HTMLDivElement,
    timeHover: HTMLDivElement,
  ): void {
    this.nowLine = nowLine;
    this.hoverLine = hoverLine;
    this.timeHover = timeHover;
  }

  detachStaticElements(): void {
    this.nowLine = null;
    this.hoverLine = null;
    this.timeHover = null;
  }

  attachEventTooltip(element: HTMLDivElement): void {
    this.eventTooltip = element;
    this.positionEventTooltip();
  }

  detachEventTooltip(element: HTMLDivElement): void {
    if (this.eventTooltip === element) this.eventTooltip = null;
  }

  refreshEventTooltipPosition(): void {
    this.positionEventTooltip();
  }

  attachRow(id: string, header: HTMLDivElement, tooltip: HTMLDivElement): void {
    this.rows.set(id, { header, tooltip });
    const top = this.rowTops.get(id);
    if (top !== undefined) this.positionRow(header, top);
  }

  detachRow(id: string): void {
    const row = this.rows.get(id);
    if (row !== undefined) {
      row.tooltip.hidden = true;
      const visibleIndex = this.visibleTooltips.indexOf(row.tooltip);
      if (visibleIndex >= 0) this.visibleTooltips.splice(visibleIndex, 1);
      row.header.style.removeProperty("--timeline-row-collapse-progress");
      row.header.style.removeProperty("--timeline-row-collapse-scale");
      row.header.style.removeProperty("--timeline-row-collapse-border-alpha");
      row.header.style.removeProperty("--timeline-row-collapse-shadow-alpha");
      delete row.header.dataset.collapsing;
    }
    this.rows.delete(id);
    this.rowTops.delete(id);
  }

  setNowLine(visible: boolean, x: number, width: number, stroke: string): void {
    const line = this.nowLine;
    if (line === null) return;
    line.hidden = !visible;
    if (!visible) return;
    line.style.width = `${width}px`;
    line.style.transform = `translate3d(${x}px, 0, 0)`;
    line.style.background = stroke;
  }

  setCrosshair(visible: boolean, x: number, time: number, viewportWidth: number): void {
    const line = this.hoverLine;
    const label = this.timeHover;
    if (line === null || label === null) return;
    line.hidden = !visible;
    label.hidden = !visible;
    if (!visible) return;

    line.style.transform = `translate3d(${x - 0.5}px, 0, 0)`;
    this.hoverDate.setTime(time);
    const text = HOVER_TIME_FORMAT.format(this.hoverDate);
    if (label.textContent !== text) label.textContent = text;

    const labelWidth = label.offsetWidth;
    const { gapPx, marginPx, topPx } = TIMELINE_OVERLAY_METRICS.timeLabel;
    const leftX = x - labelWidth - gapPx;
    const maxX = Math.max(marginPx, viewportWidth - labelWidth - marginPx);
    const labelX = leftX >= marginPx ? leftX : Math.min(x + gapPx, maxX);
    label.style.transform = `translate3d(${labelX}px, ${topPx}px, 0)`;
  }

  setEventTooltipAnchor(
    visible: boolean,
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    this.eventTooltipVisible = visible;
    if (!visible) return;
    this.eventTooltipX = x;
    this.eventTooltipY = y;
    this.eventTooltipViewportWidth = viewportWidth;
    this.eventTooltipViewportHeight = viewportHeight;
    this.positionEventTooltip();
  }

  setRowTop(id: string, top: number): void {
    this.rowTops.set(id, top);
    const row = this.rows.get(id);
    if (row !== undefined) this.positionRow(row.header, top);
  }

  setRowCollapseProgress(id: string, progress: number): void {
    const header = this.rows.get(id)?.header;
    if (header === undefined) return;
    const normalized = Math.max(0, Math.min(1, progress));
    header.style.setProperty("--timeline-row-collapse-progress", String(normalized));
    header.style.setProperty("--timeline-row-collapse-scale", String(0.7 + normalized * 0.3));
    header.style.setProperty("--timeline-row-collapse-border-alpha", String(normalized * 0.82));
    header.style.setProperty("--timeline-row-collapse-shadow-alpha", String(normalized * 0.28));
    if (normalized > 0) header.dataset.collapsing = "";
    else delete header.dataset.collapsing;
  }

  hideSignalTooltips(): void {
    for (const tooltip of this.visibleTooltips) tooltip.hidden = true;
    this.visibleTooltips.length = 0;
  }

  setSignalTooltip(
    id: string,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const tooltip = this.rows.get(id)?.tooltip;
    if (tooltip === undefined) return;
    tooltip.textContent = text;
    tooltip.style.width = `${width}px`;
    tooltip.style.height = `${height}px`;
    tooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    tooltip.hidden = false;
    this.visibleTooltips.push(tooltip);
  }

  private positionEventTooltip(): void {
    const tooltip = this.eventTooltip;
    if (tooltip === null || !this.eventTooltipVisible) return;
    const position = placeTooltip({
      anchorX: this.eventTooltipX,
      anchorY: this.eventTooltipY,
      width: tooltip.offsetWidth,
      height: tooltip.offsetHeight,
      viewportWidth: this.eventTooltipViewportWidth,
      viewportHeight: this.eventTooltipViewportHeight,
      gap: 4,
    });
    tooltip.dataset.placement = position.placement;
    tooltip.style.setProperty("--tooltip-x", `${position.x}px`);
    tooltip.style.setProperty("--tooltip-y", `${position.y}px`);
  }

  private positionRow(header: HTMLDivElement, top: number): void {
    header.hidden = false;
    const inset = TIMELINE_OVERLAY_METRICS.rowInsetPx;
    header.style.transform = `translate3d(${inset}px, ${top + inset}px, 0)`;
  }
}
