/**
 * Internal detail elevations at 1:25: the view of one wall of a room with the
 * joinery against it drawn to size, the kind of sheet a carpenter works from.
 * Kitchen counters get base units, a counter, a dado and wall cabinets; a
 * wardrobe wall gets its shutters and loft; a TV wall gets the unit and its
 * points. Sizes come from the catalogue and the model, so a detail cannot
 * drift from the plan.
 */
import { catalogueItem, type CatalogueItem } from "../catalogue/catalogue.js";
import { itemRect } from "../model/furnishing.js";
import { isHorizontal, OPPOSITE, rectDepth, rectWidth, sideSegment, type Rect } from "../model/geometry.js";
import { MEP_LABELS, STANDARD_HEIGHT } from "../model/mep.js";
import type { MepPoint, PlacedItem, Project, Room, Side } from "../model/schema.js";
import { formatFtIn } from "../model/units.js";
import { clearRect, deriveWalls, resolveOpening, roomRect } from "../model/walls.js";
import { SMALL, TEXT, titleBlock } from "./frame.js";
import type { Item, Pt, Sheet } from "./sheet.js";

/** Standard kitchen heights, mm. */
export const COUNTER_H = 850;
export const COUNTER_DEPTH = 600;
export const DADO_H = 1500;
export const WALL_UNIT_BOTTOM = 1400;
export const WALL_UNIT_H = 700;
/** Wardrobe loft over the shutters. */
export const LOFT_H = 450;

export interface DetailSpec {
  room: string;
  side: Side;
  /** What the wall is about; chosen automatically when not given. */
  kind?: "kitchen" | "wardrobe" | "tv" | "wall";
  title?: string;
}

const KIND_TITLE = { kitchen: "Kitchen elevation", wardrobe: "Wardrobe elevation", tv: "TV unit elevation", wall: "Internal elevation" } as const;

/** Items standing against one side of a room, with their extent along that wall. */
function itemsOnWall(project: Project, room: Room, side: Side): { it: PlacedItem; cat: CatalogueItem; u0: number; u1: number }[] {
  const seg = sideSegment(roomRect(room), side);
  const out: { it: PlacedItem; cat: CatalogueItem; u0: number; u1: number }[] = [];
  for (const it of project.items.filter((x) => x.room === room.id)) {
    const cat = catalogueItem(it.catalogue);
    if (!cat) continue;
    const r = itemRect(it, cat);
    // Only what stands with its back to this wall, so one piece does not appear on two elevations
    if (OPPOSITE[it.facing] !== side) continue;
    const near = isHorizontal(side) ? (side === "north" ? seg.at - r.y1 : r.y0 - seg.at) : side === "east" ? seg.at - r.x1 : r.x0 - seg.at;
    if (Math.abs(near) > 900) continue;
    out.push({ it, cat, u0: isHorizontal(side) ? r.x0 : r.y0, u1: isHorizontal(side) ? r.x1 : r.y1 });
  }
  return out.sort((a, b) => a.u0 - b.u0);
}

/** Which detail a wall deserves, from the room type and what stands against it. */
export function detailKind(project: Project, room: Room, side: Side): DetailSpec["kind"] {
  const items = itemsOnWall(project, room, side);
  if (room.type === "kitchen") return "kitchen";
  if (items.some((x) => x.cat.symbol === "wardrobe")) return "wardrobe";
  if (items.some((x) => x.cat.id.startsWith("unit.tv"))) return "tv";
  return "wall";
}

/** The walls worth a detail: kitchen counters, wardrobe walls and TV walls. */
export function detailSpecs(project: Project): DetailSpec[] {
  const out: DetailSpec[] = [];
  for (const level of project.levels) {
    const walls = deriveWalls(project, level.id);
    for (const room of project.rooms.filter((r) => r.level === level.id)) {
      for (const side of ["north", "east", "south", "west"] as Side[]) {
        const kind = detailKind(project, room, side);
        if (kind === "wall") continue;
        if (kind === "kitchen") {
          // The longest run clear of doors and windows
          const seg = sideSegment(roomRect(room), side);
          const open = project.openings.filter((o) => o.host.room === room.id && o.host.side === side).reduce((s, o) => s + o.width, 0);
          if (seg.end - seg.start - open < 1200) continue;
        }
        if (!itemsOnWall(project, room, side).length && kind !== "kitchen") continue;
        out.push({ room: room.id, side, kind });
        if (kind === "kitchen") break; // one kitchen elevation per room
      }
    }
  }
  return out;
}

