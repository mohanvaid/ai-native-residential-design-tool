/**
 * Elevations (one per plot side, named by the true direction it faces) and
 * a section through the stair, at 1:100, in the project's colour theme.
 * Drawn by painting the faces that look at the viewer from far to near, so
 * nearer masses hide farther ones without a hidden-line pass.
 */
import { bbox, boundaryToRect, OUTWARD, SIDES, type Rect } from "../model/geometry.js";
import type { Project, Side } from "../model/schema.js";
import { stairLayout } from "../model/structure.js";
import { formatMetres } from "../model/units.js";
import { deriveWalls, resolveOpening, wallsOnSide } from "../model/walls.js";
import { trueFacing } from "../model/zones.js";
import { SMALL, TEXT, titleBlock } from "./frame.js";
import type { Item, Pt, Sheet } from "./sheet.js";
import { palette } from "./theme.js";

const MARGIN = 3000;
const PARAPET = 900;
const NAMES: Record<string, string> = { N: "North", NE: "North-east", E: "East", SE: "South-east", S: "South", SW: "South-west", W: "West", NW: "North-west" };

/** Horizontal sheet axis and depth for a viewer standing outside `side`, looking in. */
function viewAxes(side: Side) {
  switch (side) {
    case "south":
      return { u: (x: number, _y: number) => x, depth: (_x: number, y: number) => y };
    case "north":
      return { u: (x: number, _y: number) => -x, depth: (_x: number, y: number) => -y };
    case "east":
      return { u: (_x: number, y: number) => y, depth: (x: number, _y: number) => -x };
    case "west":
      return { u: (_x: number, y: number) => -y, depth: (x: number, _y: number) => x };
  }
}

interface Face {
  depth: number;
  u0: number;
  u1: number;
  z0: number;
  z1: number;
  /** Top of the parapet above this face when its roof is open, else null. */
  parapet: number | null;
  openings: { u0: number; u1: number; z0: number; z1: number; type: string }[];
}

function totalHeight(project: Project): number {
  return project.levels.reduce((h, l) => h + l.floorToFloor, 0) + PARAPET;
}

/** A sheet frame for a drawing W wide (model mm) and the building's height, ground line at the returned y. */
function elevationFrame(project: Project, width: number) {
  const height = totalHeight(project);
  const W = width + 2 * MARGIN;
  const H = height + 2 * MARGIN + 600;
  const groundY = MARGIN + height + 300;
  return { W, H, groundY };
}

