/**
 * Stacked wet areas: toilets, kitchens and utilities should sit over wet
 * rooms on the floor below, so soil and waste pipes drop straight down, and
 * they need an outside wall for the pipes and the duct.
 */
import { boundaryToRect, overlapArea, rectArea, SIDES } from "./geometry.js";
import type { Finding, Project, Room, RoomType } from "./schema.js";
import { deriveWalls, wallsOnSide, type Wall } from "./walls.js";

export const WET: ReadonlySet<RoomType> = new Set<RoomType>(["toilet", "kitchen", "utility"]);
/** Rooms a toilet should never sit over. */
const NOT_UNDER_TOILET: ReadonlySet<RoomType> = new Set<RoomType>(["bedroom", "kitchen", "puja", "dining"]);

const f = (severity: Finding["severity"], code: string, message: string, elements: string[]): Finding => ({
  severity,
  code,
  message,
  elements,
  source: "core",
});

export function validateWetStack(project: Project): Finding[] {
  const out: Finding[] = [];
  const levels = project.levels;
  const walls = new Map<string, Wall[]>(levels.map((l) => [l.id, deriveWalls(project, l.id)]));
  const on = (id: string) => project.rooms.filter((r) => r.level === id && boundaryToRect(r.boundary));

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    for (const room of on(level.id)) {
      if (!WET.has(room.type)) continue;
      const kind = room.type === "toilet" ? "toilet" : room.type;

      // Pipes and a duct need an outside wall.
      const lw = walls.get(level.id) ?? [];
      if (!SIDES.some((s) => wallsOnSide(lw, room, s).some((w) => w.isExternal)))
        out.push(f("warn", "wet.no_outside_wall", `${room.name} on ${level.name} has no outside wall for its ${kind === "toilet" ? "soil pipe and duct" : "waste pipe"}; it will need a shaft.`, [room.id]));

      if (i === 0) continue;
      const below = levels[i - 1]!;
      // Over an open stilt the pipes run under its slab to an outside stack.
      if (below.kind === "stilt") continue;
      const r = boundaryToRect(room.boundary)!;
      const under = on(below.id)
        .map((b) => ({ b, area: overlapArea(r, boundaryToRect(b.boundary)!) }))
        .filter((x) => x.area > 0.05 * rectArea(r));
      if (!under.length) continue;
      if (room.type === "toilet") {
        const bad = under.filter((x) => NOT_UNDER_TOILET.has(x.b.type));
        if (bad.length) {
          out.push(f("warn", "wet.toilet_above", `${room.name} on ${level.name} sits over ${names(bad.map((x) => x.b))} on ${below.name}; pipes would run through that ceiling.`, [room.id, ...bad.map((x) => x.b.id)]));
          continue;
        }
      }
      const wetArea = under.filter((x) => WET.has(x.b.type)).reduce((s, x) => s + x.area, 0);
      if (wetArea < 0.5 * rectArea(r))
        out.push(f("warn", "wet.not_stacked", `${room.name} on ${level.name} is not over a wet room on ${below.name} (it is over ${names(under.map((x) => x.b))}). Stacking it over a toilet or kitchen keeps the pipes short.`, [room.id]));
    }
  }
  return out;
}

const names = (rooms: Room[]) => rooms.map((r) => r.name).join(" and ");
