/**
 * Electrical and plumbing points: a first layout from room types and the
 * appliances and sanitaryware placed in each room, circuits and stacks
 * assigned to them, and checks on the result. The layout is a starting point
 * for the electrical and plumbing consultants, in the spirit of IS 732 and
 * NBC 2016 Part 9; it does not size cables or pipes.
 */
import { catalogueItem, type Service } from "../catalogue/catalogue.js";
import { doorSwings } from "./furnishing.js";
import { boundaryToRect, OPPOSITE, OUTWARD, rectArea, rectDepth, rectWidth, SIDES, type Rect } from "./geometry.js";
import type { Finding, MepKind, MepPoint, PlacedItem, Point, Project, Room, RoomType, Side } from "./schema.js";
import { formatMetres } from "./units.js";
import { clearRect, deriveWalls, resolveOpening, roomRect, wallsOnSide, type Wall } from "./walls.js";

export type MepDraft = Omit<MepPoint, "id" | "meta">;

export const ELECTRICAL: ReadonlySet<MepKind> = new Set<MepKind>(["light", "fan", "switchboard", "socket-6a", "socket-16a", "ac", "tv", "data", "exhaust", "geyser", "db"]);
export const PLUMBING: ReadonlySet<MepKind> = new Set<MepKind>(["water-cold", "water-hot", "drain", "floor-trap", "wc-outlet", "stack"]);
const WET_POINTS: ReadonlySet<MepKind> = new Set<MepKind>(["water-cold", "water-hot", "drain", "floor-trap", "wc-outlet"]);
const SOCKETS: ReadonlySet<MepKind> = new Set<MepKind>(["socket-6a", "socket-16a", "switchboard"]);
/** Points on a lighting circuit (IS 732 limits a final circuit to 10 points). */
const LIGHTING: ReadonlySet<MepKind> = new Set<MepKind>(["light", "fan", "exhaust"]);
export const LIGHTING_POINTS_PER_CIRCUIT = 10;
const SOCKETS_PER_CIRCUIT = 8;
/** Points on their own circuit. */
const DEDICATED: ReadonlySet<MepKind> = new Set<MepKind>(["socket-16a", "ac", "geyser"]);
/** Horizontal distance from a water point inside which sockets and switches need to sit high (bathroom zone). */
export const WET_ZONE_MM = 600;
const WET_ZONE_SAFE_HEIGHT = 1500;
/** Furthest a WC or floor trap should be from its stack. */
export const MAX_STACK_RUN_MM = 6000;

export const MEP_LABELS: Record<MepKind, string> = {
  light: "Light",
  fan: "Ceiling fan",
  switchboard: "Switchboard",
  "socket-6a": "Socket 6 A",
  "socket-16a": "Power 16 A",
  ac: "AC point",
  tv: "TV point",
  data: "Data point",
  exhaust: "Exhaust fan",
  geyser: "Geyser point",
  db: "Distribution board",
  "water-cold": "Cold water",
  "water-hot": "Hot water",
  drain: "Waste outlet",
  "floor-trap": "Floor trap",
  "wc-outlet": "WC outlet",
  stack: "Soil/waste stack",
};

/** Standard heights above finished floor, mm. */
export const STANDARD_HEIGHT: Record<MepKind, number> = {
  light: 0,
  fan: 0,
  switchboard: 1200,
  "socket-6a": 300,
  "socket-16a": 300,
  ac: 2100,
  tv: 450,
  data: 450,
  exhaust: 2100,
  geyser: 1800,
  db: 1800,
  "water-cold": 600,
  "water-hot": 1000,
  drain: 450,
  "floor-trap": 0,
  "wc-outlet": 0,
  stack: 0,
};

interface TypeSet {
  fans?: boolean;
  sockets?: number;
  power?: number;
  ac?: boolean;
  tv?: boolean;
  data?: boolean;
  exhaust?: boolean;
}

