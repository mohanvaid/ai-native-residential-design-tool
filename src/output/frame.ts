/**
 * What every plan sheet shares: the plot in its frame with roads, setback
 * lines, north arrow, scale bar, advisory stamp and title block, plus the
 * symbols for site features and structure that more than one sheet draws.
 */
import { revisionLabel } from "../agent/report.js";
import { buildingExtent } from "../model/areas.js";
import { bbox, rectDepth, rectWidth, type Rect } from "../model/geometry.js";
import type { Project, Side, Stair, Tree } from "../model/schema.js";
import { columnRect, columnsOn, stairLayout, structuralGrid, type StairLayout } from "../model/structure.js";
import { formatFtIn, formatMetres } from "../model/units.js";
import { rulePacksFor } from "../rules/registry.js";
import type { Item, Pt, Sheet } from "./sheet.js";

export const MARGIN = 3200;
const ROAD_DEPTH = 1200;
export const TEXT = 220;
export const SMALL = 170;

export const ADVISORY_STAMP = "ADVISORY · NOT FOR CONSTRUCTION OR APPROVAL";

export interface Frame {
  items: Item[];
  plot: Rect;
  W: number;
  H: number;
  X: (x: number) => number;
  Y: (y: number) => number;
  P: (x: number, y: number) => Pt;
  box: (r: Rect) => { x: number; y: number; w: number; h: number };
  text: (at: Pt, s: string, size: number, o?: { rotate?: number; bold?: boolean; fill?: string }) => void;
  /** Adds the title block and returns the finished sheet. */
  finish: (title: string, note: string) => Sheet;
}

export function sheetFrame(project: Project, opts: { showSetbacks?: boolean } = {}): Frame {
  const plot = bbox(project.plot.boundary);
  const ox = plot.x0 - MARGIN;
  const oy = plot.y1 + MARGIN;
  const W = rectWidth(plot) + 2 * MARGIN;
  const H = rectDepth(plot) + 2 * MARGIN;
  const X = (x: number) => x - ox;
  const Y = (y: number) => oy - y;
  const P = (x: number, y: number): Pt => [X(x), Y(y)];
  const box = (r: Rect) => ({ x: X(r.x0), y: Y(r.y1), w: rectWidth(r), h: rectDepth(r) });
  const items: Item[] = [];
  const text: Frame["text"] = (at, s, size, o = {}) => items.push({ kind: "text", at, text: s, size, ...o });

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

  // Plot size
  text([X((plot.x0 + plot.x1) / 2), Y(plot.y1) - ROAD_DEPTH - 500], `PLOT ${formatFtIn(rectWidth(plot))} × ${formatFtIn(rectDepth(plot))}`, SMALL, { fill: "#555" });

  const finish = (title: string, note: string): Sheet => titleBlock(items, W, H, project, title, note);

  return { items, plot, W, H, X, Y, P, box, text, finish };
}

/**
 * North arrow (when asked), 5 m scale bar, advisory stamp and title block
 * along the bottom of a W × H sheet drawn at 1:100.
 */
export function titleBlock(items: Item[], W: number, H: number, project: Project, title: string, note: string, opts: { north?: boolean; scaleText?: string } = {}): Sheet {
  const text = (at: Pt, s: string, size: number, o: { rotate?: number; bold?: boolean; fill?: string } = {}) => items.push({ kind: "text", at, text: s, size, ...o });
  if (opts.north !== false) {
    // North arrow, rotated so it points to true north
    const nc: Pt = [W - 900, 900];
    const a = (project.plot.northAngle * Math.PI) / 180;
    const rot = ([x, y]: Pt): Pt => [nc[0] + x * Math.cos(a) - y * Math.sin(a), nc[1] + x * Math.sin(a) + y * Math.cos(a)];
    items.push({ kind: "circle", c: nc, r: 420, stroke: "#000", sw: 20 });
    items.push({ kind: "poly", pts: ([[0, -380], [160, 250], [0, 140], [-160, 250]] as Pt[]).map(rot), closed: true, fill: "#000" });
    text([nc[0], nc[1] + 650], "N", TEXT, { bold: true });
  }

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
  const full = `${project.name} · ${title} · ${opts.scaleText ?? "Scale 1:100"} · Rev ${revisionLabel(project.version)}`;
  text([W / 2, H - 450], full, TEXT, { bold: true });
  text([W / 2, H - 180], note, SMALL - 20, { fill: "#555" });
  return { title: full, width: W, height: H, scale: 100, items };
}

/** Tree: trunk, dashed canopy, dotted root zone (kept trees only) and a label. A tree to be removed is crossed out. */
export function drawTree(fr: Frame, t: Tree, opts: { zones?: boolean } = {}): void {
  const c = fr.P(t.at[0], t.at[1]);
  const green = t.keep ? "#2e7d32" : "#9e9e9e";
  fr.items.push({ kind: "circle", c, r: t.canopyRadius, stroke: green, sw: 20, dash: [160, 90] });
  if (t.keep && opts.zones !== false) fr.items.push({ kind: "circle", c, r: t.rootRadius, stroke: "#8d6e63", sw: 15, dash: [40, 80] });
  fr.items.push({ kind: "circle", c, r: 150, fill: green });
  if (!t.keep) {
    const d = t.canopyRadius * 0.5;
    fr.items.push({ kind: "line", a: [c[0] - d, c[1] - d], b: [c[0] + d, c[1] + d], stroke: "#9e9e9e", sw: 25 });
    fr.items.push({ kind: "line", a: [c[0] - d, c[1] + d], b: [c[0] + d, c[1] - d], stroke: "#9e9e9e", sw: 25 });
  }
  fr.text([c[0], c[1] + 380], `${t.species.toUpperCase()}${t.keep ? "" : " (TO REMOVE)"}`, SMALL, { bold: true, fill: green });
}