export function elevationSheet(project: Project, side: Side): Sheet {
  const pal = palette(project);
  const plot = bbox(project.plot.boundary);
  const ax = viewAxes(side);
  const corners: Pt[] = [
    [plot.x0, plot.y0],
    [plot.x1, plot.y1],
  ];
  const us = corners.map(([x, y]) => ax.u(x, y));
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const { W, H, groundY } = elevationFrame(project, uMax - uMin);
  const X = (u: number) => MARGIN + (u - uMin);
  const Z = (z: number) => groundY - z;
  const items: Item[] = [];
  const text = (at: Pt, s: string, size: number, o: { rotate?: number; bold?: boolean; fill?: string } = {}) => items.push({ kind: "text", at, text: s, size, ...o });

  // Faces looking at the viewer, from every level's external walls on this side
  const faces: Face[] = [];
  project.levels.forEach((level, li) => {
    const walls = deriveWalls(project, level.id);
    const above = project.levels[li + 1];
    const upper = above ? project.rooms.filter((r) => r.level === above.id).map((r) => boundaryToRect(r.boundary)).filter((r): r is Rect => r !== null) : [];
    for (const room of project.rooms.filter((r) => r.level === level.id && boundaryToRect(r.boundary))) {
      for (const w of wallsOnSide(walls, room, side)) {
        if (!w.isExternal) continue;
        const h = w.thickness / 2;
        const [ox, oy] = OUTWARD[side];
        const a: Pt = w.orient === "h" ? [w.from - h, w.at + oy * h] : [w.at + ox * h, w.from - h];
        const b: Pt = w.orient === "h" ? [w.to + h, w.at + oy * h] : [w.at + ox * h, w.to + h];
        const ua = ax.u(a[0], a[1]);
        const ub = ax.u(b[0], b[1]);
        // Covered from above when an upper room spans this wall line
        const covered = upper.some((r) => (w.orient === "h" ? r.y0 <= w.at && r.y1 >= w.at && r.x0 <= w.from && r.x1 >= w.to : r.x0 <= w.at && r.x1 >= w.at && r.y0 <= w.from && r.y1 >= w.to));
        const face: Face = {
          depth: ax.depth(a[0], a[1]),
          u0: Math.min(ua, ub),
          u1: Math.max(ua, ub),
          z0: level.elevation,
          z1: level.elevation + level.floorToFloor,
          parapet: covered ? null : level.elevation + level.floorToFloor + PARAPET,
          openings: [],
        };
        for (const o of project.openings.filter((o) => o.host.room === room.id && o.host.side === side)) {
          const r = resolveOpening(project, walls, o);
          if (!r || r.wall?.id !== w.id) continue;
          const p0 = r.orient === "h" ? ax.u(r.from, r.at) : ax.u(r.at, r.from);
          const p1 = r.orient === "h" ? ax.u(r.to, r.at) : ax.u(r.at, r.to);
          face.openings.push({ u0: Math.min(p0, p1), u1: Math.max(p0, p1), z0: level.elevation + o.sill, z1: level.elevation + o.sill + o.height, type: o.type });
        }
        faces.push(face);
      }
    }
  });

  // Trees behind the building, outline only
  for (const t of project.trees.filter((t) => t.keep)) {
    const u = ax.u(t.at[0], t.at[1]);
    const crown = Math.min(t.canopyRadius, 4000);
    const top = crown * 2 + 2500;
    items.push({ kind: "line", a: [X(u), Z(0)], b: [X(u), Z(top - crown)], stroke: "#6d8a5a", sw: 60 });
    items.push({ kind: "circle", c: [X(u), Z(top - crown)], r: crown, stroke: "#6d8a5a", sw: 20, dash: [160, 90] });
  }

  faces.sort((a, b) => b.depth - a.depth);
  for (const f of faces) {
    const top = f.parapet ?? f.z1;
    items.push({ kind: "rect", x: X(f.u0), y: Z(top), w: f.u1 - f.u0, h: top - f.z0, fill: pal.walls, stroke: "#333", sw: 15 });
    // Slab band at the top of the storey, coping on a parapet
    items.push({ kind: "rect", x: X(f.u0), y: Z(f.z1), w: f.u1 - f.u0, h: 150, fill: pal.accent });
    if (f.parapet !== null) items.push({ kind: "rect", x: X(f.u0) - 50, y: Z(f.parapet), w: f.u1 - f.u0 + 100, h: 100, fill: pal.accent });
    for (const o of f.openings) {
      const x = X(o.u0);
      const w = o.u1 - o.u0;
      const y = Z(o.z1);
      const h = o.z1 - o.z0;
      if (o.type === "door") {
        items.push({ kind: "rect", x, y, w, h, fill: pal.door, stroke: "#222", sw: 15 });
        items.push({ kind: "line", a: [x + w * 0.5, y + 100], b: [x + w * 0.5, y + h], stroke: "#3b2412", sw: 10 });
      } else if (o.type === "opening") {
        items.push({ kind: "rect", x, y, w, h, fill: "#3a3a3a" });
      } else {
        items.push({ kind: "rect", x, y, w, h, fill: pal.glass, stroke: pal.frame, sw: 50 });
        items.push({ kind: "line", a: [x + w / 2, y], b: [x + w / 2, y + h], stroke: pal.frame, sw: 40 });
        // Sunshade over windows
        items.push({ kind: "rect", x: x - 150, y: y - 150, w: w + 300, h: 80, fill: pal.accent });
      }
    }
  }

  // Ground and plot edges
  items.push({ kind: "rect", x: X(uMin) - 600, y: Z(0), w: uMax - uMin + 1200, h: 250, fill: pal.ground });
  items.push({ kind: "line", a: [X(uMin) - 600, Z(0)], b: [X(uMax) + 600, Z(0)], stroke: "#000", sw: 40 });
  for (const u of [uMin, uMax]) items.push({ kind: "line", a: [X(u), Z(0) - 1500], b: [X(u), Z(0) + 250], stroke: "#000", sw: 20, dash: [300, 100, 60, 100] });

  // Level datums
  const dx = X(uMax) + 300;
  for (const level of project.levels) {
    items.push({ kind: "line", a: [dx, Z(level.elevation)], b: [dx + 700, Z(level.elevation)], stroke: "#000", sw: 12 });
    items.push({ kind: "poly", pts: [[dx, Z(level.elevation)], [dx + 150, Z(level.elevation) - 150], [dx - 150, Z(level.elevation) - 150]], closed: true, fill: "#000" });
    text([dx + 1300, Z(level.elevation) - 130], `${level.name} +${formatMetres(level.elevation)}`, SMALL - 20);
  }
  const top = project.levels.reduce((h, l) => h + l.floorToFloor, 0);
  text([dx + 1300, Z(top) - 130], `Roof +${formatMetres(top)}`, SMALL - 20);

  const facing = trueFacing(project.plot.northAngle)[side];
  const road = project.plot.abuttingRoads.some((r) => r.side === side) ? " (road side)" : "";
  return titleBlock(items, W, H, project, `${NAMES[facing] ?? facing} elevation${road}`, "Elevation colours follow the chosen theme. Sunshades, railings and finishes are indicative.", { north: false });
}