const BY_TYPE: Partial<Record<RoomType, TypeSet>> = {
  bedroom: { fans: true, sockets: 3, ac: true, tv: true },
  living: { fans: true, sockets: 3, ac: true, tv: true, data: true },
  dining: { fans: true, sockets: 1 },
  study: { fans: true, sockets: 3, ac: true, data: true },
  kitchen: { sockets: 2, power: 2, exhaust: true },
  puja: { sockets: 1 },
  utility: { sockets: 1, power: 1 },
  toilet: { exhaust: true },
};

/** Rooms that get no switchboard of their own (open areas switched from elsewhere). */
const NO_SWITCHBOARD: ReadonlySet<RoomType> = new Set<RoomType>(["parking", "car-porch"]);

/** A point just inside the clear face of a wall, at fraction t along it (from the west or south end). */
function onWall(c: Rect, side: Side, t: number, inset = 60): Point {
  const x = c.x0 + t * rectWidth(c);
  const y = c.y0 + t * rectDepth(c);
  switch (side) {
    case "north":
      return [Math.round(x), c.y1 - inset];
    case "south":
      return [Math.round(x), c.y0 + inset];
    case "east":
      return [c.x1 - inset, Math.round(y)];
    case "west":
      return [c.x0 + inset, Math.round(y)];
  }
}