/** Stair: flights with treads, landing, and a walking line from the first riser. */
export function drawStair(fr: Frame, project: Project, s: Stair, label: "UP" | "DN" | null, lay: StairLayout | null = stairLayout(project, s)): void {
  if (!lay) return;
  const { P, items } = fr;
  items.push({ kind: "rect", ...fr.box(lay.well), fill: "#ffffff", stroke: "#000", sw: 20 });
  for (const fl of lay.flights) {
    items.push({ kind: "rect", ...fr.box(fl.rect), stroke: "#000", sw: 12 });
    for (const [a, b] of fl.nosings) items.push({ kind: "line", a: P(a[0], a[1]), b: P(b[0], b[1]), stroke: "#000", sw: 10 });
  }
  if (lay.landing) items.push({ kind: "rect", ...fr.box(lay.landing), stroke: "#000", sw: 12 });
  // Walking line through every flight, arrow at the top
  const path: Pt[] = [];
  const l = lay.landing;
  lay.flights.forEach((fl, i) => {
    const across = fl.dir === "east" || fl.dir === "west";
    // Turn through the middle of a half landing so the line reads as one walk.
    if (i > 0 && l && s.shape === "dog-leg") path.push(across ? P((l.x0 + l.x1) / 2, fl.start[1]) : P(fl.start[0], (l.y0 + l.y1) / 2));
    path.push(P(fl.start[0], fl.start[1]), P(fl.end[0], fl.end[1]));
    if (i === 0 && l && s.shape === "dog-leg") path.push(across ? P((l.x0 + l.x1) / 2, fl.end[1]) : P(fl.end[0], (l.y0 + l.y1) / 2));
  });
  items.push({ kind: "poly", pts: path, closed: false, stroke: "#000", sw: 12 });
  items.push({ kind: "circle", c: path[0]!, r: 60, fill: "#000" });
  const tip = path[path.length - 1]!;
  const prev = path[path.length - 2]!;
  const len = Math.hypot(tip[0] - prev[0], tip[1] - prev[1]) || 1;
  const [ux, uy] = [(tip[0] - prev[0]) / len, (tip[1] - prev[1]) / len];
  items.push({ kind: "poly", pts: [tip, [tip[0] - ux * 200 - uy * 90, tip[1] - uy * 200 + ux * 90], [tip[0] - ux * 200 + uy * 90, tip[1] - uy * 200 - ux * 90]], closed: true, fill: "#000" });
  if (label) {
    const first = lay.flights[0]!;
    const at = P(first.start[0], first.start[1]);
    const off = 260;
    const out: Record<Side, Pt> = { north: [0, off], south: [0, -off], east: [-off, 0], west: [off, 0] };
    fr.text([at[0] + out[first.dir][0], at[1] + out[first.dir][1]], label, SMALL, { bold: true });
  }
  const c = P((lay.well.x0 + lay.well.x1) / 2, (lay.well.y0 + lay.well.y1) / 2);
  if (l) {
    fr.text(P((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2), `${lay.risers}R @ ${Math.round(lay.riserHeight)}`, SMALL - 30, { fill: "#555" });
  } else fr.text(c, `${lay.risers}R @ ${Math.round(lay.riserHeight)}`, SMALL - 30, { fill: "#555" });
}

/** Columns standing on a level, solid black, and the grid with bubbles (letters along the top, numbers along the left). */
export function drawStructure(fr: Frame, project: Project, levelId: string | null): void {
  const cols = levelId ? columnsOn(project, levelId) : project.columns;
  if (!cols.length) return;
  const grid = structuralGrid(project);
  const top = fr.plot.y1 + 700;
  const left = fr.plot.x0 - 1700;
  for (const g of grid.x) {
    fr.items.push({ kind: "line", a: fr.P(g.at, fr.plot.y0), b: fr.P(g.at, top - 220), stroke: "#7a7a7a", sw: 8, dash: [300, 80, 40, 80] });
    fr.items.push({ kind: "circle", c: fr.P(g.at, top), r: 220, stroke: "#000", sw: 15, fill: "#ffffff" });
    fr.text(fr.P(g.at, top), g.label, SMALL, { bold: true });
  }
  for (const g of grid.y) {
    fr.items.push({ kind: "line", a: fr.P(left + 220, g.at), b: fr.P(fr.plot.x1, g.at), stroke: "#7a7a7a", sw: 8, dash: [300, 80, 40, 80] });
    fr.items.push({ kind: "circle", c: fr.P(left, g.at), r: 220, stroke: "#000", sw: 15, fill: "#ffffff" });
    fr.text(fr.P(left, g.at), g.label, SMALL, { bold: true });
  }
  for (const c of cols) fr.items.push({ kind: "rect", ...fr.box(columnRect(c)), fill: "#000000" });
}

/** A band of the given depth outside one side of a rectangle. */
export function outside(r: Rect, side: Side, depth: number): Rect {
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

export const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
