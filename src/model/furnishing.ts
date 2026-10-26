/**
 * Placed catalogue items: footprints, the clear space they need, door swing
 * zones, automatic placement ("put a queen bed in Bedroom 2") and the
 * clearance and door-swing checks.
 */
import { catalogueItem, type CatalogueItem } from "../catalogue/catalogue.js";
import { boundaryToRect, OPPOSITE, OUTWARD, overlapArea, rectDepth, rectWidth, type Rect } from "./geometry.js";
import type { Finding, PlacedItem, Point, Project, Room, Side } from "./schema.js";
import { formatFtIn } from "./units.js";
import { clearRect, deriveWalls, resolveOpening, type ResolvedOpening, type Wall } from "./walls.js";

const SOURCE = "core";
/** Shortfalls smaller than this are ignored, so a snug fit is not flagged. */
const TOLERANCE_MM = 25;
/** Narrowest comfortable passage, clear. */
export const MIN_PASSAGE_MM = 900;

const f = (severity: Finding["severity"], code: string, message: string, elements: string[]): Finding => ({
  severity,
  code,
  message,
  elements,
  source: SOURCE,
});

const across = (facing: Side) => facing === "east" || facing === "west";

/** The item's footprint. */
export function itemRect(it: Pick<PlacedItem, "at" | "facing">, cat: CatalogueItem): Rect {
  const [w, d] = across(it.facing) ? [cat.depth, cat.width] : [cat.width, cat.depth];
  return { x0: it.at[0] - w / 2, x1: it.at[0] + w / 2, y0: it.at[1] - d / 2, y1: it.at[1] + d / 2 };
}

type Zone = { where: "front" | "back" | "left side" | "right side"; dir: Side; need: number; rect: Rect };

/** The clear space an item needs, as bands around its footprint. */
export function clearanceZones(it: Pick<PlacedItem, "at" | "facing">, cat: CatalogueItem): Zone[] {
  const r = itemRect(it, cat);
  const band = (dir: Side, need: number): Rect => {
    switch (dir) {
      case "north":
        return { ...r, y0: r.y1, y1: r.y1 + need };
      case "south":
        return { ...r, y0: r.y0 - need, y1: r.y0 };
      case "east":
        return { ...r, x0: r.x1, x1: r.x1 + need };
      case "west":
        return { ...r, x0: r.x0 - need, x1: r.x0 };
    }
  };
  const front = it.facing;
  const left: Side = ({ north: "west", west: "south", south: "east", east: "north" } as const)[front];
  const zones: Zone[] = [
    { where: "front", dir: front, need: cat.clearance.front, rect: band(front, cat.clearance.front) },
    { where: "back", dir: OPPOSITE[front], need: cat.clearance.back, rect: band(OPPOSITE[front], cat.clearance.back) },
    { where: "left side", dir: left, need: cat.clearance.sides, rect: band(left, cat.clearance.sides) },
    { where: "right side", dir: OPPOSITE[left], need: cat.clearance.sides, rect: band(OPPOSITE[left], cat.clearance.sides) },
  ];
  return zones.filter((z) => z.need > 0);
}

export interface Swing {
  opening: ResolvedOpening;
  /** The room the door swings into, or null for outside. */
  room: string | null;
  /** Square swept by the leaf. */
  rect: Rect;
}

/** Door swing squares on a level. */
export function doorSwings(project: Project, levelId: string, walls: Wall[] = deriveWalls(project, levelId)): Swing[] {
  const rooms = new Set(project.rooms.filter((r) => r.level === levelId).map((r) => r.id));
  const out: Swing[] = [];
  for (const o of project.openings) {
    if (o.type !== "door" || !rooms.has(o.host.room)) continue;
    const r = resolveOpening(project, walls, o);
    if (!r) continue;
    const t = r.wall?.thickness ?? 230;
    const out1 = OUTWARD[o.host.side];
    const sign = (r.orient === "h" ? out1[1] : out1[0]) * (o.swing?.into === "other" ? 1 : -1);
    const a = r.at + (sign * t) / 2;
    const b = a + sign * o.width;
    const [c0, c1] = [Math.min(a, b), Math.max(a, b)];
    const rect = r.orient === "h" ? { x0: r.from, x1: r.to, y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: r.from, y1: r.to };
    out.push({ opening: r, room: o.swing?.into === "other" ? r.otherRoom : o.host.room, rect });
  }
  return out;
}