/** n × m grid of ceiling points, about one per 4 m. */
function grid(c: Rect, spacing = 4000): Point[] {
  const nx = Math.max(1, Math.ceil(rectWidth(c) / spacing));
  const ny = Math.max(1, Math.ceil(rectDepth(c) / spacing));
  const out: Point[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out.push([Math.round(c.x0 + ((i + 0.5) * rectWidth(c)) / nx), Math.round(c.y0 + ((j + 0.5) * rectDepth(c)) / ny)]);
  return out;
}

/** The side of the room a door is on, and where along it, for doors that reach the room. */
function doorsOf(project: Project, walls: Wall[], room: Room): { side: Side; from: number; to: number }[] {
  const r = roomRect(room);
  const out: { side: Side; from: number; to: number }[] = [];
  for (const o of project.openings) {
    if (o.type !== "door" && o.type !== "opening") continue;
    const res = resolveOpening(project, walls, o);
    if (!res || (o.host.room !== room.id && res.otherRoom !== room.id)) continue;
    const side: Side = res.orient === "h" ? (Math.abs(res.at - r.y1) < Math.abs(res.at - r.y0) ? "north" : "south") : Math.abs(res.at - r.x1) < Math.abs(res.at - r.x0) ? "east" : "west";
    out.push({ side, from: res.from, to: res.to });
  }
  return out;
}

const SERVICE_KIND: Record<Service, MepKind> = {
  socket: "socket-6a",
  power: "socket-16a",
  water: "water-cold",
  "hot-water": "water-hot",
  drain: "drain",
  "ac-point": "ac",
  exhaust: "exhaust",
};

/** Points a placed item needs, on the wall behind it. */
function itemPoints(project: Project, it: PlacedItem): MepDraft[] {
  const cat = catalogueItem(it.catalogue);
  if (!cat?.services?.length) return [];
  const back = OUTWARD[OPPOSITE[it.facing]];
  const at: Point = [Math.round(it.at[0] + (back[0] * cat.depth) / 2), Math.round(it.at[1] + (back[1] * cat.depth) / 2)];
  const room = project.rooms.find((x) => x.id === it.room)!;
  const out: MepDraft[] = [];
  const wc = cat.symbol === "wc" || cat.symbol === "wc-indian";
  for (const s of cat.services) {
    const kind = wc && s === "drain" ? "wc-outlet" : SERVICE_KIND[s];
    const height = kind === "socket-6a" || kind === "socket-16a" ? (room.type === "kitchen" ? 1100 : 450) : STANDARD_HEIGHT[kind];
    out.push({ kind, room: it.room, at, heightMm: height, serves: it.id, auto: true });
  }
  if (cat.symbol === "shower") out.push({ kind: "floor-trap", room: it.room, at: [Math.round(it.at[0]), Math.round(it.at[1])], heightMm: 0, serves: it.id, auto: true });
  return out;
}

/** A first set of points for one room from its type, doors, walls and the items in it. */
export function roomPoints(project: Project, room: Room, walls: Wall[] = deriveWalls(project, room.level)): MepDraft[] {
  const c = clearRect(walls, room);
  if (rectWidth(c) <= 0 || rectDepth(c) <= 0) return [];
  const out: MepDraft[] = [];
  const add = (kind: MepKind, at: Point, heightMm = STANDARD_HEIGHT[kind]) => out.push({ kind, room: room.id, at, heightMm, auto: true });
  const doors = doorsOf(project, walls, room);
  const doorSide = doors[0]?.side;
  const facing = doorSide ? OPPOSITE[doorSide] : "north";
  const sideWalls = SIDES.filter((s) => s !== doorSide && s !== facing);
  const external = SIDES.filter((s) => wallsOnSide(walls, room, s).some((w) => w.isExternal));

  // Lights, and fans in habitable rooms over about 7 m²
  const set = BY_TYPE[room.type] ?? {};
  for (const p of grid(c)) add("light", p);
  if (set.fans && rectArea(c) >= 7e6) for (const p of grid(c, 4500)) add("fan", [p[0], p[1] + 300]);

  // Switchboard on the latch side of the first door
  if (doors[0] && !NO_SWITCHBOARD.has(room.type)) {
    const d = doors[0];
    const horizontal = d.side === "north" || d.side === "south";
    const lo = horizontal ? c.x0 : c.y0;
    const hi = horizontal ? c.x1 : c.y1;
    const along = d.to + 250 <= hi - 100 ? d.to + 250 : Math.max(lo + 100, d.from - 250);
    const t = (along - lo) / (hi - lo);
    add("switchboard", onWall(c, d.side, t));
  }

  // Sockets, AC, TV and data on the walls away from the door
  const items = project.items.filter((it) => it.room === room.id);
  const served = new Set(items.flatMap((it) => catalogueItem(it.catalogue)?.services ?? []));
  const kitchen = room.type === "kitchen";
  for (let i = 0; i < (set.sockets ?? 0); i++) {
    const side = i === 0 ? facing : sideWalls[(i - 1) % sideWalls.length] ?? facing;
    add("socket-6a", onWall(c, side, i === 0 ? 0.2 : 0.3), kitchen ? 1100 : 300);
  }
  for (let i = 0; i < (set.power ?? 0) - (served.has("power") ? 1 : 0); i++) add("socket-16a", onWall(c, facing, 0.5 + 0.25 * i), kitchen ? 1100 : 450);
  if (set.ac && !served.has("ac-point")) add("ac", onWall(c, facing, 0.6));
  if (set.tv) add("tv", onWall(c, sideWalls[0] ?? facing, 0.5));
  if (set.data) add("data", onWall(c, sideWalls[0] ?? facing, 0.62));
  if (set.exhaust && !served.has("exhaust")) add("exhaust", onWall(c, external[0] ?? facing, 0.5));
  if (room.type === "toilet" && !served.has("hot-water")) add("geyser", onWall(c, sideWalls[0] ?? facing, 0.8));

  // Plumbing: sanitaryware and appliances bring their own points; otherwise a standard set
  const sanitary = items.some((it) => catalogueItem(it.catalogue)?.category === "sanitary");
  if (room.type === "toilet" && !sanitary) {
    const back = facing;
    add("wc-outlet", onWall(c, back, 0.3, 250));
    add("water-cold", onWall(c, back, 0.15));
    add("water-cold", onWall(c, sideWalls[0] ?? back, 0.3));
    add("drain", onWall(c, sideWalls[0] ?? back, 0.3));
    add("water-hot", onWall(c, back, 0.8));
    add("floor-trap", [Math.round((c.x0 + c.x1) / 2), Math.round((c.y0 + c.y1) / 2)]);
  }
  if ((room.type === "kitchen" || room.type === "utility") && !served.has("water")) {
    const sinkWall = external[0] ?? facing;
    add("water-cold", onWall(c, sinkWall, 0.5));
    add("drain", onWall(c, sinkWall, 0.55));
  }
  if (room.type === "utility") add("floor-trap", [Math.round((c.x0 + c.x1) / 2), Math.round((c.y0 + c.y1) / 2)]);
  for (const it of items) out.push(...itemPoints(project, it));

  // A stack on an outside wall of each wet room, near its WC or drains
  if ((room.type === "toilet" || room.type === "kitchen" || room.type === "utility") && external.length) {
    const wc = out.find((p) => p.kind === "wc-outlet") ?? out.find((p) => WET_POINTS.has(p.kind));
    const side = wc ? [...external].sort((a, b) => wallDistance(c, a, wc.at) - wallDistance(c, b, wc.at))[0]! : external[0]!;
    const t = wc ? (side === "north" || side === "south" ? (wc.at[0] - c.x0) / rectWidth(c) : (wc.at[1] - c.y0) / rectDepth(c)) : 0.5;
    add("stack", onWall(c, side, Math.min(0.9, Math.max(0.1, t)), 80));
  }

  // In wet rooms, sockets and switches near water go up out of the splash zone
  if (room.type === "toilet" || room.type === "utility")
    for (const p of out)
      if (SOCKETS.has(p.kind) && p.heightMm < WET_ZONE_SAFE_HEIGHT && out.some((w) => WET_POINTS.has(w.kind) && dist(w.at, p.at) < WET_ZONE_MM)) p.heightMm = WET_ZONE_SAFE_HEIGHT;
  return out;
}

function wallDistance(c: Rect, side: Side, p: Point): number {
  switch (side) {
    case "north":
      return c.y1 - p[1];
    case "south":
      return p[1] - c.y0;
    case "east":
      return c.x1 - p[0];
    case "west":
      return p[0] - c.x0;
  }
}

/** Who a point belongs to for circuits and the distribution board: its flat, or its level for a single home. */
function groupOf(project: Project, room: Room | undefined): string {
  if (!room) return "?";
  if (room.flat) return room.flat;
  if (project.rooms.some((r) => r.flat)) return "Common";
  return project.levels.find((l) => l.id === room.level)?.name ?? room.level;
}

/** Distribution boards still needed: one per flat (or per house) with points, in the living room by its door. */
export function boardPoints(project: Project, points: readonly MepDraft[]): MepDraft[] {
  const flats = project.rooms.some((r) => r.flat);
  const groups = new Map<string, Room[]>();
  for (const room of project.rooms) {
    const g = flats ? (room.flat ?? "Common") : "House";
    groups.set(g, [...(groups.get(g) ?? []), room]);
  }
  const out: MepDraft[] = [];
  for (const [, rooms] of groups) {
    const ids = new Set(rooms.map((r) => r.id));
    if (!points.some((p) => ids.has(p.room) && p.kind !== "db" && ELECTRICAL.has(p.kind))) continue;
    if (points.some((p) => p.kind === "db" && ids.has(p.room))) continue;
    const levelOrder = (r: Room) => project.levels.findIndex((l) => l.id === r.level);
    const host = [...rooms].filter((r) => r.type === "living" || r.type === "lobby" || r.type === "passage").sort((a, b) => levelOrder(a) - levelOrder(b))[0] ?? rooms[0]!;
    const walls = deriveWalls(project, host.level);
    const c = clearRect(walls, host);
    const d = doorsOf(project, walls, host)[0];
    const side = d?.side ?? "south";
    const horizontal = side === "north" || side === "south";
    const lo = horizontal ? c.x0 : c.y0;
    const hi = horizontal ? c.x1 : c.y1;
    const along = d ? (d.from - 600 > lo + 100 ? d.from - 600 : Math.min(hi - 100, d.to + 600)) : (lo + hi) / 2;
    out.push({ kind: "db", room: host.id, at: onWall(c, side, (along - lo) / (hi - lo)), heightMm: STANDARD_HEIGHT.db, auto: true });
  }
  return out;
}

/**
 * Circuits by flat or floor: lighting and fans in tens, 6 A sockets in eights,
 * and each 16 A, AC and geyser point on its own circuit. Points that already
 * have a circuit (set by hand) keep it.
 */
export function assignCircuits(project: Project, points: MepPoint[]): MepPoint[] {
  const count = new Map<string, number>();
  const dedicated = new Map<string, number>();
  const sorted = [...points].sort((a, b) => a.room.localeCompare(b.room) || a.id.localeCompare(b.id));
  const result = new Map<string, MepPoint>();
  for (const p of sorted) {
    if (!ELECTRICAL.has(p.kind) || p.kind === "db" || p.kind === "switchboard" || (p.circuit && !p.auto)) {
      result.set(p.id, p);
      continue;
    }
    const g = groupOf(project, project.rooms.find((r) => r.id === p.room));
    let circuit: string;
    if (DEDICATED.has(p.kind)) {
      const n = (dedicated.get(g) ?? 0) + 1;
      dedicated.set(g, n);
      circuit = `${g} P${n}`;
    } else {
      const kind = LIGHTING.has(p.kind) ? "L" : "S";
      const key = `${g}/${kind}`;
      const n = count.get(key) ?? 0;
      count.set(key, n + 1);
      circuit = `${g} ${kind}${Math.floor(n / (kind === "L" ? LIGHTING_POINTS_PER_CIRCUIT : SOCKETS_PER_CIRCUIT)) + 1}`;
    }
    result.set(p.id, { ...p, circuit });
  }
  return points.map((p) => result.get(p.id)!);
}

/** Each wet point to the nearest stack on its level. */
export function linkStacks(project: Project, points: MepPoint[]): MepPoint[] {
  const levelOf = (p: MepPoint) => project.rooms.find((r) => r.id === p.room)?.level;
  const stacks = points.filter((p) => p.kind === "stack");
  return points.map((p) => {
    if (!WET_POINTS.has(p.kind) || (p.stack && !p.auto)) return p;
    const lv = levelOf(p);
    const near = stacks.filter((s) => levelOf(s) === lv).sort((a, b) => dist(a.at, p.at) - dist(b.at, p.at))[0];
    return near ? { ...p, stack: near.id } : { ...p, stack: undefined };
  });
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function validateMep(project: Project): Finding[] {
  const out: Finding[] = [];
  const f = (severity: Finding["severity"], code: string, message: string, elements: string[]): Finding => ({ severity, code, message, elements, source: "mep" });
  if (!project.mep.length) return out;
  const rooms = new Map(project.rooms.map((r) => [r.id, r]));
  const levelName = (id: string) => project.levels.find((l) => l.id === id)?.name ?? id;
  const swings = new Map<string, Rect[]>();
  const swingsOn = (levelId: string) => {
    if (!swings.has(levelId)) swings.set(levelId, doorSwings(project, levelId).map((s) => s.rect));
    return swings.get(levelId)!;
  };
  const label = (p: MepPoint) => `${MEP_LABELS[p.kind].toLowerCase()} ${p.id}`;

  for (const p of project.mep) {
    const room = rooms.get(p.room);
    if (!room) {
      out.push(f("block", "mep.room_missing", `The ${label(p)} is in a room that no longer exists.`, [p.id]));
      continue;
    }
    const r = boundaryToRect(room.boundary);
    if (r && (p.at[0] < r.x0 - 1 || p.at[0] > r.x1 + 1 || p.at[1] < r.y0 - 1 || p.at[1] > r.y1 + 1)) out.push(f("warn", "mep.outside_room", `The ${label(p)} is outside ${room.name}.`, [p.id, room.id]));
    if (p.kind === "switchboard" && swingsOn(room.level).some((s) => p.at[0] >= s.x0 && p.at[0] <= s.x1 && p.at[1] >= s.y0 && p.at[1] <= s.y1))
      out.push(f("warn", "mep.switch_behind_door", `The switchboard in ${room.name} on ${levelName(room.level)} is behind a door swing; move it to the latch side.`, [p.id]));
  }

  // Sockets and switches close to water in wet rooms must sit high
  for (const p of project.mep.filter((p) => SOCKETS.has(p.kind) && p.heightMm < WET_ZONE_SAFE_HEIGHT)) {
    const room = rooms.get(p.room);
    if (!room || (room.type !== "toilet" && room.type !== "utility")) continue;
    const wet = project.mep.find((w) => w.room === p.room && WET_POINTS.has(w.kind) && dist(w.at, p.at) < WET_ZONE_MM);
    if (wet) out.push(f("warn", "mep.socket_wet_zone", `The ${label(p)} in ${room.name} is ${formatMetres(dist(wet.at, p.at))} from the ${MEP_LABELS[wet.kind].toLowerCase()}; within ${formatMetres(WET_ZONE_MM)} of water it should be at least ${formatMetres(WET_ZONE_SAFE_HEIGHT)} high or moved.`, [p.id, wet.id]));
  }

  // Lighting circuits over ten points
  const perCircuit = new Map<string, MepPoint[]>();
  for (const p of project.mep) if (p.circuit && LIGHTING.has(p.kind)) perCircuit.set(p.circuit, [...(perCircuit.get(p.circuit) ?? []), p]);
  for (const [c, pts] of perCircuit)
    if (pts.length > LIGHTING_POINTS_PER_CIRCUIT) out.push(f("warn", "mep.circuit_overloaded", `Circuit ${c} has ${pts.length} lighting and fan points; keep a final circuit to ${LIGHTING_POINTS_PER_CIRCUIT} (IS 732).`, pts.map((p) => p.id)));

  // WCs and floor traps need a stack close by
  const stacks = project.mep.filter((p) => p.kind === "stack");
  for (const p of project.mep.filter((p) => p.kind === "wc-outlet" || p.kind === "floor-trap")) {
    const room = rooms.get(p.room);
    if (!room) continue;
    const near = stacks.filter((s) => rooms.get(s.room)?.level === room.level).map((s) => dist(s.at, p.at));
    const d = near.length ? Math.min(...near) : Infinity;
    if (d > MAX_STACK_RUN_MM)
      out.push(f("warn", "mep.no_stack", `The ${MEP_LABELS[p.kind].toLowerCase()} in ${room.name} on ${levelName(room.level)} ${d === Infinity ? "has no stack on its floor" : `is ${formatMetres(d)} from the nearest stack`}; keep the run under ${formatMetres(MAX_STACK_RUN_MM)} or add a shaft.`, [p.id]));
  }

  // Stacks should run straight down through the floors below
  for (const s of stacks) {
    const room = rooms.get(s.room);
    if (!room) continue;
    const i = project.levels.findIndex((l) => l.id === room.level);
    const below = project.levels[i - 1];
    if (!below || below.kind === "stilt" || !project.rooms.some((r) => r.level === below.id)) continue;
    const under = stacks.some((t) => rooms.get(t.room)?.level === below.id && dist(t.at, s.at) <= 300);
    if (!under) out.push(f("warn", "mep.stack_offset", `The stack in ${room.name} on ${levelName(room.level)} does not continue straight down to ${below.name}; offsets need extra bends and access.`, [s.id]));
  }

  // A distribution board per flat or house
  const flats = project.rooms.some((r) => r.flat);
  const groups = new Set(project.mep.filter((p) => ELECTRICAL.has(p.kind)).map((p) => (flats ? (rooms.get(p.room)?.flat ?? "Common") : "House")));
  for (const g of groups)
    if (!project.mep.some((p) => p.kind === "db" && (flats ? (rooms.get(p.room)?.flat ?? "Common") : "House") === g))
      out.push(f("warn", "mep.no_db", `${g === "House" ? "The house" : g === "Common" ? "The common areas" : `Flat ${g}`} has electrical points but no distribution board.`, []));
  return out;
}
