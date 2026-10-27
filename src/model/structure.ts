/**
 * Site features and structure: trees with keep-out zones, columns and the
 * grid derived from them, and stairs. Geometry helpers plus the checks that
 * hold in every jurisdiction. These are sanity checks for the engineer, not
 * structural design: member sizes and reinforcement are out of scope.
 */
import { outerRect } from "./areas.js";
import { bbox, boundaryToRect, contains, overlapArea, rectToBoundary, type Rect } from "./geometry.js";
import type { Column, Finding, Point, Project, RoomType, Side, Stair, Tree } from "./schema.js";
import { formatFtIn, formatMetres } from "./units.js";
import { deriveWalls, type Wall } from "./walls.js";

const SOURCE = "core";
/** Riser height used to derive the riser count when a stair does not set it (TNCDBR 2019 r.52(17)(c), residential). */
export const DEFAULT_MAX_RISER_MM = 190;
/** Risers per flight before a landing is needed (TNCDBR 2019 r.52(17)(c)). */
export const MAX_RISERS_PER_FLIGHT = 15;
/** Two column centres closer than this are the same grid point. */
const SNAP_MM = 50;

/** Rooms a stair may stand in or open through. */
const STAIR_OK: ReadonlySet<RoomType> = new Set<RoomType>(["living", "dining", "passage", "staircase", "sit-out", "car-porch", "utility", "other"]);

const f = (severity: Finding["severity"], code: string, message: string, elements: string[]): Finding => ({
  severity,
  code,
  message,
  elements,
  source: SOURCE,
});

// Levels

export const levelIndex = (project: Project, id: string) => project.levels.findIndex((l) => l.id === id);

/** Columns standing on a level: those whose span includes it. */
export function columnsOn(project: Project, levelId: string): Column[] {
  const i = levelIndex(project, levelId);
  return project.columns.filter((c) => levelIndex(project, c.fromLevel) <= i && i <= levelIndex(project, c.toLevel));
}

export function columnRect(c: Column): Rect {
  return { x0: c.at[0] - c.width / 2, x1: c.at[0] + c.width / 2, y0: c.at[1] - c.depth / 2, y1: c.at[1] + c.depth / 2 };
}

// Structural grid

export interface GridLine {
  label: string;
  at: number;
}

/** Grid lines through column centres: lettered west to east, numbered south to north. */
export function structuralGrid(project: Project): { x: GridLine[]; y: GridLine[] } {
  const cluster = (vals: number[]) => {
    const out: number[] = [];
    for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1]! > SNAP_MM) out.push(v);
    return out;
  };
  const xs = cluster(project.columns.map((c) => c.at[0]));
  const ys = cluster(project.columns.map((c) => c.at[1]));
  return {
    x: xs.map((at, i) => ({ label: gridLetter(i), at })),
    y: ys.map((at, i) => ({ label: String(i + 1), at })),
  };
}

function gridLetter(i: number): string {
  // A..Z without I and O, as on drawings
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return i < letters.length ? letters[i]! : letters[Math.floor(i / letters.length) - 1]! + letters[i % letters.length]!;
}

/** Grid reference for a column, e.g. "B2". */
export function gridRef(project: Project, c: Column, grid = structuralGrid(project)): string {
  const gx = grid.x.find((g) => Math.abs(g.at - c.at[0]) <= SNAP_MM)?.label ?? "?";
  const gy = grid.y.find((g) => Math.abs(g.at - c.at[1]) <= SNAP_MM)?.label ?? "?";
  return `${gx}${gy}`;
}

/**
 * Column positions for a frame through the given levels: every wall corner
 * and junction, plus extra columns so no wall run spans more than maxSpan.
 */
