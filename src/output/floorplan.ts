/**
 * Floor plan sheet: a pure function of one model version and one level.
 * Drawn in model millimetres as a display list (./sheet.ts), so the same
 * drawing renders to SVG and PDF. Room sizes are clear (wall face to wall
 * face) in ft-in, areas in sq ft and m², as Chennai clients read them.
 */
import { revisionLabel } from "../agent/report.js";
import { buildingExtent } from "../model/areas.js";
import { bbox, boundaryToRect, OUTWARD, rectArea, rectDepth, rectWidth, type Rect } from "../model/geometry.js";
import type { Project, RoomType, Side } from "../model/schema.js";
import { formatFtIn, formatMetres, sqmToSqft } from "../model/units.js";
import { clearRect, deriveWalls, resolveOpening, type ResolvedOpening, type Wall } from "../model/walls.js";
import { rulePacksFor } from "../rules/registry.js";
import { marksById } from "./schedule.js";
import { sheetsToPdf, type Paper } from "./pdf.js";
import { sheetToSvg, type Item, type Pt, type Sheet } from "./sheet.js";

const MARGIN = 3200;
const ROAD_DEPTH = 1200;
const TEXT = 220;
const SMALL = 170;

export const ADVISORY_STAMP = "ADVISORY · NOT FOR CONSTRUCTION OR APPROVAL";

const ROOM_FILL: Partial<Record<RoomType, string>> = {
  living: "#f6efe2",
  dining: "#f6efe2",
  kitchen: "#fbe9d7",
  bedroom: "#e8f0f8",
  toilet: "#e3f4f1",
  puja: "#fdf3d1",
  staircase: "#eeeeee",
  "sit-out": "#eef5e6",
  "car-porch": "#eeeeee",
  balcony: "#eef5e6",
};

export interface FloorPlanOptions {
  /** Draw the setback line from the first applicable rule pack. Default true. */
  showSetbacks?: boolean;
}