/** Depth of the clear approach kept on each side of a door or opening. */
export const APPROACH_MM = 600;

/** The space to walk through each door and opening on a level: its width, 600 mm deep on both sides of the wall. */
export function passageZones(project: Project, levelId: string, walls: Wall[] = deriveWalls(project, levelId)): { opening: ResolvedOpening; rect: Rect }[] {
  const rooms = new Set(project.rooms.filter((r) => r.level === levelId).map((r) => r.id));
  const out: { opening: ResolvedOpening; rect: Rect }[] = [];
  for (const o of project.openings) {
    if ((o.type !== "door" && o.type !== "opening") || !rooms.has(o.host.room)) continue;
    const r = resolveOpening(project, walls, o);
    if (!r) continue;
    const t = (r.wall?.thickness ?? 230) / 2;
    for (const sign of [-1, 1]) {
      const a = r.at + sign * t;
      const b = a + sign * APPROACH_MM;
      const [c0, c1] = [Math.min(a, b), Math.max(a, b)];
      out.push({ opening: r, rect: r.orient === "h" ? { x0: r.from, x1: r.to, y0: c0, y1: c1 } : { x0: c0, x1: c1, y0: r.from, y1: r.to } });
    }
  }
  return out;
}

export interface PlaceConstraints {
  /** Put the item's back against this wall of the room. */
  against?: Side;
  /** Direction the front faces (ignored when `against` is given). */
  facing?: Side;
  /** Along the wall from its west or south end to the item's near edge, mm. */
  offset?: number;
  align?: "start" | "centre" | "end";
  /** Explicit centre, mm. */
  x?: number;
  y?: number;
}

/**
 * Where to put an item in a room. With no wall given it tries every wall,
 * those without doors first, and takes the first spot where the item and
 * its clear space fit without touching other items or door swings.
 */
