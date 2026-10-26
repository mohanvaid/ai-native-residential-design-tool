/** Layer 1 of validation: model invariants that hold in every jurisdiction. */
import { contains, bbox, boundaryToRect, overlapArea, rectArea, rectDepth, rectWidth, sideLength } from "./geometry.js";
import { HABITABLE, type Finding, type Project, type RoomType } from "./schema.js";
import { formatArea, formatFtIn } from "./units.js";
import { validateFurnishing } from "./furnishing.js";
import { validateStructure } from "./structure.js";
import { clearRect, deriveWalls, resolveOpening, roomRect, type Wall } from "./walls.js";

const SOURCE = "core";
/** Minimum masonry between an opening and the end of its wall. */
export const CORNER_CLEARANCE_MM = 100;
/** Rooms that are open or circulation and need no door of their own. */
const OPEN_TYPES: ReadonlySet<RoomType> = new Set<RoomType>(["sit-out", "car-porch", "balcony", "passage", "staircase"]);

const f = (severity: Finding["severity"], code: string, message: string, elements: string[]): Finding => ({
  severity,
  code,
  message,
  elements,
  source: SOURCE,
});

export function validateModel(project: Project): Finding[] {
  const out: Finding[] = [];
  const plot = bbox(project.plot.boundary);
  const levelIds = new Set(project.levels.map((l) => l.id));
  const wallsByLevel = new Map<string, Wall[]>(project.levels.map((l) => [l.id, deriveWalls(project, l.id)]));

  // Rooms
  const rects = new Map<string, ReturnType<typeof boundaryToRect>>();
  for (const room of project.rooms) {
    const r = boundaryToRect(room.boundary);
    rects.set(room.id, r);
    if (!r) {
      out.push(f("block", "room.not_rectangle", `${room.name} is not an axis-aligned rectangle (only rectangles are supported so far).`, [room.id]));
      continue;
    }
    if (!levelIds.has(room.level)) out.push(f("block", "room.level_missing", `${room.name} is on a level that does not exist.`, [room.id]));
    if (!contains(plot, r)) out.push(f("block", "room.outside_plot", `${room.name} extends beyond the plot boundary.`, [room.id]));

    const walls = wallsByLevel.get(room.level) ?? [];
    const clear = clearRect(walls, room);
    const clearSqm = rectArea(clear) / 1e6;
    const narrow = Math.min(rectWidth(clear), rectDepth(clear));
    if (room.targets.minArea && clearSqm < room.targets.minArea)
      out.push(f("warn", "room.below_min_area", `${room.name} is ${formatArea(clearSqm)}, below its ${formatArea(room.targets.minArea)} target.`, [room.id]));
    if (room.targets.minWidth && narrow < room.targets.minWidth)
      out.push(f("warn", "room.below_min_width", `${room.name} is ${formatFtIn(narrow)} wide, below its ${formatFtIn(room.targets.minWidth)} target.`, [room.id]));
  }

  // Overlaps, per level
  for (let i = 0; i < project.rooms.length; i++) {
    for (let j = i + 1; j < project.rooms.length; j++) {
      const a = project.rooms[i]!;
      const b = project.rooms[j]!;
      const ra = rects.get(a.id);
      const rb = rects.get(b.id);
      if (a.level !== b.level || !ra || !rb) continue;
      const area = overlapArea(ra, rb);
      if (area > 0)
        out.push(f("block", "room.overlap", `${a.name} and ${b.name} overlap by ${formatArea(area / 1e6)}.`, [a.id, b.id]));
    }
  }

  // Openings
  const byLine = new Map<string, { id: string; from: number; to: number }[]>();
  for (const opening of project.openings) {
    const room = project.rooms.find((r) => r.id === opening.host.room);
    if (!room || !rects.get(room.id)) {
      out.push(f("block", "opening.host_missing", `Opening ${opening.id} is on a room that no longer exists.`, [opening.id]));
      continue;
    }
    const length = sideLength(roomRect(room), opening.host.side);
    const label = `${cap(opening.type)} ${opening.id} on the ${opening.host.side} wall of ${room.name}`;
    if (opening.offset + opening.width > length) {
      out.push(f("block", "opening.out_of_wall", `${label} runs past the end of the wall.`, [opening.id, room.id]));
      continue;
    }
    if (opening.offset < CORNER_CLEARANCE_MM || opening.offset + opening.width > length - CORNER_CLEARANCE_MM)
      out.push(f("warn", "opening.corner_clearance", `${label} is within ${CORNER_CLEARANCE_MM} mm of a corner.`, [opening.id]));

    const level = project.levels.find((l) => l.id === room.level);
    if (level && opening.sill + opening.height > level.floorToFloor - level.slabThickness)
      out.push(f("block", "opening.too_tall", `${label} goes above the slab (${opening.sill + opening.height} mm).`, [opening.id]));

    const walls = wallsByLevel.get(room.level) ?? [];
    const res = resolveOpening(project, walls, opening);
    if (res && !res.wall)
      out.push(f("warn", "opening.across_junction", `${label} crosses a junction where another wall meets.`, [opening.id]));
    if (res?.wall && !res.wall.isExternal && (opening.type === "window" || opening.type === "ventilator"))
      out.push(f("warn", "opening.window_internal", `${label} is on an internal wall, so it gives no daylight or air from outside.`, [opening.id]));

    if (res) {
      const key = `${room.level}:${res.orient}:${res.at}`;
      const list = byLine.get(key) ?? [];
      for (const other of list)
        if (res.from < other.to && res.to > other.from)
          out.push(f("block", "opening.overlap", `Openings ${other.id} and ${opening.id} overlap on the same wall.`, [other.id, opening.id]));
      list.push({ id: opening.id, from: res.from, to: res.to });
      byLine.set(key, list);
    }
  }

  // Light, air and access per room
  for (const room of project.rooms) {
    if (!rects.get(room.id)) continue;
    const walls = wallsByLevel.get(room.level) ?? [];
    const hosted = project.openings.filter((o) => o.host.room === room.id);
    const reaching = project.openings
      .map((o) => resolveOpening(project, walls, o))
      .filter((r) => r && (r.opening.host.room === room.id || r.otherRoom === room.id));
    if (HABITABLE.has(room.type)) {
      const lit = hosted.some((o) => {
        const r = resolveOpening(project, walls, o);
        return (o.type === "window" || o.type === "ventilator") && r?.wall?.isExternal;
      });
      if (!lit) out.push(f("warn", "room.no_window", `${room.name} has no window on an external wall.`, [room.id]));
    }
    if (!OPEN_TYPES.has(room.type) && !reaching.some((r) => r!.opening.type === "door" || r!.opening.type === "opening"))
      out.push(f("warn", "room.no_door", `${room.name} has no door.`, [room.id]));
  }

  out.push(...validateStructure(project), ...validateFurnishing(project));
  return out;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
