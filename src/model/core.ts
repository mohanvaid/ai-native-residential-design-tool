/**
 * Vertical circulation and cores: lifts, shafts and ducts through a range of
 * levels, and the checks that keep stairs and lifts continuous and usable on
 * every floor (landing in front of each lift door, no door swinging into it,
 * stair headroom and riser consistency between flights).
 */
import { boundaryToRect, contains, bbox, overlapArea, rectDepth, rectWidth, type Rect } from "./geometry.js";
import { doorSwings } from "./furnishing.js";
import type { Core, Finding, Project, RoomType } from "./schema.js";
import { levelIndex, stairLayout } from "./structure.js";
import { formatFtIn, formatMetres } from "./units.js";
import { deriveWalls } from "./walls.js";

const SOURCE = "core";
const f = (severity: Finding["severity"], code: string, message: string, elements: string[]): Finding => ({ severity, code, message, elements, source: SOURCE });

/** Depth of the clear landing kept in front of a lift door. */
export const LIFT_LANDING_MM = 1500;
/** Enclosure wall of a lift shaft, deducted from the outer size to get the clear shaft. */
export const SHAFT_WALL_MM = 230;
/** Clear headroom over a stair flight (NBC 2016 Part 4, 4.8). */
export const STAIR_HEADROOM_MM = 2200;
const WAIST_MM = 150;

/** Clear shaft a passenger lift needs, by rated persons (IS 14665 guidance for machine-room-less lifts), [width, depth] mm. */
const LIFT_SHAFT: { persons: number; shaft: [number, number] }[] = [
  { persons: 4, shaft: [1200, 1500] },
  { persons: 6, shaft: [1500, 1800] },
  { persons: 8, shaft: [1700, 1900] },
];

/** Rooms a lift may open into. */
const LANDING_OK: ReadonlySet<RoomType> = new Set<RoomType>(["lobby", "passage", "living", "dining", "staircase", "parking", "car-porch", "sit-out", "other"]);

export function coreRect(c: Core): Rect | null {
  return boundaryToRect(c.boundary);
}

/** Cores passing through a level. */
export function coresOn(project: Project, levelId: string): Core[] {
  const i = levelIndex(project, levelId);
  return project.cores.filter((c) => levelIndex(project, c.fromLevel) <= i && levelIndex(project, c.toLevel) >= i);
}

export function coreName(c: Core): string {
  return c.name ?? (c.kind === "lift" ? "the lift" : `the ${c.kind}`);
}

/** The landing zone in front of a lift door. */
export function liftLanding(c: Core): Rect | null {
  const r = coreRect(c);
  if (!r || !c.doorSide) return null;
  const d = LIFT_LANDING_MM;
  switch (c.doorSide) {
    case "north":
      return { x0: r.x0, x1: r.x1, y0: r.y1, y1: r.y1 + d };
    case "south":
      return { x0: r.x0, x1: r.x1, y0: r.y0 - d, y1: r.y0 };
    case "east":
      return { x0: r.x1, x1: r.x1 + d, y0: r.y0, y1: r.y1 };
    case "west":
      return { x0: r.x0 - d, x1: r.x0, y0: r.y0, y1: r.y1 };
  }
}

