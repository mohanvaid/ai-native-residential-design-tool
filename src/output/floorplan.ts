/**
 * Floor plan sheet: a pure function of one model version and one level.
 * Drawn in model millimetres as a display list (./sheet.ts), so the same
 * drawing renders to SVG and PDF. Room sizes are clear (wall face to wall
 * face) in ft-in, areas in sq ft and m², as Chennai clients read them.
 */
import { boundaryToRect, OUTWARD, rectArea, rectDepth, rectWidth, type Rect } from "../model/geometry.js";
import type { Project, RoomType } from "../model/schema.js";
import { formatFtIn, sqmToSqft } from "../model/units.js";
import { clearRect, deriveWalls, resolveOpening, type ResolvedOpening, type Wall } from "../model/walls.js";
import { catalogueItem } from "../catalogue/catalogue.js";
import { itemRect } from "../model/furnishing.js";
import { drawPlacedItem } from "./symbols.js";
import { drawStair, drawStructure, drawTree, sheetFrame, SMALL, TEXT } from "./frame.js";
import { sheetsToPdf, type Paper } from "./pdf.js";
import { marksById } from "./schedule.js";
import { sheetToSvg, type Item, type Pt, type Sheet } from "./sheet.js";
import { siteplanSheet } from "./siteplan.js";

export { ADVISORY_STAMP } from "./frame.js";

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
  const fr = sheetFrame(project, opts);
  const { items, plot, X, Y, P, box, text } = fr;
  const levelIdx = project.levels.findIndex((l) => l.id === levelId);

  const rooms = project.rooms.filter((r) => r.level === levelId && boundaryToRect(r.boundary));
  const walls = deriveWalls(project, levelId);
  const resolved = project.openings
    .filter((o) => rooms.some((r) => r.id === o.host.room))
    .map((o) => resolveOpening(project, walls, o))
    .filter((r): r is ResolvedOpening => r !== null);
  const marks = marksById(project);

  // Trees: full zones on the lowest level, canopies above
  for (const t of project.trees) drawTree(fr, t, { zones: levelIdx === 0 });

  // Room fills
  for (const room of rooms) items.push({ kind: "rect", ...box(clearRect(walls, room)), fill: ROOM_FILL[room.type] ?? "#f4f4f4" });

  // Furniture, fixtures and vehicles
  for (const it of project.items) {
    const cat = catalogueItem(it.catalogue);
    if (cat && rooms.some((r) => r.id === it.room)) drawPlacedItem(fr, it, cat);
  }

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

  // Stairs: going up from this level, and the well of the one arriving here
  for (const st of project.stairs) {
    if (st.fromLevel === levelId) drawStair(fr, project, st, "UP");
    else if (st.toLevel === levelId) drawStair(fr, project, st, "DN");
  }

  // Columns and grid
  drawStructure(fr, project, levelId);

  // Room tags
  const obstacles = [
    ...project.stairs.filter((st) => st.fromLevel === levelId || st.toLevel === levelId).map((st) => boundaryToRect(st.boundary)),
    ...project.items.filter((it) => rooms.some((r) => r.id === it.room)).map((it) => {
      const cat = catalogueItem(it.catalogue);
      return cat ? itemRect(it, cat) : null;
    }),
  ].filter((r): r is Rect => r !== null);
  for (const room of rooms) {
    const c = clearRect(walls, room);
    const t = tagSpot(c, obstacles);
    const [cx, cy] = P((t.x0 + t.x1) / 2, (t.y0 + t.y1) / 2);
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

  return fr.finish(`${level.name} floor plan`, "Room sizes are clear internal dimensions; areas are carpet. Not for construction until signed off by a registered professional.");
}

/** The floor plan as SVG sized to print at 1:100. */
export function renderFloorPlanSvg(project: Project, levelId: string, opts: FloorPlanOptions = {}): string {
  return sheetToSvg(floorPlanSheet(project, levelId, opts));
}

/** Where to put a room's tag: the largest part of the room left clear of stair wells and furniture. */
function tagSpot(room: Rect, obstacles: Rect[]): Rect {
  let spot = room;
  for (const ob of obstacles) {
    if (!(ob.x0 < spot.x1 && ob.x1 > spot.x0 && ob.y0 < spot.y1 && ob.y1 > spot.y0)) continue;
    const strips: Rect[] = [
      { ...spot, x1: Math.max(spot.x0, ob.x0) },
      { ...spot, x0: Math.min(spot.x1, ob.x1) },
      { ...spot, y1: Math.max(spot.y0, ob.y0) },
      { ...spot, y0: Math.min(spot.y1, ob.y1) },
    ];
    const best = strips.sort((a, b) => rectArea(b) - rectArea(a))[0]!;
    // Keep the tag on the room when the leftover strip is too thin to read
    if (Math.min(rectWidth(best), rectDepth(best)) < 700) continue;
    spot = best;
  }
  return spot;
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

/** Every plan sheet in order: the site plan, then one floor plan per level. */
export function planSheets(project: Project, opts: FloorPlanOptions = {}): Sheet[] {
  return [siteplanSheet(project), ...project.levels.map((l) => floorPlanSheet(project, l.id, opts))];
}

/** The site plan and every floor plan as one PDF, each page at 1:100 where the paper allows. */
export function renderFloorPlanPdf(project: Project, opts: FloorPlanOptions & { paper?: Paper } = {}): Uint8Array {
  return sheetsToPdf(planSheets(project, opts), { paper: opts.paper });
}
