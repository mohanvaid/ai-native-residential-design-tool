import { bbox, boundaryToRect, SIDES } from "./geometry.js";
import type { Point, Project, Room, Side } from "./schema.js";

/** The nine Vastu zones; C is the centre (brahmasthan). */
export const ZONES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "C"] as const;
export type Zone = (typeof ZONES)[number];

/**
 * True north and east as unit vectors in plot axes, and how far the plot
 * reaches from its centre along each. Zones split those reaches in thirds.
 */
export function zoneFrame(project: Project) {
  const plot = bbox(project.plot.boundary);
  const a = (project.plot.northAngle * Math.PI) / 180;
  const n = [Math.sin(a), Math.cos(a)] as const;
  const e = [Math.cos(a), -Math.sin(a)] as const;
  const halfW = (plot.x1 - plot.x0) / 2;
  const halfD = (plot.y1 - plot.y0) / 2;
  return {
    plot,
    centre: [(plot.x0 + plot.x1) / 2, (plot.y0 + plot.y1) / 2] as Point,
    n,
    e,
    reachN: Math.abs(n[0]) * halfW + Math.abs(n[1]) * halfD,
    reachE: Math.abs(e[0]) * halfW + Math.abs(e[1]) * halfD,
  };
}

/** Compass zone of a point within the plot, using true north. */
export function zoneOfPoint(project: Project, p: Point): Zone {
  const z = zoneFrame(project);
  const cx = p[0] - z.centre[0];
  const cy = p[1] - z.centre[1];
  const north = (cx * z.n[0] + cy * z.n[1]) / z.reachN;
  const east = (cx * z.e[0] + cy * z.e[1]) / z.reachE;
  const ns = north > 1 / 3 ? "N" : north < -1 / 3 ? "S" : "";
  const ew = east > 1 / 3 ? "E" : east < -1 / 3 ? "W" : "";
  return (ns + ew || "C") as Zone;
}

/**
 * Compass zone of a room's centre within the plot, using true north.
 * The plot is split into thirds along true north and true east, giving
 * N, NE, E, SE, S, SW, W, NW or C (centre, the brahmasthan).
 */
export function zoneOf(project: Project, room: Room): Zone {
  const r = boundaryToRect(room.boundary);
  if (!r) return "C";
  return zoneOfPoint(project, [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]);
}


/** Which true-compass direction each plot side faces, e.g. plot "north" → "NE" when northAngle is 45°. */
export function trueFacing(northAngle: number): Record<Side, string> {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const base: Record<Side, number> = { north: 0, east: 90, south: 180, west: 270 };
  const out = {} as Record<Side, string>;
  for (const side of SIDES) out[side] = names[Math.round((((base[side] - northAngle) % 360) + 360) % 360 / 45) % 8]!;
  return out;
}