/** All four elevations, starting with the road side. */
export function elevationSheets(project: Project): Sheet[] {
  const road = project.plot.abuttingRoads[0]?.side;
  const order = road ? [road, ...SIDES.filter((s) => s !== road)] : [...SIDES];
  return order.map((s) => elevationSheet(project, s));
}

/**
 * Section through the first flight of the first stair, looking across it;
 * through the middle of the plot when there is no stair. Cut walls are solid,
 * slabs are drawn at each floor and roof, and the flight cut is shown in profile.
 */
export function sectionSheet(project: Project): Sheet {
  const plot = bbox(project.plot.boundary);
  const stair = project.stairs[0];
  const lay = stair ? stairLayout(project, stair) : null;
  const flight = lay?.flights[0];
  // Cut along the flight: horizontal cut (y = c) when the flight runs east-west, else vertical (x = c)
  const alongX = flight ? flight.dir === "east" || flight.dir === "west" : true;
  const c = flight ? (alongX ? (flight.rect.y0 + flight.rect.y1) / 2 : (flight.rect.x0 + flight.rect.x1) / 2) : (plot.y0 + plot.y1) / 2;
  // Looking north for a horizontal cut (u = x), looking west for a vertical cut (u = y)
  const uMin = alongX ? plot.x0 : plot.y0;
  const uMax = alongX ? plot.x1 : plot.y1;
  const { W, H, groundY } = elevationFrame(project, uMax - uMin);
  const X = (u: number) => MARGIN + (u - uMin);
  const Z = (z: number) => groundY - z;
  const items: Item[] = [];
  const pal = palette(project);
  const POCHE = "#2b2b2b";

  project.levels.forEach((level, li) => {
    const walls = deriveWalls(project, level.id);
    const above = project.levels[li + 1];
    const cutRooms = project.rooms
      .filter((r) => r.level === level.id)
      .map((r) => ({ r, rect: boundaryToRect(r.boundary) }))
      .filter((x): x is { r: (typeof project.rooms)[number]; rect: Rect } => !!x.rect && (alongX ? x.rect.y0 < c && x.rect.y1 > c : x.rect.x0 < c && x.rect.x1 > c));
    const z0 = level.elevation;
    const z1 = z0 + level.floorToFloor;
    for (const { r, rect } of cutRooms) {
      const u0 = alongX ? rect.x0 : rect.y0;
      const u1 = alongX ? rect.x1 : rect.y1;
      // Room space, floor slab and roof or next floor slab
      items.push({ kind: "rect", x: X(u0), y: Z(z1), w: u1 - u0, h: z1 - z0, fill: "#ffffff" });
      items.push({ kind: "rect", x: X(u0) - 115, y: Z(z0), w: u1 - u0 + 230, h: li === 0 ? 300 : level.slabThickness, fill: li === 0 ? "#9a9a9a" : POCHE });
      const covered = above && project.rooms.some((o) => o.level === above.id && (() => {
        const q = boundaryToRect(o.boundary);
        return q && (alongX ? q.x0 <= u0 && q.x1 >= u1 && q.y0 < c && q.y1 > c : q.y0 <= u0 && q.y1 >= u1 && q.x0 < c && q.x1 > c);
      })());
      if (!covered) {
        items.push({ kind: "rect", x: X(u0) - 115, y: Z(z1), w: u1 - u0 + 230, h: level.slabThickness, fill: POCHE });
        text(items, [X((u0 + u1) / 2), Z(z1) - 300], "ROOF", SMALL - 30);
      }
      items.push({ kind: "text", at: [X((u0 + u1) / 2), Z(z0 + 1300)], text: r.name.toUpperCase(), size: SMALL, bold: true, fill: "#555" });
    }
    // Cut walls: walls crossing the cut line
    for (const w of walls) {
      const crosses = alongX ? w.orient === "v" && w.from < c && w.to > c : w.orient === "h" && w.from < c && w.to > c;
      if (!crosses) continue;
      const u = w.at;
      const t = w.thickness;
      // A door or opening in this wall at the cut leaves only the lintel
      const gap = project.openings
        .map((o) => resolveOpening(project, walls, o))
        .find((r) => r && r.wall?.id === w.id && r.from < c && r.to > c);
      const head = gap ? z0 + gap.opening.sill + gap.opening.height : null;
      const sill = gap ? z0 + gap.opening.sill : null;
      const top = z1 - (above ? above.slabThickness : level.slabThickness);
      if (gap && head !== null && sill !== null) {
        items.push({ kind: "rect", x: X(u - t / 2), y: Z(top), w: t, h: top - head, fill: POCHE });
        if (sill > z0) items.push({ kind: "rect", x: X(u - t / 2), y: Z(sill), w: t, h: sill - z0, fill: POCHE });
        if (gap.opening.type !== "door" && gap.opening.type !== "opening")
          items.push({ kind: "rect", x: X(u - t / 6), y: Z(head), w: t / 3, h: head - sill, fill: pal.glass });
      } else {
        items.push({ kind: "rect", x: X(u - t / 2), y: Z(top), w: t, h: top - z0, fill: POCHE });
      }
      if (!project.rooms.some((o) => o.level === above?.id)) {
        // Parapet on an open roof edge
        if (w.isExternal) items.push({ kind: "rect", x: X(u - t / 2), y: Z(z1 + PARAPET), w: t, h: PARAPET, fill: POCHE });
      }
    }
  });

  // Stair profile: the cut flight solid, the far flight dashed
  if (stair && lay && flight) {
    const from = project.levels.find((l) => l.id === stair.fromLevel)!;
    const z0 = from.elevation;
    const rh = lay.riserHeight;
    const sign = flight.dir === "east" || flight.dir === "north" ? 1 : -1;
    const startU = alongX ? flight.start[0] : flight.start[1];
    const pts: Pt[] = [[X(startU), Z(z0)]];
    for (let i = 0; i < flight.risers; i++) {
      const u = startU + sign * i * stair.tread;
      pts.push([X(u), Z(z0 + (i + 1) * rh)]);
      if (i < flight.risers - 1) pts.push([X(u + sign * stair.tread), Z(z0 + (i + 1) * rh)]);
    }
    const endU = startU + sign * (flight.risers - 1) * stair.tread;
    const landingTop = z0 + flight.risers * rh;
    // Landing to the end of the well
    const wellEnd = alongX ? (sign > 0 ? lay.well.x1 : lay.well.x0) : sign > 0 ? lay.well.y1 : lay.well.y0;
    pts.push([X(wellEnd), Z(landingTop)], [X(wellEnd), Z(landingTop - 150)], [X(endU), Z(landingTop - 150)], [X(startU + sign * stair.tread), Z(z0)]);
    items.push({ kind: "poly", pts, closed: true, fill: "#7a7a7a", stroke: "#000", sw: 15 });
    const second = lay.flights[1];
    if (second) {
      const s0 = alongX ? second.start[0] : second.start[1];
      const sgn = -sign;
      const pts2: Pt[] = [[X(s0), Z(landingTop)]];
      for (let i = 0; i < second.risers; i++) {
        const u = s0 + sgn * i * stair.tread;
        pts2.push([X(u), Z(landingTop + (i + 1) * rh)]);
        if (i < second.risers - 1) pts2.push([X(u + sgn * stair.tread), Z(landingTop + (i + 1) * rh)]);
      }
      items.push({ kind: "poly", pts: pts2, closed: false, stroke: "#000", sw: 12, dash: [80, 60] });
    }
  }

  // Ground line
  items.push({ kind: "line", a: [X(uMin) - 600, Z(0)], b: [X(uMax) + 600, Z(0)], stroke: "#000", sw: 40 });
  const dx = X(uMax) + 300;
  for (const level of project.levels) {
    items.push({ kind: "line", a: [dx, Z(level.elevation)], b: [dx + 700, Z(level.elevation)], stroke: "#000", sw: 12 });
    text(items, [dx + 1300, Z(level.elevation) - 130], `${level.name} +${formatMetres(level.elevation)}`, SMALL - 20);
  }
  const where = alongX ? `y = ${formatMetres(c)}, looking north` : `x = ${formatMetres(c)}, looking west`;
  text(items, [W / 2, MARGIN - 900], `SECTION A–A (${where})`, TEXT, true);
  return titleBlock(items, W, H, project, "Section A–A", "Cut walls and slabs solid; the far flight dashed. Structure is indicative; sizes by the engineer.", { north: false });
}

function text(items: Item[], at: Pt, s: string, size: number, bold = false): void {
  items.push({ kind: "text", at, text: s, size, bold });
}
