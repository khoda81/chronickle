/** A position in browser viewport coordinates, matching PointerEvent.clientX/Y. */
export interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/** Controller-owned mutable browser viewport position. */
export interface MutableClientPoint {
  clientX: number;
  clientY: number;
}

/** A position in the timeline canvas's logical CSS-pixel coordinate space. */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/** Controller-owned mutable canvas position. */
export interface MutableCanvasPoint {
  x: number;
  y: number;
}

/** Logical canvas dimensions in CSS pixels. */
export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** Timeline-owned logical canvas dimensions, updated only during resize. */
export interface MutableCanvasSize {
  width: number;
  height: number;
}
