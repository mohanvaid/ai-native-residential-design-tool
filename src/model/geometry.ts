import type { Point, Side } from "./schema.js";

/** Axis-aligned rectangle in mm. x0 < x1, y0 < y1. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function rectToBoundary(r: Rect): Point[] {
  return [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ];
}

/** Returns the rectangle a boundary describes, or null if it is not an axis-aligned rectangle. */
export function boundaryToRect(boundary: Point[]): Rect | null {
  if (boundary.length !== 4) return null;
  const xs = [...new Set(boundary.map((p) => p[0]))];
  const ys = [...new Set(boundary.map((p) => p[1]))];
  if (xs.length !== 2 || ys.length !== 2) return null;
  const r: Rect = {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
  };
  // All four corners must be present.
  const corners = rectToBoundary(r).map((p) => p.join(","));
  const given = new Set(boundary.map((p) => p.join(",")));
  return corners.every((c) => given.has(c)) ? r : null;
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i]!;
    const [x1, y1] = poly[(i + 1) % poly.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

export function bbox(poly: Point[]): Rect {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export const rectWidth = (r: Rect) => r.x1 - r.x0;
export const rectDepth = (r: Rect) => r.y1 - r.y0;
export const rectArea = (r: Rect) => rectWidth(r) * rectDepth(r);

/** Area of overlap of two rectangles (0 when they only touch). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

export function contains(outer: Rect, inner: Rect, tol = 0): boolean {
  return (
    inner.x0 >= outer.x0 - tol &&
    inner.y0 >= outer.y0 - tol &&
    inner.x1 <= outer.x1 + tol &&
    inner.y1 <= outer.y1 + tol
  );
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/** Moves one edge of a rectangle outward by delta (negative moves it inward). */
export function moveEdge(r: Rect, side: Side, delta: number): Rect {
  switch (side) {
    case "north":
      return { ...r, y1: r.y1 + delta };
    case "south":
      return { ...r, y0: r.y0 - delta };
    case "east":
      return { ...r, x1: r.x1 + delta };
    case "west":
      return { ...r, x0: r.x0 - delta };
  }
}

export const OPPOSITE: Record<Side, Side> = { north: "south", south: "north", east: "west", west: "east" };

/** Unit vector pointing outward from a side. */
export const OUTWARD: Record<Side, Point> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };

export const isHorizontal = (side: Side) => side === "north" || side === "south";

/**
 * A side of a rectangle as a segment along a fixed line.
 * Horizontal sides run west→east, vertical sides south→north.
 */
export interface SideSegment {
  side: Side;
  /** "h" lines have constant y, "v" lines constant x. */
  orient: "h" | "v";
  /** The constant coordinate of the line. */
  at: number;
  start: number;
  end: number;
}

export function sideSegment(r: Rect, side: Side): SideSegment {
  switch (side) {
    case "north":
      return { side, orient: "h", at: r.y1, start: r.x0, end: r.x1 };
    case "south":
      return { side, orient: "h", at: r.y0, start: r.x0, end: r.x1 };
    case "east":
      return { side, orient: "v", at: r.x1, start: r.y0, end: r.y1 };
    case "west":
      return { side, orient: "v", at: r.x0, start: r.y0, end: r.y1 };
  }
}

export function sideLength(r: Rect, side: Side): number {
  const s = sideSegment(r, side);
  return s.end - s.start;
}

/** Point on a line given its orientation, line coordinate and position along it. */
export function pointOn(orient: "h" | "v", at: number, along: number): Point {
  return orient === "h" ? [along, at] : [at, along];
}

export const SIDES: readonly Side[] = ["north", "south", "east", "west"];