export function floorPlanSheet(project: Project, levelId: string, opts: FloorPlanOptions = {}): Sheet {
  const level = project.levels.find((l) => l.id === levelId);
  if (!level) throw new Error(`No level ${levelId}`);
  const plot = bbox(project.plot.boundary);
  const ox = plot.x0 - MARGIN;
  const oy = plot.y1 + MARGIN;
  const W = rectWidth(plot) + 2 * MARGIN;
  const H = rectDepth(plot) + 2 * MARGIN;
  const X = (x: number) => x - ox;
  const Y = (y: number) => oy - y;
  const P = (x: number, y: number): Pt => [X(x), Y(y)];
  /** A model rectangle as a sheet rectangle item. */
  const box = (r: Rect) => ({ x: X(r.x0), y: Y(r.y1), w: rectWidth(r), h: rectDepth(r) });

  const rooms = project.rooms.filter((r) => r.level === levelId && boundaryToRect(r.boundary));
  const walls = deriveWalls(project, levelId);
  const resolved = project.openings
    .filter((o) => rooms.some((r) => r.id === o.host.room))
    .map((o) => resolveOpening(project, walls, o))
    .filter((r): r is ResolvedOpening => r !== null);
  const marks = marksById(project);
  const items: Item[] = [];
  const text = (at: Pt, s: string, size: number, o: { rotate?: number; bold?: boolean; fill?: string } = {}) =>
    items.push({ kind: "text", at, text: s, size, ...o });

  // Roads
  for (const road of project.plot.abuttingRoads) {
    const r = outside(plot, road.side, ROAD_DEPTH);
    items.push({ kind: "rect", ...box(r), fill: "#e4e4e4" });
    const label = `ROAD ${road.widthM} m (${formatFtIn(road.widthM * 1000)})${road.name ? ` · ${road.name}` : ""}`;
    text(P((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2), label, TEXT, { rotate: road.side === "east" || road.side === "west" ? -90 : 0, bold: true, fill: "#555" });
  }

  // Plot boundary
  items.push({ kind: "poly", pts: project.plot.boundary.map(([x, y]) => P(x, y)), closed: true, stroke: "#000", sw: 40, dash: [400, 120, 80, 120] });

  // Setback line and provided setbacks
  const pack = opts.showSetbacks === false ? undefined : rulePacksFor(project)[0];
  const env = pack?.derive(project);
  const extent = buildingExtent(project);
  if (env && env.setbacks.length) {
    items.push({ kind: "rect", ...box(env.buildable), stroke: "#c0392b", sw: 25, dash: [200, 100] });
    if (extent) {
      for (const s of env.setbacks) {
        const provided = distanceTo(plot, extent, s.side);
        const gap = outside(extent, s.side, provided);
        const req = s.requiredMm === null ? "req. ?" : `req. ${formatMetres(s.requiredMm)}${s.applies === "one_of_sides" ? " one side" : ""}`;
        const vertical = s.side === "east" || s.side === "west";
        text(P((gap.x0 + gap.x1) / 2, (gap.y0 + gap.y1) / 2), `${cap(s.role)} ${formatMetres(provided)} (${req})`, SMALL, { rotate: vertical ? -90 : 0, fill: "#c0392b" });
      }
    }
  }

  // Room fills
  for (const room of rooms) items.push({ kind: "rect", ...box(clearRect(walls, room)), fill: ROOM_FILL[room.type] ?? "#f4f4f4" });

  // Walls, with gaps at openings
  for (const w of walls) {
    const gaps = resolved.filter((r) => r.wall?.id === w.id).map((r) => [r.from, r.to] as const);
    for (const [a, b] of subtract(w.from - w.thickness / 2, w.to + w.thickness / 2, gaps)) {
      items.push({ kind: "rect", ...box(wallRect(w, a, b)), fill: w.isExternal ? "hatch" : "#9a9a9a", stroke: "#000", sw: 15 });
    }
  }

  // Openings
  for (const r of resolved) {
    const t = r.wall?.thickness ?? 230;
    const o = r.opening;
    const Q = (along: number, across: number): Pt => (r.orient === "h" ? P(along, r.at + across) : P(r.at + across, along));
    const line = (a: Pt, b: Pt, sw = 15, dash?: number[]) => items.push({ kind: "line", a, b, stroke: "#000", sw, ...(dash ? { dash } : {}) });
    if (o.type === "window" || o.type === "ventilator") {
      line(Q(r.from, -t / 2), Q(r.to, -t / 2));
      line(Q(r.from, t / 2), Q(r.to, t / 2));
      line(Q(r.from, -t / 2), Q(r.from, t / 2));
      line(Q(r.to, -t / 2), Q(r.to, t / 2));
      line(Q(r.from, 0), Q(r.to, 0), 10);
      if (o.type === "window") {
        line(Q(r.from, -t / 6), Q(r.to, -t / 6), 10);
        line(Q(r.from, t / 6), Q(r.to, t / 6), 10);
      }
    } else if (o.type === "door") {
      const out = OUTWARD[o.host.side];
      const outwardSign = r.orient === "h" ? out[1] : out[0];
      const dir = (o.swing?.into === "other" ? 1 : -1) * outwardSign;
      const hingeAt = o.swing?.hinge === "end" ? r.to : r.from;
      const jambAt = o.swing?.hinge === "end" ? r.from : r.to;
      const hinge = Q(hingeAt, (dir * t) / 2);
      const tip = Q(hingeAt, (dir * t) / 2 + dir * o.width);
      const jamb = Q(jambAt, (dir * t) / 2);
      const cross = (tip[0] - hinge[0]) * (jamb[1] - hinge[1]) - (tip[1] - hinge[1]) * (jamb[0] - hinge[0]);
      line(hinge, tip, 20);
      items.push({ kind: "arc", c: hinge, r: o.width, from: tip, to: jamb, sweep: cross > 0 ? 1 : 0, stroke: "#000", sw: 10 });
    } else {
      line(Q(r.from, 0), Q(r.to, 0), 10, [80, 60]);
    }
    const mark = marks.get(o.id);
    if (mark) {
      const out = OUTWARD[o.host.side];
      const s = r.orient === "h" ? out[1] : out[0];
      text(Q((r.from + r.to) / 2, s * (t / 2 + 260)), mark, SMALL, { bold: true });
    }
  }

  // Room tags
  for (const room of rooms) {
    const c = clearRect(walls, room);
    const [cx, cy] = P((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
    const sqm = rectArea(c) / 1e6;
    text([cx, cy - TEXT * 1.1], room.name.toUpperCase(), TEXT, { bold: true });
    text([cx, cy + TEXT * 0.1], `${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))}`, SMALL);
    text([cx, cy + TEXT * 1.1], `${Math.round(sqmToSqft(sqm))} sq ft · ${sqm.toFixed(1)} m²`, SMALL, { fill: "#555" });
  }

  // Dimension chains (wall centrelines) and overall sizes, outside the plot so they never collide with setback labels
  if (rooms.length) {
    const rects = rooms.map((r) => boundaryToRect(r.boundary)!);
    const xs = uniq(rects.flatMap((r) => [r.x0, r.x1]));
    const ys = uniq(rects.flatMap((r) => [r.y0, r.y1]));
    const yChain = plot.y0 - 500;
    const xChain = plot.x0 - 500;
    for (let i = 0; i + 1 < xs.length; i++) dimension(items, P(xs[i]!, yChain), P(xs[i + 1]!, yChain), formatFtIn(xs[i + 1]! - xs[i]!));
    for (let i = 0; i + 1 < ys.length; i++) dimension(items, P(xChain, ys[i]!), P(xChain, ys[i + 1]!), formatFtIn(ys[i + 1]! - ys[i]!));
    dimension(items, P(xs[0]!, yChain - 450), P(xs[xs.length - 1]!, yChain - 450), formatFtIn(xs[xs.length - 1]! - xs[0]!));
    dimension(items, P(xChain - 450, ys[0]!), P(xChain - 450, ys[ys.length - 1]!), formatFtIn(ys[ys.length - 1]! - ys[0]!));
  }

  // Plot size
  text([X((plot.x0 + plot.x1) / 2), Y(plot.y1) - ROAD_DEPTH - 500], `PLOT ${formatFtIn(rectWidth(plot))} × ${formatFtIn(rectDepth(plot))}`, SMALL, { fill: "#555" });

  // North arrow, rotated so it points to true north
  const nc: Pt = [W - 900, 900];
  const a = (project.plot.northAngle * Math.PI) / 180;
  const rot = ([x, y]: Pt): Pt => [nc[0] + x * Math.cos(a) - y * Math.sin(a), nc[1] + x * Math.sin(a) + y * Math.cos(a)];
  items.push({ kind: "circle", c: nc, r: 420, stroke: "#000", sw: 20 });
  items.push({ kind: "poly", pts: ([[0, -380], [160, 250], [0, 140], [-160, 250]] as Pt[]).map(rot), closed: true, fill: "#000" });
  text([nc[0], nc[1] + 650], "N", TEXT, { bold: true });

  // Scale bar: 5 m in 1 m steps
  const sb: Pt = [600, H - 1050];
  for (let i = 0; i < 5; i++) items.push({ kind: "rect", x: sb[0] + i * 1000, y: sb[1], w: 1000, h: 90, fill: i % 2 ? "#ffffff" : "#000000", stroke: "#000", sw: 10 });
  for (let i = 0; i <= 5; i++) text([sb[0] + i * 1000, sb[1] + 230], `${i}`, SMALL - 20);
  text([sb[0] + 5000 + 300, sb[1] + 230], "m", SMALL - 20);

  // Advisory stamp
  const stamp: Pt = [W - 600 - 4300, H - 1150];
  items.push({ kind: "rect", x: stamp[0], y: stamp[1], w: 4300, h: 300, stroke: "#c0392b", sw: 20 });
  text([stamp[0] + 2150, stamp[1] + 150], ADVISORY_STAMP, SMALL - 30, { bold: true, fill: "#c0392b" });

  // Title block
  const rev = revisionLabel(project.version);
  const title = `${project.name} · ${level.name} floor plan · Scale 1:100 · Rev ${rev}`;
  text([W / 2, H - 450], title, TEXT, { bold: true });
  text([W / 2, H - 180], "Room sizes are clear internal dimensions; areas are carpet. Not for construction until signed off by a registered professional.", SMALL - 20, { fill: "#555" });

  return { title, width: W, height: H, scale: 100, items };
}

/** The floor plan as SVG sized to print at 1:100. */
export function renderFloorPlanSvg(project: Project, levelId: string, opts: FloorPlanOptions = {}): string {
  return sheetToSvg(floorPlanSheet(project, levelId, opts));
}

/** A band of the given depth outside one side of a rectangle. */
function outside(r: Rect, side: Side, depth: number): Rect {
  switch (side) {
    case "north":
      return { x0: r.x0, x1: r.x1, y0: r.y1, y1: r.y1 + depth };
    case "south":
      return { x0: r.x0, x1: r.x1, y0: r.y0 - depth, y1: r.y0 };
    case "east":
      return { x0: r.x1, x1: r.x1 + depth, y0: r.y0, y1: r.y1 };
    case "west":
      return { x0: r.x0 - depth, x1: r.x0, y0: r.y0, y1: r.y1 };
  }
}

function distanceTo(plot: Rect, inner: Rect, side: Side): number {
  return { north: plot.y1 - inner.y1, south: inner.y0 - plot.y0, east: plot.x1 - inner.x1, west: inner.x0 - plot.x0 }[side];
}

function wallRect(w: Wall, a: number, b: number): Rect {
  const h = w.thickness / 2;
  return w.orient === "h" ? { x0: a, x1: b, y0: w.at - h, y1: w.at + h } : { x0: w.at - h, x1: w.at + h, y0: a, y1: b };
}

function subtract(a: number, b: number, gaps: readonly (readonly [number, number])[]): [number, number][] {
  let pieces: [number, number][] = [[a, b]];
  for (const [g0, g1] of gaps) {
    pieces = pieces.flatMap(([p0, p1]): [number, number][] => {
      if (g1 <= p0 || g0 >= p1) return [[p0, p1]];
      const parts: [number, number][] = [
        [p0, g0],
        [g1, p1],
      ];
      return parts.filter(([s, e]) => e - s > 1);
    });
  }
  return pieces;
}

function dimension(items: Item[], a: Pt, b: Pt, label: string): void {
  const vertical = a[0] === b[0];
  const tick = ([x, y]: Pt): Item => ({ kind: "line", a: [x - 80, y + 80], b: [x + 80, y - 80], stroke: "#000", sw: 15 });
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  items.push({ kind: "line", a, b, stroke: "#000", sw: 10 }, tick(a), tick(b));
  items.push(vertical ? { kind: "text", at: [mid[0] - 110, mid[1]], text: label, size: SMALL, rotate: -90 } : { kind: "text", at: [mid[0], mid[1] - 110], text: label, size: SMALL });
}

const uniq = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** All levels of the project as one PDF, one page per level, each at 1:100 where the paper allows. */
export function renderFloorPlanPdf(project: Project, opts: FloorPlanOptions & { paper?: Paper } = {}): Uint8Array {
  return sheetsToPdf(project.levels.map((l) => floorPlanSheet(project, l.id, opts)), { paper: opts.paper });
}