export function validateCores(project: Project): Finding[] {
  const out: Finding[] = [];
  const plot = bbox(project.plot.boundary);
  const levels = project.levels;
  const levelName = (id: string) => levels.find((l) => l.id === id)?.name ?? id;
  const roomsOn = (id: string) => project.rooms.filter((r) => r.level === id);

  for (const c of project.cores) {
    const name = coreName(c);
    const fi = levelIndex(project, c.fromLevel);
    const ti = levelIndex(project, c.toLevel);
    if (fi < 0 || ti < 0) {
      out.push(f("block", "core.level_missing", `${cap(name)} runs between levels that do not exist.`, [c.id]));
      continue;
    }
    const r = coreRect(c);
    if (!r) {
      out.push(f("block", "core.not_rectangle", `${cap(name)} is not a rectangle.`, [c.id]));
      continue;
    }
    if (!contains(plot, r)) out.push(f("block", "core.outside_plot", `${cap(name)} is outside the plot.`, [c.id]));

    for (let i = fi; i <= ti; i++) {
      const level = levels[i]!;
      for (const room of roomsOn(level.id)) {
        const rr = boundaryToRect(room.boundary);
        if (rr && overlapArea(rr, r) > 0) out.push(f("block", "core.room_overlap", `${cap(name)} runs through ${room.name} on ${level.name}.`, [c.id, room.id]));
      }
    }
    for (const s of project.stairs) {
      const sr = boundaryToRect(s.boundary);
      const si = levelIndex(project, s.fromLevel);
      if (sr && si >= fi && si <= ti && overlapArea(sr, r) > 0) out.push(f("block", "core.stair_overlap", `${cap(name)} overlaps the stair from ${levelName(s.fromLevel)}.`, [c.id, s.id]));
    }

    if (c.kind !== "lift") continue;

    // Shaft size for the rated load
    const persons = c.persons ?? 6;
    const need = [...LIFT_SHAFT].reverse().find((l) => l.persons <= persons) ?? LIFT_SHAFT[0]!;
    const clear: [number, number] = [rectWidth(r) - 2 * SHAFT_WALL_MM, rectDepth(r) - 2 * SHAFT_WALL_MM];
    const [nw, nd] = need.shaft;
    const fits = (clear[0] >= nw && clear[1] >= nd) || (clear[0] >= nd && clear[1] >= nw);
    if (!fits)
      out.push(
        f("warn", "lift.small", `${cap(name)} has a clear shaft of ${formatFtIn(clear[0])} × ${formatFtIn(clear[1])} inside 9" walls; a ${persons}-person lift needs about ${formatFtIn(nw)} × ${formatFtIn(nd)}. Check with the lift supplier.`, [c.id]),
      );

    if (!c.doorSide) {
      out.push(f("warn", "lift.no_door_side", `${cap(name)} has no landing door side set.`, [c.id]));
      continue;
    }

    // Landing on every floor it serves
    const landing = liftLanding(c)!;
    for (let i = fi; i <= ti; i++) {
      const level = levels[i]!;
      const rooms = roomsOn(level.id);
      if (!rooms.length) continue;
      const onto = rooms.filter((room) => {
        const rr = boundaryToRect(room.boundary);
        return rr && overlapArea(rr, landing) > 0;
      });
      if (!onto.length) {
        out.push(f("warn", "lift.no_landing", `On ${level.name}, ${name} opens ${c.doorSide} onto no room; it needs a lobby or passage at least ${formatMetres(LIFT_LANDING_MM)} deep.`, [c.id]));
        continue;
      }
      for (const room of onto)
        if (!LANDING_OK.has(room.type)) out.push(f("warn", "lift.landing_room", `On ${level.name}, ${name} opens straight into ${room.name}; lifts should open into a lobby or passage.`, [c.id, room.id]));
      // Doors that swing into the lift landing
      for (const sw of doorSwings(project, level.id, deriveWalls(project, level.id)))
        if (overlapArea(sw.rect, landing) > 0)
          out.push(f("warn", "door.swing_lift_lobby", `On ${level.name}, door ${sw.opening.opening.id} swings into the landing in front of ${name}.`, [sw.opening.opening.id, c.id]));
    }

    // A lift should serve every floor that has rooms
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i]!;
      if ((i < fi || i > ti) && level.kind !== "terrace" && roomsOn(level.id).length)
        out.push(f("warn", "lift.not_all_floors", `${cap(name)} does not reach ${level.name}.`, [c.id, level.id]));
    }
  }

  // Cores overlapping each other
  for (let i = 0; i < project.cores.length; i++)
    for (let j = i + 1; j < project.cores.length; j++) {
      const a = project.cores[i]!;
      const b = project.cores[j]!;
      const ra = coreRect(a);
      const rb = coreRect(b);
      if (ra && rb && overlapArea(ra, rb) > 0) out.push(f("block", "core.overlap", `${cap(coreName(a))} and ${coreName(b)} overlap.`, [a.id, b.id]));
    }

  out.push(...validateStairFlow(project));
  return out;
}

