import type { CanvasPoint, CanvasSize, ClientPoint, MutableCanvasPoint } from "./coordinates.ts";
import { GestureSession, type GestureInputKind } from "./gesture.ts";

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export type GestureTarget =
  | { readonly kind: "viewport"; readonly row: number | null }
  | { readonly kind: "boundary"; readonly index: number };

export interface TimelineGestureHost {
  targetAt(point: CanvasPoint): GestureTarget;
  gestureStarted(): void;
  gestureEnded(
    input: GestureInputKind,
    cancelled: boolean,
    finished: boolean,
    pointerInside: boolean,
  ): void;
  panTimeByPixels(deltaX: number, viewportWidth: number): void;
  panRow(row: number | null, deltaY: number): void;
  resizeBoundary(index: number, deltaY: number): void;
  pinchTime(
    viewportWidth: number,
    previousCenterX: number,
    currentCenterX: number,
    previousDistance: number,
    currentDistance: number,
  ): void;
  wheel(point: CanvasPoint, deltaX: number, deltaY: number, shiftKey: boolean): void;
  hoverMoved(point: CanvasPoint, pointerInside: boolean): void;
  pointerLeft(): void;
  tap(point: CanvasPoint): void;
  doubleTap(point: CanvasPoint): void;
}

export interface TimelineGestureControllerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly viewport: CanvasSize;
  readonly wheelLineHeight: number;
  readonly host: TimelineGestureHost;
  readonly signal: AbortSignal;
}

/**
 * Native input owner for the timeline.
 *
 * Browser events, pointer capture, coordinate conversion, and gesture state
 * stay here. Timeline receives domain operations and never handles DOM input.
 */
export class TimelineGestureController {
  private readonly canvas: HTMLCanvasElement;
  private readonly viewport: CanvasSize;
  private readonly wheelLineHeight: number;
  private readonly host: TimelineGestureHost;
  private readonly session = new GestureSession();
  private readonly canvasPoint: MutableCanvasPoint = { x: 0, y: 0 };
  private inside = false;

  constructor(options: TimelineGestureControllerOptions) {
    const { canvas, signal } = options;
    this.canvas = canvas;
    this.viewport = options.viewport;
    this.wheelLineHeight = options.wheelLineHeight;
    this.host = options.host;

    canvas.addEventListener("pointerdown", this.onPointerDown, { signal });
    window.addEventListener("pointermove", this.onPointerMove, { signal });
    window.addEventListener("pointerup", this.onPointerUp, { signal });
    window.addEventListener("pointercancel", this.onPointerCancel, { signal });
    canvas.addEventListener("wheel", this.onWheel, { passive: false, signal });
    canvas.addEventListener("pointermove", this.onHoverMove, { signal });
    canvas.addEventListener("pointerleave", this.onPointerLeave, { signal });
    canvas.addEventListener("click", this.onClick, { signal });
    canvas.addEventListener("dblclick", this.onDoubleClick, { signal });
  }

  get pointer(): CanvasPoint {
    return this.canvasPoint;
  }

  get pointerInside(): boolean {
    return this.inside;
  }

  get active(): boolean {
    return this.session.active;
  }

  get activeBoundary(): number | null {
    return this.session.activeBoundary;
  }

  private onPointerDown = (event: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.updatePointer(event, rect);
    const target = this.host.targetAt(this.canvasPoint);
    const boundary = target.kind === "boundary" ? target.index : null;
    const row = target.kind === "viewport" ? target.row : null;
    const accepted =
      event.pointerType === "touch"
        ? this.session.beginTouch(event.pointerId, boundary, row, event)
        : this.session.beginPointer(event.pointerId, boundary, row, event);
    if (!accepted) return;

    this.host.gestureStarted();
    const state = this.session.state;
    this.canvas.style.cursor = state.kind === "resize" ? "ns-resize" : "";
    this.canvas.setPointerCapture?.(event.pointerId);
    if (event.pointerType === "touch" || state.kind === "resize") event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.moveTouch(event);
      return;
    }
    const state = this.session.state;
    if (
      (state.kind !== "drag" && state.kind !== "resize") ||
      state.input !== "pointer" ||
      state.pointerId !== event.pointerId
    ) {
      return;
    }