/** One detail elevation at 1:25. */
export function detailSheet(project: Project, spec: DetailSpec): Sheet {
  const room = project.rooms.find((r) => r.id === spec.room);
  if (!room) throw new Error(`No room ${spec.room}`);
  const level = project.levels.find((l) => l.id === room.level)!;
  const walls = deriveWalls(project, room.level);
  const c = clearRect(walls, room);
  const kind = spec.kind ?? detailKind(project, room, spec.side) ?? "wall";
  const side = spec.side;
  const horizontal = isHorizontal(side);
  const length = horizontal ? rectWidth(c) : rectDepth(c);
  const ceiling = level.floorToFloor - level.slabThickness;
  const u0 = horizontal ? c.x0 : c.y0;

  // Sheet at 1:25: the wall, a margin, the height labels down the right, and
  // room under it for the dimension line, scale bar, stamp and title block.
  const MARGIN = 900;
  const LABELS = 3200;
  const BELOW = 2600;
  // Wide enough for the title block's own furniture at this scale
  const W = Math.max(length + 2 * MARGIN + LABELS, 13000);
  const H = ceiling + MARGIN + BELOW;
  const items: Item[] = [];
  const X = (u: number) => MARGIN + (side === "north" || side === "west" ? length - (u - u0) : u - u0);
  const Z = (z: number) => MARGIN + ceiling - z;
  const text = (at: Pt, s: string, size = SMALL, o: { bold?: boolean; fill?: string; align?: "start" | "end" } = {}) => items.push({ kind: "text", at, text: s, size, ...o });
  const rect = (ua: number, ub: number, z0: number, z1: number, style: Partial<Item & { fill: string; stroke: string; sw: number }> = {}) => {
    const a = Math.min(X(ua), X(ub));
    const b = Math.max(X(ua), X(ub));
    items.push({ kind: "rect", x: a, y: Z(z1), w: b - a, h: z1 - z0, stroke: "#000", sw: 12, ...(style as object) } as Item);
  };

  // Wall, floor and ceiling
  items.push({ kind: "rect", x: MARGIN, y: Z(ceiling), w: length, h: ceiling, fill: "#faf9f6", stroke: "#000", sw: 20 });
  items.push({ kind: "line", a: [MARGIN - 300, Z(0)], b: [MARGIN + length + 300, Z(0)], stroke: "#000", sw: 35 });
  items.push({ kind: "line", a: [MARGIN - 300, Z(ceiling)], b: [MARGIN + length + 300, Z(ceiling)], stroke: "#000", sw: 25 });

  // Openings in this wall, so the joinery is seen to clear them
  for (const o of project.openings.filter((o) => o.host.room === room.id && o.host.side === side)) {
    const r = resolveOpening(project, walls, o);
    if (!r) continue;
    const [a, b] = horizontal ? [r.from, r.to] : [r.from, r.to];
    rect(a, b, o.sill, o.sill + o.height, { fill: o.type === "door" ? "#ffffff" : "#eaf2f8", sw: 20 });
    text([(X(a) + X(b)) / 2, Z(o.sill + o.height / 2)], o.type.toUpperCase(), SMALL, { fill: "#555" });
  }

  const onWall = itemsOnWall(project, room, side);

  if (kind === "kitchen") {
    // Counter with base units, dado, and wall cabinets where nothing is in the way
    const runs = clearRuns(project, room, side, c);
    for (const [a, b] of runs) {
      rect(a, b, 0, COUNTER_H - 40, { fill: "#f3ede3" });
      rect(a, b, COUNTER_H - 40, COUNTER_H, { fill: "#4a4a4a", stroke: "#000" });
      // Base unit shutters, 600 wide
      for (let u = a; u < b - 50; u += 600) rect(u, Math.min(u + 600, b), 80, COUNTER_H - 120, { fill: "none", sw: 8 });
      rect(a, b, COUNTER_H, DADO_H, { fill: "#eef4f6", sw: 8 });
      text([(X(a) + X(b)) / 2, Z((COUNTER_H + DADO_H) / 2)], "DADO TILE", SMALL - 20, { fill: "#777" });
      if (b - a >= 600) {
        rect(a, b, WALL_UNIT_BOTTOM, WALL_UNIT_BOTTOM + WALL_UNIT_H, { fill: "#f3ede3" });
        for (let u = a; u < b - 50; u += 600) rect(u, Math.min(u + 600, b), WALL_UNIT_BOTTOM + 40, WALL_UNIT_BOTTOM + WALL_UNIT_H - 40, { fill: "none", sw: 8 });
      }
    }
    if (runs.length) {
      const [a, b] = runs[0]!;
      text([(X(a) + X(b)) / 2, Z(COUNTER_H / 2)], `COUNTER ${COUNTER_H} AFF, ${COUNTER_DEPTH} DEEP`, SMALL, { bold: true });
    }
  }

  for (const { it, cat, u0: a, u1: b } of onWall) {
    if (cat.category === "module" || cat.symbol === "appliance") {
      if (kind === "kitchen") {
        text([(X(a) + X(b)) / 2, Z(COUNTER_H / 2)], cat.name.toUpperCase(), SMALL - 20, { bold: true });
        continue;
      }
    }
    const top = cat.height || 2100;
    rect(a, b, 0, top, { fill: "#f3ede3" });
    if (cat.symbol === "wardrobe") {
      const shutters = Math.max(1, Math.round((b - a) / 600));
      for (let i = 0; i < shutters; i++) rect(a + ((b - a) * i) / shutters, a + ((b - a) * (i + 1)) / shutters, 60, top - 60, { fill: "none", sw: 8 });
      rect(a, b, top, Math.min(ceiling, top + LOFT_H), { fill: "#ece5d8" });
      text([(X(a) + X(b)) / 2, Z(top + LOFT_H / 2)], "LOFT", SMALL - 20, { fill: "#777" });
    }
    text([(X(a) + X(b)) / 2, Z(top / 2)], cat.name.toUpperCase(), SMALL, { bold: true });
    text([(X(a) + X(b)) / 2, Z(top / 2) + SMALL * 1.3], `${formatFtIn(b - a)} × ${formatFtIn(top)} high`, SMALL - 20, { fill: "#555" });
  }

  // Electrical and plumbing points on this wall, at their heights
  pointsOnWall(project, room, side, c).forEach((p, i) => {
    const u = horizontal ? p.at[0] : p.at[1];
    const z = p.heightMm || STANDARD_HEIGHT[p.kind];
    items.push({ kind: "circle", c: [X(u), Z(z)], r: 90, fill: "#ffffff", stroke: "#d35400", sw: 14 });
    // Stagger the labels so points side by side stay readable
    text([X(u), Z(z) - 200 - (i % 2) * 230], MEP_LABELS[p.kind], SMALL - 40, { fill: "#d35400" });
  });

  // Dimensions: wall length and the key heights
  const dimY = Z(0) + 420;
  items.push({ kind: "line", a: [MARGIN, dimY], b: [MARGIN + length, dimY], stroke: "#000", sw: 10 });
  text([MARGIN + length / 2, dimY - 120], formatFtIn(length), SMALL, { bold: true });
  const heights: [number, string][] = kind === "kitchen" ? [[COUNTER_H, "counter"], [DADO_H, "dado"], [WALL_UNIT_BOTTOM, "wall units"], [ceiling, "ceiling"]] : [[ceiling, "ceiling"]];
  const labelX = MARGIN + length + 320;
  let lastLabelY = -Infinity;
  for (const [z, name] of [...heights].sort((a, b) => b[0] - a[0])) {
    items.push({ kind: "line", a: [labelX - 120, Z(0)], b: [labelX - 120, Z(z)], stroke: "#555", sw: 8, dash: [120, 80] });
    items.push({ kind: "line", a: [labelX - 220, Z(z)], b: [labelX - 60, Z(z)], stroke: "#555", sw: 10 });
    const ly = Math.max(Z(z), lastLabelY + SMALL * 1.3);
    lastLabelY = ly;
    text([labelX, ly], `${formatFtIn(z)} ${name}`, SMALL - 20, { align: "start", fill: "#555" });
  }

  const title = spec.title ?? `${room.name} · ${side} wall · ${KIND_TITLE[kind]}`;
  const sheet = titleBlock(items, W, H, project, title, "Joinery sizes are from the catalogue and the model; the carpenter confirms on site before cutting.", { north: false, scaleText: "Scale 1:25" });
  return { ...sheet, scale: 25 };
}

