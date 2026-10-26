import { bbox, boundaryToRect } from "./geometry.js";
import type { Project, Room } from "./schema.js";

/**
 * Compass zone of a room's centre within the plot, using true north.
 * The plot is split into thirds along true north and true east, giving
 * N, NE, E, SE, S, SW, W, NW or C (centre, the brahmasthan).
 */
export function zoneOf(project: Project, room: Room): string {
  const plot = bbox(project.plot.boundary);
  const r = boundaryToRect(room.boundary);
  if (!r) return "C";
  const cx = (r.x0 + r.x1) / 2 - (plot.x0 + plot.x1) / 2;
  const cy = (r.y0 + r.y1) / 2 - (plot.y0 + plot.y1) / 2;
  const a = (project.plot.northAngle * Math.PI) / 180;
  // True north and east as unit vectors in plot axes.
  const n = [Math.sin(a), Math.cos(a)] as const;
  const e = [Math.cos(a), -Math.sin(a)] as const;
  const halfW = (plot.x1 - plot.x0) / 2;
  const halfD = (plot.y1 - plot.y0) / 2;
  const reachN = Math.abs(n[0]) * halfW + Math.abs(n[1]) * halfD;
  const reachE = Math.abs(e[0]) * halfW + Math.abs(e[1]) * halfD;
  const north = (cx * n[0] + cy * n[1]) / reachN;
  const east = (cx * e[0] + cy * e[1]) / reachE;
  const ns = north > 1 / 3 ? "N" : north < -1 / 3 ? "S" : "";
  const ew = east > 1 / 3 ? "E" : east < -1 / 3 ? "W" : "";
  return ns + ew || "C";
}
