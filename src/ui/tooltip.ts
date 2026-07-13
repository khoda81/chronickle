import type { RssFeed } from "../domain.ts";
import type { HoverInfo } from "../engine/timeline.ts";

export type TooltipPlacement = "above-right" | "above-left" | "below-right" | "below-left";

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
 * Place a floating label beside an anchor while keeping its border inside the viewport.
 * The preferred position matches the old UI (above-right), then flips before clamping.
 */
export function placeTooltip(input: TooltipPlacementInput): TooltipPosition {
  const gap = input.gap ?? 12;
  const margin = input.margin ?? 8;
  const maxX = Math.max(margin, input.viewportWidth - margin - input.width);
  const maxY = Math.max(margin, input.viewportHeight - margin - input.height);

  const rightFits = input.anchorX + gap + input.width <= input.viewportWidth - margin;
  const leftFits = input.anchorX - gap - input.width >= margin;
  const horizontal: "right" | "left" = rightFits
    ? "right"
    : leftFits
      ? "left"
      : input.anchorX <= input.viewportWidth / 2
        ? "right"
        : "left";

  const aboveFits = input.anchorY - gap - input.height >= margin;
  const belowFits = input.anchorY + gap + input.height <= input.viewportHeight - margin;
  const vertical: "above" | "below" = aboveFits
    ? "above"
    : belowFits
      ? "below"
      : input.anchorY >= input.viewportHeight / 2
        ? "above"
        : "below";

  const preferredX =
    horizontal === "right" ? input.anchorX + gap : input.anchorX - gap - input.width;
  const preferredY =
    vertical === "above" ? input.anchorY - gap - input.height : input.anchorY + gap;

  return {
    x: clamp(preferredX, margin, maxX),
    y: clamp(preferredY, margin, maxY),
    placement: `${vertical}-${horizontal}`,
  };
}

/** DOM owner for the event hover label. Content changes are rare; positioning is immediate. */
export class EventTooltip {
  private eventT = Number.NaN;
  private eventLink = "";
  private eventTitle = "";
  private eventSummary = "";
  private feedId = "";
  private feedSource = "";
  private feedColor = "";
  private measuredWidth = 0;
  private measuredHeight = 0;
  private measuredViewportWidth = Number.NaN;
  private measuredViewportHeight = Number.NaN;

  constructor(private readonly element: HTMLDivElement) {}

  show(event: HoverInfo, feed: RssFeed): void {
    const contentChanged =
      event.t !== this.eventT ||
      event.link !== this.eventLink ||
      event.title !== this.eventTitle ||
      event.summary !== this.eventSummary ||
      event.feedId !== this.feedId ||
      feed.source !== this.feedSource ||
      feed.color !== this.feedColor;

    if (contentChanged) {
      this.renderContent(event, feed);
      this.eventT = event.t;
      this.eventLink = event.link;
      this.eventTitle = event.title;
      this.eventSummary = event.summary;
      this.feedId = event.feedId;
      this.feedSource = feed.source;
      this.feedColor = feed.color;
      this.measuredWidth = 0;
      this.measuredHeight = 0;
    }

    this.element.classList.remove("hidden");
    if (
      this.measuredWidth === 0 ||
      this.measuredHeight === 0 ||
      event.viewportWidth !== this.measuredViewportWidth ||
      event.viewportHeight !== this.measuredViewportHeight
    ) {
      const rect = this.element.getBoundingClientRect();
      this.measuredWidth = rect.width;
      this.measuredHeight = rect.height;
      this.measuredViewportWidth = event.viewportWidth;
      this.measuredViewportHeight = event.viewportHeight;
    }

    const position = placeTooltip({
      anchorX: event.anchorX,
      anchorY: event.anchorY,
      width: this.measuredWidth,
      height: this.measuredHeight,
      viewportWidth: event.viewportWidth,
      viewportHeight: event.viewportHeight,
    });
    this.element.dataset.placement = position.placement;
    this.element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
  }

  hide(): void {
    this.element.classList.add("hidden");
  }

  private renderContent(event: HoverInfo, feed: RssFeed): void {
    this.element.replaceChildren();
    const source = document.createElement("span");
    source.className = "tooltip-source";
    const swatch = document.createElement("span");
    swatch.className = "tooltip-swatch";
    swatch.style.background = feed.color;
    source.append(
      swatch,
      document.createTextNode(`${feed.source} · ${new Date(event.t).toLocaleString()}`),
    );

    const link = document.createElement("a");
    link.className = "tooltip-link";
    link.href = event.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = event.title;
    this.element.append(source, link);

    if (event.summary.length > 0) {
      const summary = document.createElement("p");
      summary.className = "tooltip-summary";
      summary.textContent = event.summary;
      this.element.append(summary);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