/** Riser heights consistent between floors, and headroom under the flight above. */
function validateStairFlow(project: Project): Finding[] {
  const out: Finding[] = [];
  const levels = project.levels;
  const stairs = [...project.stairs].sort((a, b) => levelIndex(project, a.fromLevel) - levelIndex(project, b.fromLevel));
  const layouts = new Map(stairs.map((s) => [s.id, stairLayout(project, s)]));
  const levelName = (id: string) => levels.find((l) => l.id === id)?.name ?? id;

  for (let i = 0; i + 1 < stairs.length; i++) {
    const a = stairs[i]!;
    const b = stairs.find((s) => s.fromLevel === a.toLevel);
    const la = layouts.get(a.id);
    const lb = b ? layouts.get(b.id) : null;
    if (!b || !la || !lb) continue;
    if (Math.abs(la.riserHeight - lb.riserHeight) > 10)
      out.push(f("warn", "stair.riser_inconsistent", `Risers change from ${Math.round(la.riserHeight)} mm (${levelName(a.fromLevel)} up) to ${Math.round(lb.riserHeight)} mm (${levelName(b.fromLevel)} up); keep them within 10 mm through the building.`, [a.id, b.id]));
    if (a.tread !== b.tread) out.push(f("warn", "stair.tread_inconsistent", `Treads change from ${a.tread} mm to ${b.tread} mm between floors.`, [a.id, b.id]));
  }

  // Headroom: each nosing against the soffit of the flight directly above it
  for (const s of stairs) {
    const lay = layouts.get(s.id);
    const above = stairs.find((x) => x.fromLevel === s.toLevel);
    const layUp = above ? layouts.get(above.id) : null;
    const from = levels.find((l) => l.id === s.fromLevel);
    const to = levels.find((l) => l.id === s.toLevel);
    if (!lay || !layUp || !from || !to || !above) continue;
    const upSteps = steps(layUp);
    let worst = Infinity;
    for (const st of steps(lay)) {
      for (const u of upSteps) {
        if (!(st.p[0] >= u.rect.x0 && st.p[0] <= u.rect.x1 && st.p[1] >= u.rect.y0 && st.p[1] <= u.rect.y1)) continue;
        const soffit = to.elevation + u.h - WAIST_MM - layUp.riserHeight;
        worst = Math.min(worst, soffit - (from.elevation + st.h));
      }
    }
    if (worst < STAIR_HEADROOM_MM)
      out.push(f("warn", "stair.headroom", `Headroom on the stair from ${levelName(s.fromLevel)} drops to ${formatMetres(worst)} under the flight above; ${formatMetres(STAIR_HEADROOM_MM)} is the minimum (NBC 2016 Part 4, 4.8).`, [s.id, above.id]));
  }
  return out;
}

/** Each tread as a point on its walking line with its height, and the tread's footprint. */
function steps(lay: NonNullable<ReturnType<typeof stairLayout>>): { p: [number, number]; h: number; rect: Rect }[] {
  const out: { p: [number, number]; h: number; rect: Rect }[] = [];
  let climbed = 0;
  lay.flights.forEach((fl) => {
    const nosings = fl.nosings;
    nosings.forEach((n, k) => {
      const h = (climbed + k + 1) * lay.riserHeight;
      const p: [number, number] = [(n[0][0] + n[1][0]) / 2, (n[0][1] + n[1][1]) / 2];
      const xs = [n[0][0], n[1][0]];
      const ys = [n[0][1], n[1][1]];
      const half = 130;
      const vertical = fl.dir === "north" || fl.dir === "south";
      out.push({ p, h, rect: vertical ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: p[1] - half, y1: p[1] + half } : { x0: p[0] - half, x1: p[0] + half, y0: Math.min(...ys), y1: Math.max(...ys) } });
    });
    climbed += fl.risers;
  });
  return out;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
