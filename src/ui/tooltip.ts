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

/** Place a tooltip beside its anchor, preferring the past/left side. */
export function placeTooltip(input: TooltipPlacementInput): TooltipPosition {
  const margin = input.margin ?? 8;

  const maxX = Math.max(margin, input.viewportWidth - margin - input.width);
  const maxY = Math.max(margin, input.viewportHeight - margin - input.height);

  const leftX = input.anchorX - input.width + 8;
  const rightX = input.anchorX - 8;

  const leftFits = leftX >= margin;
  const rightFits = rightX + input.width <= input.viewportWidth - margin;
  const placement: TooltipPlacement = leftFits || !rightFits ? "left" : "right";

  const preferredX = placement === "left" ? leftX : rightX;
  const preferredY = input.anchorY - input.height / 2;

  return {
    x: clamp(preferredX, margin, maxX),
    y: clamp(preferredY, 4 * margin + 15, maxY),
    placement,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
