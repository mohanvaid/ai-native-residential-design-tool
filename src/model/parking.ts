/**
 * Car parking: whether each car fits its bay, whether it can be driven from
 * the road to that bay, and whether the house has as many bays as the dwelling
 * units suggest. The drive path is checked as a straight or single-turn run
 * clear of columns, trees, stairs, cores, walls and the other cars, with the
 * aisle a car needs to swing round, rather than as a full swept-path analysis:
 * it catches a bay no car could reach, and says the rest is for the site
 * engineer to confirm.
 */
import { catalogueItem } from "../catalogue/catalogue.js";
import { itemRect } from "./furnishing.js";
import { bbox, boundaryToRect, overlapArea, rectDepth, rectWidth, type Rect } from "./geometry.js";
import type { Finding, PlacedItem, Project, Room, Side } from "./schema.js";
import { columnRect, columnsOn } from "./structure.js";
import { coreRect, coresOn } from "./core.js";
import { formatMetres } from "./units.js";
import { deriveWalls, roomRect } from "./walls.js";

const SOURCE = "parking";
const f = (severity: Finding["severity"], code: string, message: string, elements: string[], uncertain?: string): Finding => ({
  severity,
  code,
  message: uncertain ? `${message} ${uncertain}` : message,
  elements,
  source: SOURCE,
});

/** Clear aisle a car needs to turn into a bay at right angles (NBC 2016 Part 3 guidance). */
export const AISLE_MM = 5500;
/** Clear width a drive needs for one car. */
export const DRIVE_WIDTH_MM = 2750;
/** Room types a car may stand in or drive through. */
const DRIVEABLE = new Set(["parking", "car-porch", "sit-out", "other"]);

export interface Bay {
  item: PlacedItem;
  rect: Rect;
  room: Room;
  /** The side of the plot the car noses towards. */
  facing: Side;
}

export function carBays(project: Project, levelId?: string): Bay[] {
  const out: Bay[] = [];
  for (const it of project.items) {
    const cat = catalogueItem(it.catalogue);
    const room = project.rooms.find((r) => r.id === it.room);
    if (!cat || cat.symbol !== "car" || !room) continue;
    if (levelId && room.level !== levelId) continue;
    out.push({ item: it, rect: itemRect(it, cat), room, facing: it.facing });
  }
  return out;
}

/** Everything a car cannot drive through on one level. */
function obstacles(project: Project, levelId: string, ignore: Set<string>): { rect: Rect; what: string }[] {
  const out: { rect: Rect; what: string }[] = [];
  for (const room of project.rooms.filter((r) => r.level === levelId && !DRIVEABLE.has(r.type))) {
    const r = boundaryToRect(room.boundary);
    if (r) out.push({ rect: r, what: room.name });
  }
  for (const c of columnsOn(project, levelId)) out.push({ rect: columnRect(c), what: "a column" });
  for (const c of coresOn(project, levelId)) {
    const r = coreRect(c);
    if (r) out.push({ rect: r, what: c.kind === "lift" ? "the lift" : `the ${c.kind}` });
  }
  for (const s of project.stairs.filter((s) => s.fromLevel === levelId || s.toLevel === levelId)) {
    const r = boundaryToRect(s.boundary);
    if (r) out.push({ rect: r, what: "the stair" });
  }
  for (const t of project.trees.filter((t) => t.keep)) out.push({ rect: { x0: t.at[0] - t.rootRadius, x1: t.at[0] + t.rootRadius, y0: t.at[1] - t.rootRadius, y1: t.at[1] + t.rootRadius }, what: `the ${t.species.toLowerCase()}` });
  for (const b of carBays(project, levelId)) if (!ignore.has(b.item.id)) out.push({ rect: b.rect, what: "another car" });
  for (const it of project.items) {
    const cat = catalogueItem(it.catalogue);
    const room = project.rooms.find((r) => r.id === it.room);
    if (!cat || cat.symbol === "car" || !room || room.level !== levelId || ignore.has(it.id)) continue;
    if (DRIVEABLE.has(room.type)) out.push({ rect: itemRect(it, cat), what: cat.name.toLowerCase() });
  }
  return out;
}

const hits = (rect: Rect, obs: { rect: Rect; what: string }[]) => obs.find((o) => overlapArea(rect, o.rect) > 1e4);

/** A corridor from one rect to another along one axis. */
function corridor(from: Rect, to: Rect, axis: "x" | "y"): Rect {
  if (axis === "x") {
    const y0 = Math.max(from.y0, to.y0);
    const y1 = Math.min(from.y1, to.y1);
    return { x0: Math.min(from.x1, to.x1), x1: Math.max(from.x0, to.x0), y0, y1 };
  }
  const x0 = Math.max(from.x0, to.x0);
  const x1 = Math.min(from.x1, to.x1);
  return { x0, x1, y0: Math.min(from.y1, to.y1), y1: Math.max(from.y0, to.y0) };
}

/** The gate: the width of the plot edge on the road side, as deep as a drive. */
function gate(project: Project): { rect: Rect; side: Side } | null {
  const road = project.plot.abuttingRoads.find((r) => r.widthM > 0);
  if (!road) return null;
  const plot = bbox(project.plot.boundary);
  const d = 1;
  const rect: Rect =
    road.side === "north"
      ? { x0: plot.x0, x1: plot.x1, y0: plot.y1 - d, y1: plot.y1 }
      : road.side === "south"
        ? { x0: plot.x0, x1: plot.x1, y0: plot.y0, y1: plot.y0 + d }
        : road.side === "east"
          ? { x0: plot.x1 - d, x1: plot.x1, y0: plot.y0, y1: plot.y1 }
          : { x0: plot.x0, x1: plot.x0 + d, y0: plot.y0, y1: plot.y1 };
  return { rect, side: road.side };
}

