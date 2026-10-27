/**
 * Flats (dwelling units) and the area statement: carpet and built-up area per
 * flat, the common areas (lobbies, stairs, lifts) shared out in proportion to
 * built-up area to give a super built-up figure, and the cost per flat on the
 * same basis.
 */
import type { Boq } from "../cost/boq.js";
import { outerRect, unionArea } from "./areas.js";
import { boundaryToRect, rectArea, type Rect } from "./geometry.js";
import type { Project } from "./schema.js";
import { coresOn, coreRect } from "./core.js";
import { clearRect, deriveWalls } from "./walls.js";

export interface FlatArea {
  flat: string;
  levels: string[];
  rooms: number;
  bedrooms: number;
  /** m² */
  carpetSqm: number;
  builtUpSqm: number;
  commonShareSqm: number;
  superBuiltUpSqm: number;
}

export interface AreaStatement {
  flats: FlatArea[];
  /** Lobbies, stairs, lifts and other rooms on no flat, m². */
  commonSqm: number;
  carpetSqm: number;
  builtUpSqm: number;
  /** True when no room is assigned to a flat and the whole building is treated as one home. */
  singleHome: boolean;
}

/** Flat id of every room, treating an unassigned building as one home called "House". */
export function flatIds(project: Project): string[] {
  return [...new Set(project.rooms.map((r) => r.flat).filter((f): f is string => !!f))].sort();
}

export function areaStatement(project: Project): AreaStatement {
  const ids = flatIds(project);
  const singleHome = ids.length === 0;
  const flatOf = (room: Project["rooms"][number]) => (singleHome ? "House" : room.flat);
  const wallsByLevel = new Map(project.levels.map((l) => [l.id, deriveWalls(project, l.id)] as const));
  const flats = new Map<string, FlatArea>();
  let common = 0;

  for (const level of project.levels) {
    const rooms = project.rooms.filter((r) => r.level === level.id && boundaryToRect(r.boundary));
    const walls = wallsByLevel.get(level.id)!;
    const byFlat = new Map<string, Rect[]>();
    for (const room of rooms) {
      const id = flatOf(room);
      if (!id) {
        if (room.type !== "parking" || level.kind !== "stilt") common += unionArea([outerRect(room)!]) / 1e6;
        continue;
      }
      let fa = flats.get(id);
      if (!fa) flats.set(id, (fa = { flat: id, levels: [], rooms: 0, bedrooms: 0, carpetSqm: 0, builtUpSqm: 0, commonShareSqm: 0, superBuiltUpSqm: 0 }));
      if (!fa.levels.includes(level.name)) fa.levels.push(level.name);
      fa.rooms += 1;
      if (room.type === "bedroom") fa.bedrooms += 1;
      fa.carpetSqm += rectArea(clearRect(walls, room)) / 1e6;
      byFlat.set(id, [...(byFlat.get(id) ?? []), outerRect(room)!]);
    }
    for (const [id, rects] of byFlat) flats.get(id)!.builtUpSqm += unionArea(rects) / 1e6;
    if (!singleHome) for (const c of coresOn(project, level.id)) {
      const r = coreRect(c);
      if (r) common += rectArea(r) / 1e6;
    }
    // Stairs count once, on the level they start from
    if (!singleHome)
      for (const s of project.stairs.filter((s) => s.fromLevel === level.id && !s.external)) {
        const r = boundaryToRect(s.boundary);
        const insideRoom = r && rooms.some((room) => !room.flat && boundaryToRect(room.boundary) && rectArea(r) > 0 && overlaps(boundaryToRect(room.boundary)!, r));
        if (r && !insideRoom) common += rectArea(r) / 1e6;
      }
  }

  const list = [...flats.values()];
  const builtUp = list.reduce((s, f) => s + f.builtUpSqm, 0);
  for (const f of list) {
    f.commonShareSqm = builtUp ? (common * f.builtUpSqm) / builtUp : 0;
    f.superBuiltUpSqm = f.builtUpSqm + f.commonShareSqm;
  }
  return { flats: list, commonSqm: singleHome ? 0 : common, carpetSqm: list.reduce((s, f) => s + f.carpetSqm, 0), builtUpSqm: builtUp, singleHome };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

export interface FlatCost {
  flat: string;
  /** Share of the construction total, INR. */
  amount: number;
  perSqftSuperBuiltUp: number;
}

/** Construction cost shared out by super built-up area. */
export function flatCosts(project: Project, boq: Boq, st = areaStatement(project)): FlatCost[] {
  const total = st.flats.reduce((s, f) => s + f.superBuiltUpSqm, 0);
  return st.flats.map((f) => {
    const amount = total ? Math.round((boq.total * f.superBuiltUpSqm) / total) : 0;
    return { flat: f.flat, amount, perSqftSuperBuiltUp: f.superBuiltUpSqm ? Math.round(amount / (f.superBuiltUpSqm * 10.7639)) : 0 };
  });
}