export function proposeColumns(project: Project, levelIds: string[], maxSpan: number): Point[] {
  const walls = levelIds.flatMap((id) => deriveWalls(project, id));
  const pts: Point[] = [];
  const add = (p: Point) => {
    if (!pts.some((q) => Math.abs(q[0] - p[0]) <= SNAP_MM && Math.abs(q[1] - p[1]) <= SNAP_MM)) pts.push(p);
  };
  for (const w of walls) {
    add(w.start);
    add(w.end);
  }
  for (const run of wallRuns(walls)) {
    const on = pts
      .filter((p) => onLine(p, run.orient, run.at) && along(p, run.orient) >= run.from - SNAP_MM && along(p, run.orient) <= run.to + SNAP_MM)
      .map((p) => along(p, run.orient))
      .sort((a, b) => a - b);
    for (let i = 0; i + 1 < on.length; i++) {
      const gap = on[i + 1]! - on[i]!;
      const parts = Math.ceil(gap / maxSpan);
      for (let k = 1; k < parts; k++) {
        const a = Math.round(on[i]! + (gap * k) / parts);
        add(run.orient === "h" ? [a, run.at] : [run.at, a]);
      }
    }
  }
  return pts.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

interface Run {
  orient: "h" | "v";
  at: number;
  from: number;
  to: number;
  walls: Wall[];
}

/** Collinear, touching walls merged into continuous runs. */
export function wallRuns(walls: Wall[]): Run[] {
  const byLine = new Map<string, Wall[]>();
  for (const w of walls) byLine.set(`${w.orient}:${w.at}`, [...(byLine.get(`${w.orient}:${w.at}`) ?? []), w]);
  const runs: Run[] = [];
  for (const ws of byLine.values()) {
    const sorted = [...ws].sort((a, b) => a.from - b.from);
    let cur: Run | null = null;
    for (const w of sorted) {
      if (cur && w.from <= cur.to) {
        cur.to = Math.max(cur.to, w.to);
        cur.walls.push(w);
      } else {
        if (cur) runs.push(cur);
        cur = { orient: w.orient, at: w.at, from: w.from, to: w.to, walls: [w] };
      }
    }
    if (cur) runs.push(cur);
  }
  return runs;
}

const onLine = (p: Point, orient: "h" | "v", at: number, tol = SNAP_MM) => Math.abs((orient === "h" ? p[1] : p[0]) - at) <= tol;
const along = (p: Point, orient: "h" | "v") => (orient === "h" ? p[0] : p[1]);

// Stairs

export interface Flight {
  rect: Rect;
  /** Direction of climb. */
  dir: Side;
  risers: number;
  /** Lines across the flight at each tread nosing, as model segments. */
  nosings: [Point, Point][];
  /** Walking line from the first riser to the last, through the centre. */
  start: Point;
  end: Point;
}

export interface StairLayout {
  well: Rect;
  risers: number;
  riserHeight: number;
  flights: Flight[];
  landing: Rect | null;
  /** Clear width of each flight, mm. */
  flightWidth: number;
  /** Well length the flights and landing need along the direction of travel, mm. */
  requiredLength: number;
  /** Well length actually available, mm. */
  length: number;
}

const REVERSE: Record<Side, Side> = { north: "south", south: "north", east: "west", west: "east" };

export function stairRisers(project: Project, stair: Stair): number {
  const level = project.levels.find((l) => l.id === stair.fromLevel);
  return stair.risers ?? Math.ceil((level?.floorToFloor ?? 3000) / DEFAULT_MAX_RISER_MM);
}

/** Size of well a stair needs: [along the climb, across], mm. */
export function stairWellSize(shape: Stair["shape"], risers: number, tread: number, flightWidth: number): [number, number] {
  if (shape === "dog-leg") {
    const n1 = Math.ceil(risers / 2);
    return [(n1 - 1) * tread + flightWidth, 2 * flightWidth];
  }
  if (risers <= MAX_RISERS_PER_FLIGHT) return [(risers - 1) * tread, flightWidth];
  const n1 = Math.ceil(risers / 2);
  return [(n1 - 1 + (risers - n1 - 1)) * tread + flightWidth, flightWidth];
}

/** Lays out flights, treads and landing inside the stair well. */
export function stairLayout(project: Project, stair: Stair): StairLayout | null {
  const well = boundaryToRect(stair.boundary);
  if (!well) return null;
  const level = project.levels.find((l) => l.id === stair.fromLevel);
  const n = stairRisers(project, stair);
  const vertical = stair.up === "north" || stair.up === "south";
  const L = vertical ? well.y1 - well.y0 : well.x1 - well.x0;
  const Wd = vertical ? well.x1 - well.x0 : well.y1 - well.y0;

  // Local frame: s along the climb from the entry edge, t across from the climber's left.
  const toModel = (s: number, t: number): Point => {
    switch (stair.up) {
      case "north":
        return [well.x0 + t, well.y0 + s];
      case "south":
        return [well.x1 - t, well.y1 - s];
      case "east":
        return [well.x0 + s, well.y1 - t];
      case "west":
        return [well.x1 - s, well.y0 + t];
    }
  };
  const box = (s0: number, s1: number, t0: number, t1: number): Rect => {
    const a = toModel(s0, t0);
    const b = toModel(s1, t1);
    return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) };
  };
  const flight = (s0: number, k: number, t0: number, t1: number, back: boolean): Flight => {
    const tread = stair.tread;
    const len = (k - 1) * tread;
    const sa = back ? s0 - len : s0;
    const nosings: [Point, Point][] = [];
    for (let i = 0; i <= k - 1; i++) {
      const s = back ? s0 - i * tread : s0 + i * tread;
      nosings.push([toModel(s, t0), toModel(s, t1)]);
    }
    const tc = (t0 + t1) / 2;
    return {
      rect: box(sa, sa + len, t0, t1),
      dir: back ? REVERSE[stair.up] : stair.up,
      risers: k,
      nosings,
      start: toModel(s0, tc),
      end: toModel(back ? s0 - len : s0 + len, tc),
    };
  };

  const flights: Flight[] = [];
  let landing: Rect | null = null;
  let flightWidth = Wd;
  if (stair.shape === "dog-leg") {
    flightWidth = Wd / 2;
    const n1 = Math.ceil(n / 2);
    const n2 = n - n1;
    const [first, second] = stair.turn === "right" ? ([[0, Wd / 2], [Wd / 2, Wd]] as const) : ([[Wd / 2, Wd], [0, Wd / 2]] as const);
    const f1 = flight(0, n1, first[0], first[1], false);
    const landFrom = (n1 - 1) * stair.tread;
    landing = box(landFrom, L, 0, Wd);
    const f2 = flight(landFrom, n2, second[0], second[1], true);
    // The second flight's first nosing is the landing edge, drawn by the landing.
    f2.nosings.shift();
    flights.push(f1, f2);
  } else if (n <= MAX_RISERS_PER_FLIGHT) {
    flights.push(flight(0, n, 0, Wd, false));
  } else {
    const n1 = Math.ceil(n / 2);
    const f1 = flight(0, n1, 0, Wd, false);
    const landFrom = (n1 - 1) * stair.tread;
    landing = box(landFrom, landFrom + Wd, 0, Wd);
    flights.push(f1, flight(landFrom + Wd, n - n1, 0, Wd, false));
  }
  const [requiredLength] = stairWellSize(stair.shape, n, stair.tread, flightWidth);
  return { well, risers: n, riserHeight: (level?.floorToFloor ?? 3000) / n, flights, landing, flightWidth, requiredLength, length: L };
}