/** Every detail elevation the model earns. */
export function detailSheets(project: Project): Sheet[] {
  return detailSpecs(project).map((spec) => detailSheet(project, spec));
}

/** Runs of a wall with no door or window, where counters and cabinets can go. */
function clearRuns(project: Project, room: Room, side: Side, c: Rect): [number, number][] {
  const horizontal = isHorizontal(side);
  const start = horizontal ? c.x0 : c.y0;
  const end = horizontal ? c.x1 : c.y1;
  const walls = deriveWalls(project, room.level);
  const gaps: [number, number][] = [];
  for (const o of project.openings.filter((o) => o.host.room === room.id && o.host.side === side)) {
    const r = resolveOpening(project, walls, o);
    if (!r) continue;
    if (o.type === "door" || o.type === "opening" || o.sill < COUNTER_H) gaps.push([r.from, r.to]);
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  let at = start;
  for (const [a, b] of gaps) {
    if (a - at > 300) runs.push([at, a]);
    at = Math.max(at, b);
  }
  if (end - at > 300) runs.push([at, end]);
  return runs;
}

function pointsOnWall(project: Project, room: Room, side: Side, c: Rect): MepPoint[] {
  const horizontal = isHorizontal(side);
  const at = side === "north" ? c.y1 : side === "south" ? c.y0 : side === "east" ? c.x1 : c.x0;
  return project.mep.filter((p) => {
    if (p.room !== room.id || p.kind === "light" || p.kind === "fan") return false;
    const across = horizontal ? p.at[1] : p.at[0];
    return Math.abs(across - at) < 400;
  });
}