export function placeItem(project: Project, room: Room, cat: CatalogueItem, c: PlaceConstraints, ignore?: string): { at: Point; facing: Side } | { error: string } {
  const walls = deriveWalls(project, room.level);
  const clear = clearRect(walls, room);
  const others = project.items.filter((i) => i.room !== undefined && i.id !== ignore && project.rooms.find((r) => r.id === i.room)?.level === room.level);
  const swings = [...doorSwings(project, room.level, walls), ...passageZones(project, room.level, walls)];
  const wells = stairWells(project, room.level);
  const fits = (at: Point, facing: Side, strict: boolean) => {
    const fp = itemRect({ at, facing }, cat);
    if (wells.some((w) => overlapArea(fp, w) > 0)) return false;
    if (fp.x0 < clear.x0 - 1 || fp.x1 > clear.x1 + 1 || fp.y0 < clear.y0 - 1 || fp.y1 > clear.y1 + 1) return false;
    for (const o of others) {
      const oc = catalogueItem(o.catalogue);
      if (oc && overlapArea(fp, itemRect(o, oc)) > 0) return false;
    }
    if (swings.some((s) => overlapArea(fp, s.rect) > 0)) return false;
    if (!strict) return true;
    for (const z of clearanceZones({ at, facing }, cat)) {
      const inside = { x0: Math.max(z.rect.x0, clear.x0), x1: Math.min(z.rect.x1, clear.x1), y0: Math.max(z.rect.y0, clear.y0), y1: Math.min(z.rect.y1, clear.y1) };
      if (rectWidth(inside) < rectWidth(z.rect) - TOLERANCE_MM || rectDepth(inside) < rectDepth(z.rect) - TOLERANCE_MM) return false;
      for (const o of others) {
        const oc = catalogueItem(o.catalogue);
        if (oc && overlapArea(z.rect, itemRect(o, oc)) > 0) return false;
      }
    }
    return true;
  };

  if (c.x !== undefined && c.y !== undefined) return { at: [c.x, c.y], facing: c.facing ?? "north" };

  const spot = (against: Side, align: "start" | "centre" | "end" | number): { at: Point; facing: Side } => {
    const facing = OPPOSITE[against];
    const fp = itemRect({ at: [0, 0], facing }, cat);
    const [w, d] = [rectWidth(fp), rectDepth(fp)];
    const horizontalWall = against === "north" || against === "south";
    const lo = horizontalWall ? clear.x0 : clear.y0;
    const hi = horizontalWall ? clear.x1 : clear.y1;
    const len = horizontalWall ? w : d;
    const start = typeof align === "number" ? lo + align : align === "start" ? lo : align === "end" ? hi - len : (lo + hi - len) / 2;
    const along = Math.round(start + len / 2);
    switch (against) {
      case "north":
        return { at: [along, Math.round(clear.y1 - d / 2)], facing };
      case "south":
        return { at: [along, Math.round(clear.y0 + d / 2)], facing };
      case "east":
        return { at: [Math.round(clear.x1 - w / 2), along], facing };
      case "west":
        return { at: [Math.round(clear.x0 + w / 2), along], facing };
    }
  };

  if (c.against) return spot(c.against, c.offset ?? c.align ?? "centre");

  const doorsOn = (side: Side) => project.openings.filter((o) => o.host.room === room.id && o.host.side === side && o.type === "door").length;
  const sides = (["north", "south", "east", "west"] as Side[])
    .filter((s) => !c.facing || OPPOSITE[s] === c.facing)
    .sort((a, b) => doorsOn(a) - doorsOn(b) || wallLength(clear, b) - wallLength(clear, a));
  // Items that need space behind them too (a dining table, a swing) stand free: try the middle of the room first.
  const centre: Point = [Math.round((clear.x0 + clear.x1) / 2), Math.round((clear.y0 + clear.y1) / 2)];
  const freeFacings: Side[] = c.facing ? [c.facing] : rectWidth(clear) >= rectDepth(clear) ? ["north", "east"] : ["east", "north"];
  for (const strict of [true, false]) {
    if (cat.clearance.back > 0) for (const facing of freeFacings) if (fits(centre, facing, strict)) return { at: centre, facing };
    for (const side of sides) {
      for (const align of ["centre", "start", "end"] as const) {
        const s = spot(side, align);
        if (fits(s.at, s.facing, strict)) return s;
      }
    }
  }
  return {
    error: `A ${cat.name.toLowerCase()} (${formatFtIn(cat.width)} × ${formatFtIn(cat.depth)}) does not fit in ${room.name} (${formatFtIn(rectWidth(clear))} × ${formatFtIn(rectDepth(clear))} clear) without hitting a wall, a door swing or other furniture.`,
  };
}

/** Stair wells that take floor space on a level: the stair going up from it and the opening of the one arriving. */
export function stairWells(project: Project, levelId: string): Rect[] {
  return project.stairs
    .filter((s) => s.fromLevel === levelId || s.toLevel === levelId)
    .map((s) => boundaryToRect(s.boundary))
    .filter((r): r is Rect => r !== null);
}

const wallLength = (r: Rect, side: Side) => (side === "north" || side === "south" ? rectWidth(r) : rectDepth(r));