/** The well rectangle for a new stair placed with its south-west corner at (x, y). */
export function stairWellRect(x: number, y: number, up: Side, size: [number, number]): Rect {
  const [len, wid] = size;
  const vertical = up === "north" || up === "south";
  return { x0: x, y0: y, x1: x + (vertical ? wid : len), y1: y + (vertical ? len : wid) };
}

export const stairBoundary = (r: Rect) => rectToBoundary(r);

// Trees

/** Typical canopy and root protection radii, mm, for trees common on Chennai plots. Rough guides; a site survey wins. */
export const TREE_DEFAULTS: Record<string, { canopy: number; root: number }> = {
  mango: { canopy: 4500, root: 3000 },
  neem: { canopy: 4000, root: 2500 },
  coconut: { canopy: 3500, root: 1500 },
  banyan: { canopy: 9000, root: 6000 },
  "peepal": { canopy: 7000, root: 5000 },
  "drumstick": { canopy: 2500, root: 1200 },
  "guava": { canopy: 2500, root: 1500 },
  "jackfruit": { canopy: 5000, root: 3500 },
};
export const TREE_FALLBACK = { canopy: 3000, root: 2000 };

/** Does a circle overlap a rectangle, and by how much (mm of penetration)? */
export function circleIntoRect(c: Point, radius: number, r: Rect): number {
  const dx = Math.max(r.x0 - c[0], 0, c[0] - r.x1);
  const dy = Math.max(r.y0 - c[1], 0, c[1] - r.y1);
  return radius - Math.hypot(dx, dy);
}

