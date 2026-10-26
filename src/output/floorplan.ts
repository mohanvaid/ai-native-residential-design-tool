/**
 * Floor plan as SVG: a pure function of one model version and one level.
 * Drawn in model millimetres; the root width/height are set so that it prints
 * at 1:100. Room sizes are clear (wall face to wall face) in ft-in, areas in
 * sq ft and m², as Chennai clients read them.
 */
import { buildingExtent } from "../model/areas.js";
import { bbox, boundaryToRect, OUTWARD, rectArea, rectDepth, rectWidth, type Rect } from "../model/geometry.js";
import type { Project, RoomType, Side } from "../model/schema.js";
import { formatFtIn, formatMetres, sqmToSqft } from "../model/units.js";
import { clearRect, deriveWalls, resolveOpening, type ResolvedOpening, type Wall } from "../model/walls.js";
import { rulePacksFor } from "../rules/registry.js";
import { marksById } from "./schedule.js";

const MARGIN = 3200;
const ROAD_DEPTH = 1200;
const TEXT = 220;
const SMALL = 170;

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

export function renderFloorPlanSvg(project: Project, levelId: string, opts: FloorPlanOptions = {}): string {
  const level = project.levels.find((l) => l.id === levelId);
  if (!level) throw new Error(`No level ${levelId}`);
  const plot = bbox(project.plot.boundary);
  const ox = plot.x0 - MARGIN;
  const oy = plot.y1 + MARGIN;
  const W = rectWidth(plot) + 2 * MARGIN;
  const H = rectDepth(plot) + 2 * MARGIN;
  const X = (x: number) => round(x - ox);
  const Y = (y: number) => round(oy - y);

  const rooms = project.rooms.filter((r) => r.level === levelId && boundaryToRect(r.boundary));
  const walls = deriveWalls(project, levelId);
  const resolved = project.openings
    .filter((o) => rooms.some((r) => r.id === o.host.room))
    .map((o) => resolveOpening(project, walls, o))
    .filter((r): r is ResolvedOpening => r !== null);
  const marks = marksById(project);
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W / 100}mm" height="${H / 100}mm" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<defs><pattern id="brick" patternUnits="userSpaceOnUse" width="120" height="120" patternTransform="rotate(45)"><rect width="120" height="120" fill="#c9c9c9"/><line x1="0" y1="0" x2="0" y2="120" stroke="#555" stroke-width="22"/></pattern></defs>`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  );

  // Roads
  for (const road of project.plot.abuttingRoads) {
    const r = outside(plot, road.side, ROAD_DEPTH);
    out.push(`<rect x="${X(r.x0)}" y="${Y(r.y1)}" width="${rectWidth(r)}" height="${rectDepth(r)}" fill="#e4e4e4"/>`);
    const label = `ROAD ${road.widthM} m (${formatFtIn(road.widthM * 1000)})${road.name ? ` · ${esc(road.name)}` : ""}`;
    out.push(text(X((r.x0 + r.x1) / 2), Y((r.y0 + r.y1) / 2), label, TEXT, { rotate: road.side === "east" || road.side === "west" ? -90 : 0, weight: "bold", fill: "#555" }));
  }

  // Plot boundary
  out.push(`<polygon points="${project.plot.boundary.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}" fill="none" stroke="#000" stroke-width="40" stroke-dasharray="400 120 80 120"/>`);

  // Setback line and provided setbacks
  const pack = opts.showSetbacks === false ? undefined : rulePacksFor(project)[0];
  const env = pack?.derive(project);
  const extent = buildingExtent(project);
  if (env && env.setbacks.length) {
    const b = env.buildable;
    out.push(`<rect x="${X(b.x0)}" y="${Y(b.y1)}" width="${rectWidth(b)}" height="${rectDepth(b)}" fill="none" stroke="#c0392b" stroke-width="25" stroke-dasharray="200 100"/>`);
    if (extent) {
      for (const s of env.setbacks) {
        const gap = outside(extent, s.side, distanceTo(plot, extent, s.side));
        const provided = distanceTo(plot, extent, s.side);
        const req = s.requiredMm === null ? "req. ?" : `req. ${formatMetres(s.requiredMm)}${s.applies === "one_of_sides" ? " one side" : ""}`;
        const vertical = s.side === "east" || s.side === "west";
        out.push(text(X((gap.x0 + gap.x1) / 2), Y((gap.y0 + gap.y1) / 2), `${cap(s.role)} ${formatMetres(provided)} (${req})`, SMALL, { rotate: vertical ? -90 : 0, fill: "#c0392b" }));
      }
    }
  }

  // Room fills
  for (const room of rooms) {
    const c = clearRect(walls, room);
    out.push(`<rect x="${X(c.x0)}" y="${Y(c.y1)}" width="${rectWidth(c)}" height="${rectDepth(c)}" fill="${ROOM_FILL[room.type] ?? "#f4f4f4"}"/>`);
  }

  // Walls, with gaps at openings
  for (const w of walls) {
    const gaps = resolved.filter((r) => r.wall?.id === w.id).map((r) => [r.from, r.to] as const);
    for (const [a, b] of subtract(w.from - w.thickness / 2, w.to + w.thickness / 2, gaps)) {
      const r = wallRect(w, a, b);
      out.push(`<rect x="${X(r.x0)}" y="${Y(r.y1)}" width="${rectWidth(r)}" height="${rectDepth(r)}" fill="${w.isExternal ? "url(#brick)" : "#9a9a9a"}" stroke="#000" stroke-width="15"/>`);
    }
  }

  // Openings
  for (const r of resolved) {
    const t = r.wall?.thickness ?? 230;
    const o = r.opening;
    const P = (along: number, across: number) => (r.orient === "h" ? [X(along), Y(r.at + across)] : [X(r.at + across), Y(along)]);
    const line = (a: number[], b: number[], sw = 15) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#000" stroke-width="${sw}"/>`;
    if (o.type === "window" || o.type === "ventilator") {
      out.push(line(P(r.from, -t / 2), P(r.to, -t / 2)), line(P(r.from, t / 2), P(r.to, t / 2)));
      out.push(line(P(r.from, -t / 2), P(r.from, t / 2)), line(P(r.to, -t / 2), P(r.to, t / 2)));
      out.push(line(P(r.from, 0), P(r.to, 0), 10));
      if (o.type === "window") out.push(line(P(r.from, -t / 6), P(r.to, -t / 6), 10), line(P(r.from, t / 6), P(r.to, t / 6), 10));
    } else if (o.type === "door") {
      const out_ = OUTWARD[o.host.side];
      const outwardSign = r.orient === "h" ? out_[1] : out_[0];
      const dir = (o.swing?.into === "other" ? 1 : -1) * outwardSign;
      const hingeAt = o.swing?.hinge === "end" ? r.to : r.from;
      const jambAt = o.swing?.hinge === "end" ? r.from : r.to;
      const hinge = P(hingeAt, (dir * t) / 2);
      const tip = P(hingeAt, (dir * t) / 2 + dir * o.width);
      const jamb = P(jambAt, (dir * t) / 2);
      const cross = (tip[0]! - hinge[0]!) * (jamb[1]! - hinge[1]!) - (tip[1]! - hinge[1]!) * (jamb[0]! - hinge[0]!);
      out.push(line(hinge, tip, 20));
      out.push(`<path d="M ${tip[0]} ${tip[1]} A ${o.width} ${o.width} 0 0 ${cross > 0 ? 1 : 0} ${jamb[0]} ${jamb[1]}" fill="none" stroke="#000" stroke-width="10"/>`);
    } else {
      out.push(`<line x1="${P(r.from, 0)[0]}" y1="${P(r.from, 0)[1]}" x2="${P(r.to, 0)[0]}" y2="${P(r.to, 0)[1]}" stroke="#000" stroke-width="10" stroke-dasharray="80 60"/>`);
    }
    const mark = marks.get(o.id);
    if (mark) {
      const out_ = OUTWARD[o.host.side];
      const s = r.orient === "h" ? out_[1] : out_[0];
      const [mx, my] = P((r.from + r.to) / 2, s * (t / 2 + 260));
      out.push(text(mx!, my!, mark, SMALL, { weight: "bold" }));
    }
  }

  // Room tags
  for (const room of rooms) {
    const c = clearRect(walls, room);
    const cx = X((c.x0 + c.x1) / 2);
    const cy = Y((c.y0 + c.y1) / 2);
    const sqm = rectArea(c) / 1e6;
    out.push(text(cx, cy - TEXT * 1.1, esc(room.name.toUpperCase()), TEXT, { weight: "bold" }));
    out.push(text(cx, cy + TEXT * 0.1, `${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))}`, SMALL));
    out.push(text(cx, cy + TEXT * 1.1, `${Math.round(sqmToSqft(sqm))} sq ft · ${sqm.toFixed(1)} m²`, SMALL, { fill: "#555" }));
  }

  // Dimension chains (wall centrelines) and overall sizes
  if (rooms.length) {
    const rects = rooms.map((r) => boundaryToRect(r.boundary)!);
    const xs = uniq(rects.flatMap((r) => [r.x0, r.x1]));
    const ys = uniq(rects.flatMap((r) => [r.y0, r.y1]));
    // Outside the plot, so they never collide with the setback labels.
    const yChain = plot.y0 - 500;
    const xChain = plot.x0 - 500;
    for (let i = 0; i + 1 < xs.length; i++) out.push(dimension(X(xs[i]!), Y(yChain), X(xs[i + 1]!), Y(yChain), formatFtIn(xs[i + 1]! - xs[i]!)));
    for (let i = 0; i + 1 < ys.length; i++) out.push(dimension(X(xChain), Y(ys[i]!), X(xChain), Y(ys[i + 1]!), formatFtIn(ys[i + 1]! - ys[i]!)));
    out.push(dimension(X(xs[0]!), Y(yChain - 450), X(xs[xs.length - 1]!), Y(yChain - 450), formatFtIn(xs[xs.length - 1]! - xs[0]!)));
    out.push(dimension(X(xChain - 450), Y(ys[0]!), X(xChain - 450), Y(ys[ys.length - 1]!), formatFtIn(ys[ys.length - 1]! - ys[0]!)));
  }

  // Plot size
  out.push(text(X((plot.x0 + plot.x1) / 2), Y(plot.y1) - ROAD_DEPTH - 500, `PLOT ${formatFtIn(rectWidth(plot))} × ${formatFtIn(rectDepth(plot))}`, SMALL, { fill: "#555" }));

  // North arrow
  const nx = W - 900;
  const ny = 900;
  out.push(
    `<g transform="translate(${nx} ${ny}) rotate(${project.plot.northAngle})"><circle r="420" fill="none" stroke="#000" stroke-width="20"/><polygon points="0,-380 160,250 0,140 -160,250" fill="#000"/></g>`,
    text(nx, ny + 650, "N", TEXT, { weight: "bold" }),
  );

  // Title
  out.push(text(W / 2, H - 450, `${esc(project.name)} · ${esc(level.name)} floor plan · Scale 1:100 · v${project.version}`, TEXT, { weight: "bold" }));
  out.push(text(W / 2, H - 180, "Room sizes are clear internal dimensions. For estimation; verify before construction.", SMALL, { fill: "#555" }));

  out.push("</svg>");
  return out.join("\n");
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

function dimension(x1: number, y1: number, x2: number, y2: number, label: string): string {
  const vertical = x1 === x2;
  const tick = (x: number, y: number) => `<line x1="${x - 80}" y1="${y + 80}" x2="${x + 80}" y2="${y - 80}" stroke="#000" stroke-width="15"/>`;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return [
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="10"/>`,
    tick(x1, y1),
    tick(x2, y2),
    vertical ? text(mx - 110, my, label, SMALL, { rotate: -90 }) : text(mx, my - 110, label, SMALL),
  ].join("");
}

function text(x: number, y: number, s: string, size: number, o: { rotate?: number; weight?: string; fill?: string } = {}): string {
  const rot = o.rotate ? ` transform="rotate(${o.rotate} ${round(x)} ${round(y)})"` : "";
  return `<text x="${round(x)}" y="${round(y)}" font-size="${size}" text-anchor="middle" dominant-baseline="middle"${o.weight ? ` font-weight="${o.weight}"` : ""} fill="${o.fill ?? "#000"}"${rot}>${s}</text>`;
}

const round = (n: number) => Math.round(n * 10) / 10;
const uniq = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