export interface PathResult {
  ok: boolean;
  /** "straight" or "L-turn"; absent when no path was found. */
  shape?: "straight" | "L-turn";
  /** What stands in the way of the best attempt. */
  blockedBy?: string;
}

/**
 * Can a car reach this bay from the gate, straight or round one corner?
 * The corridor is widened to the drive width, and to the aisle depth in front
 * of the bay, where the car has to turn.
 */
export function drivePath(project: Project, bay: Bay): PathResult {
  const g = gate(project);
  if (!g) return { ok: true };
  const obs = obstacles(project, bay.room.level, new Set([bay.item.id]));
  const vertical = g.side === "north" || g.side === "south";

  // The aisle the car swings through, on the side of the bay the gate is on:
  // nose-in or reversed in, that is where the driver needs the room.
  const approach: Side = g.side;
  const nose: Rect = {
    north: { x0: bay.rect.x0, x1: bay.rect.x1, y0: bay.rect.y1, y1: bay.rect.y1 + AISLE_MM },
    south: { x0: bay.rect.x0, x1: bay.rect.x1, y0: bay.rect.y0 - AISLE_MM, y1: bay.rect.y0 },
    east: { x0: bay.rect.x1, x1: bay.rect.x1 + AISLE_MM, y0: bay.rect.y0, y1: bay.rect.y1 },
    west: { x0: bay.rect.x0 - AISLE_MM, x1: bay.rect.x0, y0: bay.rect.y0, y1: bay.rect.y1 },
  }[approach];

  // Straight: the corridor from the gate to the bay along the road's axis
  const straight = corridor(g.rect, bay.rect, vertical ? "y" : "x");
  const widened = widen(straight, vertical ? "y" : "x", DRIVE_WIDTH_MM);
  const straightHit = hits(widened, obs);
  // Straight in: the bay lines up with the gate and the car drives or reverses along one axis
  const inLine = vertical ? bay.facing === "north" || bay.facing === "south" : bay.facing === "east" || bay.facing === "west";
  if (!straightHit && inLine) return { ok: true, shape: "straight" };

  // L-turn: in along the road axis to the bay's aisle, then across to the bay
  const first = corridor(g.rect, nose, vertical ? "y" : "x");
  const second = corridor(nose, bay.rect, vertical ? "x" : "y");
  const a = hits(widen(first, vertical ? "y" : "x", DRIVE_WIDTH_MM), obs);
  const b = hits(widen(second, vertical ? "x" : "y", DRIVE_WIDTH_MM), obs);
  const turn = hits(nose, obs);
  if (!a && !b && !turn) return { ok: true, shape: "L-turn" };
  return { ok: false, blockedBy: (turn ?? a ?? b ?? straightHit)!.what };
}

function widen(r: Rect, axis: "x" | "y", width: number): Rect {
  if (axis === "y" && rectWidth(r) < width) {
    const c = (r.x0 + r.x1) / 2;
    return { ...r, x0: c - width / 2, x1: c + width / 2 };
  }
  if (axis === "x" && rectDepth(r) < width) {
    const c = (r.y0 + r.y1) / 2;
    return { ...r, y0: c - width / 2, y1: c + width / 2 };
  }
  return r;
}

export function validateParking(project: Project): Finding[] {
  const out: Finding[] = [];
  const bays = carBays(project);
  const dwellings = Math.max(1, new Set(project.rooms.map((r) => r.flat).filter(Boolean)).size);

  for (const bay of bays) {
    const walls = deriveWalls(project, bay.room.level);
    const roomRectangle = roomRect(bay.room);
    const inRoom = overlapArea(bay.rect, roomRectangle) / (rectWidth(bay.rect) * rectDepth(bay.rect));
    if (inRoom < 0.99) out.push(f("warn", "parking.outside_bay", `The ${label(bay)} sticks out of ${bay.room.name}.`, [bay.item.id, bay.room.id]));
    const path = drivePath(project, bay);
    if (!path.ok)
      out.push(
        f("warn", "parking.no_drive_path", `There is no way to drive the ${label(bay)} in from the road: ${path.blockedBy} is in the way. A car needs about ${formatMetres(DRIVE_WIDTH_MM)} to drive through and ${formatMetres(AISLE_MM)} clear in front of the bay to turn in.`, [bay.item.id], "The site engineer should confirm the turning circle."),
      );
    else if (path.shape === "L-turn" && walls.length) out.push(f("info", "parking.turn_needed", `The ${label(bay)} is reached by turning once inside the gate; it needs ${formatMetres(AISLE_MM)} clear in front of the bay.`, [bay.item.id]));
  }

  if (project.rooms.some((r) => r.type === "parking" || r.type === "car-porch")) {
    if (bays.length < dwellings)
      out.push(
        f(
          "warn",
          "parking.count",
          `${bays.length} car ${bays.length === 1 ? "bay is" : "bays are"} drawn for ${dwellings} ${dwellings === 1 ? "dwelling" : "dwellings"}; most approvals expect at least one car per dwelling.`,
          [],
          "The parking table in the local rules decides the number; confirm it before applying.",
        ),
      );
  } else if (bays.length) {
    out.push(f("info", "parking.no_room", "Cars are parked where no parking area is marked; give them a parking or car-porch room so the area statement and the approval drawings read correctly.", bays.map((b) => b.item.id)));
  }
  return out;
}

const label = (b: Bay) => `${catalogueItem(b.item.catalogue)?.name.toLowerCase() ?? "car"} in ${b.room.name}`;