// Checks

export function validateStructure(project: Project): Finding[] {
  const out: Finding[] = [];
  const plot = bbox(project.plot.boundary);
  const levels = project.levels;
  const lowest = levels[0];
  const roomsOn = (id: string) => project.rooms.filter((r) => r.level === id);
  const levelName = (id: string) => levels.find((l) => l.id === id)?.name ?? id;
  const grid = structuralGrid(project);
  const colName = (c: Column) => `Column ${gridRef(project, c, grid)}`;

  // Trees
  for (const t of project.trees) {
    const name = treeName(t);
    if (t.at[0] < plot.x0 || t.at[0] > plot.x1 || t.at[1] < plot.y0 || t.at[1] > plot.y1)
      out.push(f("block", "tree.outside_plot", `${name} is outside the plot.`, [t.id]));
    if (!t.keep) continue;
    const hits: { id: string; name: string; by: number }[] = [];
    if (lowest)
      for (const room of roomsOn(lowest.id)) {
        const r = outerRect(room);
        const by = r ? circleIntoRect(t.at, t.rootRadius, r) : 0;
        if (by > 0) hits.push({ id: room.id, name: room.name, by });
      }
    for (const c of project.columns) {
      const by = circleIntoRect(t.at, t.rootRadius, columnRect(c));
      if (by > 0) hits.push({ id: c.id, name: colName(c), by });
    }
    for (const s of project.stairs) {
      const r = boundaryToRect(s.boundary);
      const by = r && levelIndex(project, s.fromLevel) === 0 ? circleIntoRect(t.at, t.rootRadius, r) : 0;
      if (by > 0) hits.push({ id: s.id, name: "the stair", by });
    }
    for (const h of hits)
      out.push(
        f("block", "tree.root_zone", `${h.name} is ${formatMetres(h.by)} inside the root zone of the ${name} (${formatMetres(t.rootRadius)} radius). Move it, shrink it, or mark the tree for removal.`, [t.id, h.id]),
      );
    for (const level of levels.slice(1)) {
      for (const room of roomsOn(level.id)) {
        const r = outerRect(room);
        const by = r ? circleIntoRect(t.at, t.canopyRadius, r) : 0;
        if (by > 0) out.push(f("warn", "tree.canopy", `${room.name} on ${level.name} reaches ${formatMetres(by)} into the canopy of the ${name}; expect branch cutting.`, [t.id, room.id]));
      }
    }
  }

  // Columns
  const levelIds = new Set(levels.map((l) => l.id));
  const wallsByLevel = new Map(levels.map((l) => [l.id, deriveWalls(project, l.id)] as const));
  for (const c of project.columns) {
    if (!levelIds.has(c.fromLevel) || !levelIds.has(c.toLevel)) {
      out.push(f("block", "column.level_missing", `${colName(c)} runs between levels that do not exist.`, [c.id]));
      continue;
    }
    if (levelIndex(project, c.fromLevel) > levelIndex(project, c.toLevel))
      out.push(f("block", "column.levels_reversed", `${colName(c)} starts above where it ends.`, [c.id]));
    if (!contains(plot, columnRect(c))) out.push(f("block", "column.outside_plot", `${colName(c)} is outside the plot.`, [c.id]));
    const from = levelIndex(project, c.fromLevel);
    if (from > 0) {
      const below = levels[from - 1]!;
      const supported = columnsOn(project, below.id).some((d) => d.id !== c.id && near(d.at, c.at));
      if (!supported)
        out.push(f("warn", "column.floating", `${colName(c)} starts on ${levelName(c.fromLevel)} with no column under it on ${below.name} (a floating column). The engineer will need a transfer beam.`, [c.id]));
    }
    for (let i = from; i <= levelIndex(project, c.toLevel); i++) {
      const level = levels[i]!;
      if (level.kind === "stilt") continue;
      const walls = wallsByLevel.get(level.id) ?? [];
      const inWall = walls.some((w) => onLine(c.at, w.orient, w.at, w.thickness / 2 + SNAP_MM) && along(c.at, w.orient) >= w.from - SNAP_MM && along(c.at, w.orient) <= w.to + SNAP_MM);
      if (inWall) continue;
      const room = roomsOn(level.id).find((r) => {
        const rr = boundaryToRect(r.boundary);
        return rr && c.at[0] > rr.x0 && c.at[0] < rr.x1 && c.at[1] > rr.y0 && c.at[1] < rr.y1;
      });
      if (room) out.push(f("warn", "column.free_standing", `${colName(c)} stands free inside ${room.name} on ${level.name}.`, [c.id, room.id]));
    }
  }
  for (let i = 0; i < project.columns.length; i++)
    for (let j = i + 1; j < project.columns.length; j++) {
      const a = project.columns[i]!;
      const b = project.columns[j]!;
      if (overlapArea(columnRect(a), columnRect(b)) > 0 && spansOverlap(project, a, b))
        out.push(f("block", "column.overlap", `${colName(a)} and ${colName(b)} overlap.`, [a.id, b.id]));
    }

  // Beam spans along walls, on levels that have columns
  if (project.columns.length) {
    const maxSpan = project.prefs.maxSpanMm;
    for (const level of levels) {
      const cols = columnsOn(project, level.id);
      if (!cols.length) continue;
      for (const run of wallRuns(wallsByLevel.get(level.id) ?? [])) {
        const tol = run.walls[0]!.thickness / 2 + SNAP_MM;
        const stops = [
          run.from,
          ...cols.filter((c) => onLine(c.at, run.orient, run.at, tol) && along(c.at, run.orient) > run.from && along(c.at, run.orient) < run.to).map((c) => along(c.at, run.orient)),
          run.to,
        ].sort((a, b) => a - b);
        for (let i = 0; i + 1 < stops.length; i++) {
          const gap = stops[i + 1]! - stops[i]!;
          if (gap <= maxSpan + 1) continue;
          const where = run.orient === "h" ? `the wall at y = ${formatFtIn(run.at)}` : `the wall at x = ${formatFtIn(run.at)}`;
          out.push(
            f("warn", "beam.span", `On ${level.name}, ${where} spans ${formatMetres(gap)} between supports, over the ${formatMetres(maxSpan)} limit set for this project. Add a column or ask the engineer to size a deeper beam.`, run.walls.map((w) => w.id)),
          );
        }
      }
    }
  }

  // Walls on upper floors need a wall or a beam between columns under them
  for (let i = 1; i < levels.length; i++) {
    const level = levels[i]!;
    const below = levels[i - 1]!;
    const under = wallsByLevel.get(below.id) ?? [];
    const cols = columnsOn(project, below.id);
    for (const w of wallsByLevel.get(level.id) ?? []) {
      const len = w.to - w.from;
      const overWall = under
        .filter((u) => u.orient === w.orient && Math.abs(u.at - w.at) <= SNAP_MM)
        .reduce((s, u) => s + Math.max(0, Math.min(u.to, w.to) - Math.max(u.from, w.from)), 0);
      if (overWall >= len * 0.9) continue;
      const onBeam = cols.filter((c) => onLine(c.at, w.orient, w.at, w.thickness / 2 + SNAP_MM)).map((c) => along(c.at, w.orient));
      if (onBeam.some((a) => a <= w.from + SNAP_MM) && onBeam.some((a) => a >= w.to - SNAP_MM)) continue;
      const rooms = w.sourceRooms.map((id) => project.rooms.find((r) => r.id === id)?.name ?? id).join(" / ");
      out.push(f("warn", "wall.unsupported", `A ${formatMetres(len)} wall of ${rooms} on ${level.name} has no wall or beam under it on ${below.name}.`, [w.id, ...w.sourceRooms]));
    }
  }

  // Stairs
  const arrives = new Set<string>();
  for (const s of project.stairs) {
    const fi = levelIndex(project, s.fromLevel);
    const ti = levelIndex(project, s.toLevel);
    if (fi < 0 || ti < 0) {
      out.push(f("block", "stair.level_missing", `The stair ${s.id} connects a level that does not exist.`, [s.id]));
      continue;
    }
    const label = `The stair from ${levelName(s.fromLevel)} to ${levelName(s.toLevel)}`;
    if (ti !== fi + 1) out.push(f("block", "stair.not_consecutive", `${label} must go to the level directly above.`, [s.id]));
    else arrives.add(s.toLevel);
    const lay = stairLayout(project, s);
    if (!lay) {
      out.push(f("block", "stair.not_rectangle", `${label} is not a rectangle.`, [s.id]));
      continue;
    }
    if (!contains(plot, lay.well)) out.push(f("block", "stair.outside_plot", `${label} is outside the plot.`, [s.id]));
    if (lay.length + 1 < lay.requiredLength)
      out.push(
        f("block", "stair.too_small", `${label} needs ${formatFtIn(lay.requiredLength)} (${formatMetres(lay.requiredLength)}) along its run for ${lay.risers} risers at ${s.tread} mm treads with a landing; the well gives ${formatFtIn(lay.length)}.`, [s.id]),
      );
    for (const levelId of [s.fromLevel, s.toLevel]) {
      for (const room of roomsOn(levelId)) {
        const rr = boundaryToRect(room.boundary);
        if (!rr || STAIR_OK.has(room.type) || overlapArea(rr, lay.well) <= 0) continue;
        out.push(f("warn", "stair.in_room", `${label} ${levelId === s.fromLevel ? "stands in" : "opens through the floor of"} ${room.name} on ${levelName(levelId)}.`, [s.id, room.id]));
      }
    }
    for (const c of columnsOn(project, s.fromLevel)) {
      if (lay.flights.some((fl) => overlapArea(fl.rect, columnRect(c)) > 0))
        out.push(f("warn", "stair.column", `${colName(c)} stands in a flight of the stair from ${levelName(s.fromLevel)} to ${levelName(s.toLevel)}.`, [s.id, c.id]));
    }
  }
  for (let i = 0; i < project.stairs.length; i++)
    for (let j = i + 1; j < project.stairs.length; j++) {
      const a = project.stairs[i]!;
      const b = project.stairs[j]!;
      const ra = boundaryToRect(a.boundary);
      const rb = boundaryToRect(b.boundary);
      const share = [a.fromLevel, a.toLevel].some((l) => l === b.fromLevel || l === b.toLevel);
      if (ra && rb && share && overlapArea(ra, rb) > 0 && a.toLevel !== b.fromLevel && b.toLevel !== a.fromLevel)
        out.push(f("block", "stair.overlap", "Two stairs overlap.", [a.id, b.id]));
    }
  for (const level of levels.slice(1)) {
    if (!arrives.has(level.id)) out.push(f("warn", "stair.missing", `${level.name} has no stair up from ${levels[levelIndex(project, level.id) - 1]!.name}.`, [level.id]));
  }

  return out;
}

export function treeName(t: Tree): string {
  return `${t.species.toLowerCase()} tree`;
}

const near = (a: Point, b: Point) => Math.abs(a[0] - b[0]) <= SNAP_MM && Math.abs(a[1] - b[1]) <= SNAP_MM;

function spansOverlap(project: Project, a: Column, b: Column): boolean {
  const ia = [levelIndex(project, a.fromLevel), levelIndex(project, a.toLevel)];
  const ib = [levelIndex(project, b.fromLevel), levelIndex(project, b.toLevel)];
  return ia[0]! <= ib[1]! && ib[0]! <= ia[1]!;
}