    const previousX = state.point.clientX;
    const previousY = state.point.clientY;
    this.session.move(event.pointerId, event);
    const rect = this.canvas.getBoundingClientRect();
    this.updatePointer(event, rect);
    if (state.kind === "resize") {
      if (rect.height > 0) {
        this.host.resizeBoundary(
          state.boundary,
          (event.clientY - previousY) * (this.viewport.height / rect.height),
        );
      }
      return;
    }
    if (rect.width > 0) {
      this.host.panTimeByPixels(event.clientX - previousX, rect.width);
    }
    if (rect.height > 0) {
      this.host.panRow(
        state.row,
        (event.clientY - previousY) * (this.viewport.height / rect.height),
      );
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.endTouch(event, false);
      return;
    }
    const state = this.session.state;
    if (
      (state.kind !== "drag" && state.kind !== "resize") ||
      state.input !== "pointer" ||
      !this.session.end(event.pointerId)
    ) {
      return;
    }
    this.updatePointer(event, this.canvas.getBoundingClientRect());
    this.releasePointer(event.pointerId);
    this.canvas.style.cursor = "";
    this.host.gestureEnded("pointer", false, true, this.inside);
    if (this.inside) this.host.hoverMoved(this.canvasPoint, true);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.endTouch(event, true);
      return;
    }
    const state = this.session.state;
    if (
      (state.kind !== "drag" && state.kind !== "resize") ||
      state.input !== "pointer" ||
      !this.session.end(event.pointerId, true)
    ) {
      return;
    }
    this.inside = false;
    this.canvas.style.cursor = "";
    this.host.gestureEnded("pointer", true, true, false);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.updatePointer(event, this.canvas.getBoundingClientRect());
    let deltaX = event.deltaX;
    let deltaY = event.deltaY;
    if (event.deltaMode === DOM_DELTA_LINE) {
      deltaX *= this.wheelLineHeight;
      deltaY *= this.wheelLineHeight;
    } else if (event.deltaMode === DOM_DELTA_PAGE) {
      deltaX *= this.viewport.width;
      deltaY *= this.viewport.height;
    }
    this.host.wheel(this.canvasPoint, deltaX, deltaY, event.shiftKey);
  };

  private onHoverMove = (event: PointerEvent): void => {
    this.updatePointer(event, this.canvas.getBoundingClientRect());
    if (!this.session.active) this.host.hoverMoved(this.canvasPoint, this.inside);
  };

  private onPointerLeave = (): void => {
    this.inside = false;
    this.host.pointerLeft();
  };

  private onClick = (event: MouseEvent): void => {
    if (this.session.consumeSuppressedClick()) return;
    this.updatePointer(event, this.canvas.getBoundingClientRect());
    this.host.tap(this.canvasPoint);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.updatePointer(event, this.canvas.getBoundingClientRect());
    this.host.doubleTap(this.canvasPoint);
  };

  private moveTouch(event: PointerEvent): void {
    const state = this.session.state;
    if (state.kind === "pinch") {
      if (event.pointerId !== state.primaryId && event.pointerId !== state.secondaryId) return;
      const previousPrimaryX = state.primary.clientX;
      const previousPrimaryY = state.primary.clientY;
      const previousSecondaryX = state.secondary.clientX;
      const previousSecondaryY = state.secondary.clientY;
      this.session.move(event.pointerId, event);
      const rect = this.canvas.getBoundingClientRect();
      this.updatePointer(event, rect);
      if (rect.width > 0) {
        const previousCenterX = (previousPrimaryX + previousSecondaryX) / 2 - rect.left;
        const currentCenterX = (state.primary.clientX + state.secondary.clientX) / 2 - rect.left;
        const previousCenterY = (previousPrimaryY + previousSecondaryY) / 2;
        const currentCenterY = (state.primary.clientY + state.secondary.clientY) / 2;
        const previousDistance = Math.hypot(
          previousSecondaryX - previousPrimaryX,
          previousSecondaryY - previousPrimaryY,
        );
        const currentDistance = Math.hypot(
          state.secondary.clientX - state.primary.clientX,
          state.secondary.clientY - state.primary.clientY,
        );
        this.host.pinchTime(
          rect.width,
          previousCenterX,
          currentCenterX,
          previousDistance,
          currentDistance,
        );
        if (rect.height > 0) {
          this.host.panRow(
            state.row,
            (currentCenterY - previousCenterY) * (this.viewport.height / rect.height),
          );
        }
      }
      event.preventDefault();
      return;
    }
    if (
      (state.kind !== "drag" && state.kind !== "resize") ||
      state.input !== "touch" ||
      state.pointerId !== event.pointerId
    ) {
      return;
    }

    const previousX = state.point.clientX;
    const previousY = state.point.clientY;
    this.session.move(event.pointerId, event);
    const rect = this.canvas.getBoundingClientRect();
    this.updatePointer(event, rect);
    if (state.kind === "resize") {
      if (rect.height > 0) {
        this.host.resizeBoundary(
          state.boundary,
          (event.clientY - previousY) * (this.viewport.height / rect.height),
        );
      }
      event.preventDefault();
      return;
    }
    if (rect.width > 0) {
      this.host.panTimeByPixels(event.clientX - previousX, rect.width);
    }
    if (rect.height > 0) {
      this.host.panRow(
        state.row,
        (event.clientY - previousY) * (this.viewport.height / rect.height),
      );
    }
    event.preventDefault();
  }

  private endTouch(event: PointerEvent, cancelled: boolean): void {
    this.updatePointer(event, this.canvas.getBoundingClientRect());
    if (!this.session.end(event.pointerId, cancelled)) return;
    this.releasePointer(event.pointerId);
    const finished = !this.session.active;
    if (cancelled) this.inside = false;
    if (finished) this.canvas.style.cursor = "";
    this.host.gestureEnded("touch", cancelled, finished, this.inside);
  }

  private updatePointer(source: ClientPoint, rect: DOMRectReadOnly): void {
    if (rect.width <= 0 || rect.height <= 0) {
      this.inside = false;
      return;
    }
    this.inside =
      source.clientX >= rect.left &&
      source.clientX <= rect.right &&
      source.clientY >= rect.top &&
      source.clientY <= rect.bottom;
    this.canvasPoint.x = (source.clientX - rect.left) * (this.viewport.width / rect.width);
    this.canvasPoint.y = (source.clientY - rect.top) * (this.viewport.height / rect.height);
  }

  private releasePointer(pointerId: number): void {
    if (this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }
}