export function validateFurnishing(project: Project): Finding[] {
  const out: Finding[] = [];
  const byLevel = new Map<string, { item: PlacedItem; cat: CatalogueItem; rect: Rect; room: Room }[]>();
  const wallsByLevel = new Map(project.levels.map((l) => [l.id, deriveWalls(project, l.id)] as const));

  for (const it of project.items) {
    const cat = catalogueItem(it.catalogue);
    const room = project.rooms.find((r) => r.id === it.room);
    if (!cat) {
      out.push(f("block", "item.catalogue_missing", `${it.id} uses "${it.catalogue}", which is not in the catalogue.`, [it.id]));
      continue;
    }
    if (!room || !boundaryToRect(room.boundary)) {
      out.push(f("block", "item.room_missing", `The ${cat.name.toLowerCase()} ${it.id} is in a room that does not exist.`, [it.id]));
      continue;
    }
    const rect = itemRect(it, cat);
    const clear = clearRect(wallsByLevel.get(room.level) ?? [], room);
    if (rect.x0 < clear.x0 - 1 || rect.x1 > clear.x1 + 1 || rect.y0 < clear.y0 - 1 || rect.y1 > clear.y1 + 1)
      out.push(f("block", "item.outside_room", `The ${cat.name.toLowerCase()} sticks out of ${room.name}.`, [it.id, room.id]));
    byLevel.set(room.level, [...(byLevel.get(room.level) ?? []), { item: it, cat, rect, room }]);
  }

  for (const [levelId, placed] of byLevel) {
    const walls = wallsByLevel.get(levelId) ?? [];
    const swings = doorSwings(project, levelId, walls);
    const passages = passageZones(project, levelId, walls);
    const wells = stairWells(project, levelId);
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i]!;
      for (let j = i + 1; j < placed.length; j++) {
        const b = placed[j]!;
        if (overlapArea(a.rect, b.rect) > 0)
          out.push(f("block", "item.overlap", `The ${a.cat.name.toLowerCase()} and the ${b.cat.name.toLowerCase()} in ${a.room.name} overlap.`, [a.item.id, b.item.id]));
      }
      if (wells.some((w) => overlapArea(a.rect, w) > 0))
        out.push(f("block", "item.in_stair", `The ${a.cat.name.toLowerCase()} in ${a.room.name} stands on the stair.`, [a.item.id]));
      const swung = new Set<string>();
      for (const s of swings) {
        if (overlapArea(a.rect, s.rect) <= 0) continue;
        swung.add(s.opening.opening.id);
        out.push(f("warn", "door.swing_blocked", `The ${a.cat.name.toLowerCase()} in ${a.room.name} is in the swing of door ${s.opening.opening.id}.`, [a.item.id, s.opening.opening.id]));
      }
      for (const z of passages) {
        if (swung.has(z.opening.opening.id) || overlapArea(a.rect, z.rect) <= 0) continue;
        swung.add(z.opening.opening.id);
        out.push(f("warn", "item.blocks_passage", `The ${a.cat.name.toLowerCase()} in ${a.room.name} stands in the way through ${z.opening.opening.type} ${z.opening.opening.id}.`, [a.item.id, z.opening.opening.id]));
      }
      const clear = clearRect(walls, a.room);
      for (const z of clearanceZones(a.item, a.cat)) {
        let avail = distanceInside(a.rect, clear, z.dir);
        for (const b of placed) {
          if (b === a || overlapArea(z.rect, b.rect) <= 0) continue;
          avail = Math.min(avail, gap(a.rect, b.rect, z.dir));
        }
        if (avail < z.need - TOLERANCE_MM)
          out.push(
            f("warn", "item.clearance", `The ${a.cat.name.toLowerCase()} in ${a.room.name} has ${formatFtIn(Math.max(0, avail))} clear at its ${z.where}; it needs ${formatFtIn(z.need)}.`, [a.item.id]),
          );
      }
    }
  }

  // Door swings that hit each other
  for (const level of project.levels) {
    const swings = doorSwings(project, level.id, wallsByLevel.get(level.id));
    for (let i = 0; i < swings.length; i++)
      for (let j = i + 1; j < swings.length; j++) {
        const a = swings[i]!;
        const b = swings[j]!;
        if (overlapArea(a.rect, b.rect) > 0)
          out.push(f("warn", "door.swing_clash", `Doors ${a.opening.opening.id} and ${b.opening.opening.id} on ${level.name} swing into each other.`, [a.opening.opening.id, b.opening.opening.id]));
      }
  }

  // Passages
  for (const room of project.rooms) {
    if (room.type !== "passage" || !boundaryToRect(room.boundary)) continue;
    const c = clearRect(wallsByLevel.get(room.level) ?? [], room);
    const w = Math.min(rectWidth(c), rectDepth(c));
    if (w < MIN_PASSAGE_MM - TOLERANCE_MM)
      out.push(f("warn", "passage.narrow", `${room.name} is ${formatFtIn(w)} wide clear; ${formatFtIn(MIN_PASSAGE_MM)} is the comfortable minimum.`, [room.id]));
  }
  return out;
}

function distanceInside(r: Rect, room: Rect, dir: Side): number {
  return { north: room.y1 - r.y1, south: r.y0 - room.y0, east: room.x1 - r.x1, west: r.x0 - room.x0 }[dir];
}

function gap(a: Rect, b: Rect, dir: Side): number {
  return { north: b.y0 - a.y1, south: a.y0 - b.y1, east: b.x0 - a.x1, west: a.x0 - b.x1 }[dir];
}
