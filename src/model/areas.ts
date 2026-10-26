/** Built-up (plinth) areas and footprints, measured to the outer face of external walls. */
import { bbox, boundaryToRect, polygonArea, type Rect } from "./geometry.js";
import type { Project, Room } from "./schema.js";
import { EXTERNAL_WALL_MM } from "./walls.js";

/** A room's centreline rectangle grown to the outer face of a 230 mm external wall. */
export function outerRect(room: Room): Rect | null {
  const r = boundaryToRect(room.boundary);
  if (!r) return null;
  const h = EXTERNAL_WALL_MM / 2;
  return { x0: r.x0 - h, y0: r.y0 - h, x1: r.x1 + h, y1: r.y1 + h };
}

/** Area of the union of rectangles, in mm², by coordinate compression. */
export function unionArea(rects: Rect[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i]!;
    const xb = xs[i + 1]!;
    const spans = rects
      .filter((r) => r.x0 <= xa && r.x1 >= xb)
      .map((r) => [r.y0, r.y1] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [y0, y1] of spans) {
      if (y1 <= end) continue;
      covered += y1 - Math.max(y0, end);
      end = y1;
    }
    area += covered * (xb - xa);
  }
  return area;
}

/** Plinth area of the given rooms of one level, in m². */
export function builtUpArea(rooms: Room[]): number {
  return unionArea(rooms.map(outerRect).filter((r): r is Rect => r !== null)) / 1e6;
}

export function plotArea(project: Project): number {
  return polygonArea(project.plot.boundary) / 1e6;
}

/** Outer extent of the building across all levels, enclosed stairs included, or null if there are no rooms. */
export function buildingExtent(project: Project): Rect | null {
  const stairs = project.stairs.filter((s) => !s.external).map((s) => boundaryToRect(s.boundary));
  const rects = [...project.rooms.map(outerRect), ...stairs].filter((r): r is Rect => r !== null);
  if (!rects.length) return null;
  return bbox(rects.flatMap((r) => [[r.x0, r.y0] as [number, number], [r.x1, r.y1] as [number, number]]));
}
