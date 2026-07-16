import { Interval } from "../core/interval.ts";
import type { ClientPoint, MutableClientPoint } from "./coordinates.ts";

const MIN_PINCH_DISTANCE_PX = 4;
const DRAG_THRESHOLD_PX = 5;

export type GestureInputKind = "pointer" | "touch";

interface IdleGesture {
  readonly kind: "idle";
  suppressClick: boolean;
}

interface DragGesture {
  readonly kind: "drag";
  readonly input: GestureInputKind;
  readonly pointerId: number;
  readonly row: number | null;
  readonly start: MutableClientPoint;
  readonly point: MutableClientPoint;
  moved: boolean;
}

interface ResizeGesture {
  readonly kind: "resize";
  readonly input: GestureInputKind;
  readonly pointerId: number;
  readonly boundary: number;
  readonly start: MutableClientPoint;
  readonly point: MutableClientPoint;
  moved: boolean;
}

interface PinchGesture {
  readonly kind: "pinch";
  readonly primaryId: number;
  readonly secondaryId: number;
  readonly primary: MutableClientPoint;
  readonly secondary: MutableClientPoint;
  readonly row: number | null;
  readonly moved: true;
}

export type GestureState = IdleGesture | DragGesture | ResizeGesture | PinchGesture;

/**
 * Gesture state transitions for the timeline's Pointer Events controller.
 *
 * State objects are replaced only when a gesture starts, ends, or changes mode.
 * Pointer moves mutate controller-owned points in place and add no allocations.
 */
export class GestureSession {
  private current: GestureState = { kind: "idle", suppressClick: false };

  get state(): GestureState {
    return this.current;
  }

  get active(): boolean {
    return this.current.kind !== "idle";
  }

  get activeBoundary(): number | null {
    return this.current.kind === "resize" ? this.current.boundary : null;
  }

  beginPointer(
    pointerId: number,
    boundary: number | null,
    row: number | null,
    point: ClientPoint,
  ): boolean {
    if (this.current.kind !== "idle") return false;
    this.current = createSingleGesture("pointer", pointerId, boundary, row, point);
    return true;
  }

  beginTouch(
    pointerId: number,
    boundary: number | null,
    row: number | null,
    point: ClientPoint,
  ): boolean {
    const current = this.current;
    if (current.kind === "idle") {
      this.current = createSingleGesture("touch", pointerId, boundary, row, point);
      return true;
    }
    if (
      (current.kind !== "drag" && current.kind !== "resize") ||
      current.input !== "touch" ||
      current.pointerId === pointerId
    ) {
      return false;
    }
    this.current = {
      kind: "pinch",
      primaryId: current.pointerId,
      secondaryId: pointerId,
      primary: current.point,
      secondary: { clientX: point.clientX, clientY: point.clientY },
      row: current.kind === "drag" ? current.row : null,
      moved: true,
    };
    return true;
  }

  /** Update a tracked point in place and return the active state, or null if untracked. */
  move(pointerId: number, source: ClientPoint): GestureState | null {
    const current = this.current;
    if (current.kind === "idle") return null;
    if (current.kind === "pinch") {
      const point =
        pointerId === current.primaryId
          ? current.primary
          : pointerId === current.secondaryId
            ? current.secondary
            : null;
      if (point === null) return null;
      point.clientX = source.clientX;
      point.clientY = source.clientY;
      return current;
    }
    if (pointerId !== current.pointerId) return null;
    current.point.clientX = source.clientX;
    current.point.clientY = source.clientY;
    if (
      !current.moved &&
      Math.hypot(
        current.point.clientX - current.start.clientX,
        current.point.clientY - current.start.clientY,
      ) >= DRAG_THRESHOLD_PX
    ) {
      current.moved = true;
    }
    return current;
  }

  end(pointerId: number, cancelled = false): boolean {
    const current = this.current;
    if (current.kind === "idle") return false;
    if (current.kind === "pinch") {
      const remaining =
        pointerId === current.primaryId
          ? { pointerId: current.secondaryId, point: current.secondary }
          : pointerId === current.secondaryId
            ? { pointerId: current.primaryId, point: current.primary }
            : null;
      if (remaining === null) return false;
      this.current = {
        kind: "drag",
        input: "touch",
        pointerId: remaining.pointerId,
        row: current.row,
        start: { clientX: remaining.point.clientX, clientY: remaining.point.clientY },
        point: remaining.point,
        moved: true,
      };
      return true;
    }
    if (pointerId !== current.pointerId) return false;
    this.current = { kind: "idle", suppressClick: cancelled ? false : current.moved };
    return true;
  }

  consumeSuppressedClick(): boolean {
    const current = this.current;
    if (current.kind !== "idle" || !current.suppressClick) return false;
    current.suppressClick = false;
    return true;
  }
}

function createSingleGesture(
  input: GestureInputKind,
  pointerId: number,
  boundary: number | null,
  row: number | null,
  source: ClientPoint,
): DragGesture | ResizeGesture {
  const start = { clientX: source.clientX, clientY: source.clientY };
  const point = { clientX: source.clientX, clientY: source.clientY };
  return boundary === null
    ? { kind: "drag", input, pointerId, row, start, point, moved: false }
    : { kind: "resize", input, pointerId, boundary, start, point, moved: false };
}

/**
 * Apply one incremental two-finger gesture to a time range.
 *
 * The time below the previous centroid follows the fingers to the current
 * centroid while the change in finger distance controls the visible span.
 * This combines pinch and two-finger pan without applying two independent
 * range updates (which would make the result depend on event order).
 */
export function transformTouchInterval(
  range: Interval,
  viewportWidth: number,
  previousCenterX: number,
  currentCenterX: number,
  previousDistance: number,
  currentDistance: number,
): Interval {
  if (viewportWidth <= 0) {
    throw new Error(`transformTouchInterval: invalid viewport width ${viewportWidth}`);
  }

  const span = range.end - range.start;
  const scale =
    previousDistance >= MIN_PINCH_DISTANCE_PX && currentDistance >= MIN_PINCH_DISTANCE_PX
      ? currentDistance / previousDistance
      : 1;
  const nextSpan = span / scale;
  const anchorTime = range.start + (previousCenterX / viewportWidth) * span;
  const nextMin = anchorTime - (currentCenterX / viewportWidth) * nextSpan;
  const nextMax = nextMin + nextSpan;
  if (!(nextMin < nextMax) || !Number.isFinite(nextMin) || !Number.isFinite(nextMax)) {
    throw new Error(
      `transformTouchInterval: gesture produced invalid range ${nextMin}..${nextMax}`,
    );
  }
  return Interval.create(nextMin, nextMax);
}
