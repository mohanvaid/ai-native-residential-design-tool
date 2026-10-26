/**
 * Walls are derived from room boundaries. Every room side becomes wall; where
 * two rooms share a stretch of the same line it is one internal wall, where a
 * side faces nothing it is an external wall.
 */
import { boundaryToRect, sideSegment, SIDES, type Rect } from "./geometry.js";
import type { Opening, Point, Project, Room, Side } from "./schema.js";

export const EXTERNAL_WALL_MM = 230;
export const INTERNAL_WALL_MM = 115;

export interface Wall {
  id: string;
  level: string;
  start: Point;
  end: Point;
  orient: "h" | "v";
  /** Constant coordinate of the wall centreline. */
  at: number;
  /** Extent along the line: [from, to], from < to. */
  from: number;
  to: number;
  thickness: number;
  height: number;
  isExternal: boolean;
  sourceRooms: string[];
}

interface SideRef {
  room: string;
  side: Side;
  start: number;
  end: number;
}

export function roomRect(room: Room): Rect {
  const r = boundaryToRect(room.boundary);
  if (!r) throw new Error(`Room ${room.id} is not an axis-aligned rectangle; this slice supports rectangles only.`);
  return r;
}

export function deriveWalls(project: Project, levelId: string): Wall[] {
  const level = project.levels.find((l) => l.id === levelId);
  const height = level?.floorToFloor ?? 3000;
  const lines = new Map<string, { orient: "h" | "v"; at: number; refs: SideRef[] }>();

  for (const room of project.rooms) {
    if (room.level !== levelId) continue;
    const rect = boundaryToRect(room.boundary);
    if (!rect) continue;
    for (const side of SIDES) {
      const seg = sideSegment(rect, side);
      const key = `${seg.orient}:${seg.at}`;
      let line = lines.get(key);
      if (!line) lines.set(key, (line = { orient: seg.orient, at: seg.at, refs: [] }));
      line.refs.push({ room: room.id, side, start: seg.start, end: seg.end });
    }
  }

  const walls: Wall[] = [];
  const keys = [...lines.keys()].sort();
  for (const key of keys) {
    const { orient, at, refs } = lines.get(key)!;
    const cuts = [...new Set(refs.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
    let current: { from: number; to: number; rooms: string[] } | null = null;
    const flush = () => {
      if (!current) return;
      const isExternal = current.rooms.length === 1;
      walls.push({
        id: `wl_${levelId}_${orient}${at}_${current.from}`,
        level: levelId,
        orient,
        at,
        from: current.from,
        to: current.to,
        start: orient === "h" ? [current.from, at] : [at, current.from],
        end: orient === "h" ? [current.to, at] : [at, current.to],
        thickness: isExternal ? EXTERNAL_WALL_MM : INTERNAL_WALL_MM,
        height,
        isExternal,
        sourceRooms: current.rooms,
      });
      current = null;
    };
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i]!;
      const b = cuts[i + 1]!;
      const rooms = [...new Set(refs.filter((r) => r.start <= a && r.end >= b).map((r) => r.room))].sort();
      if (rooms.length === 0) {
        flush();
        continue;
      }
      if (current && current.to === a && current.rooms.join() === rooms.join()) {
        current.to = b;
      } else {
        flush();
        current = { from: a, to: b, rooms };
      }
    }
    flush();
  }
  return walls;
}

/** The derived walls lying on one side of a room, ordered along the side. */
export function wallsOnSide(walls: Wall[], room: Room, side: Side): Wall[] {
  const seg = sideSegment(roomRect(room), side);
  return walls
    .filter(
      (w) =>
        w.orient === seg.orient &&
        w.at === seg.at &&
        w.sourceRooms.includes(room.id) &&
        w.from < seg.end &&
        w.to > seg.start,
    )
    .sort((a, b) => a.from - b.from);
}

/** Room rectangle inset to the faces of its walls: the clear (carpet) size. */
export function clearRect(walls: Wall[], room: Room): Rect {
  const r = roomRect(room);
  const half = (side: Side) => Math.max(0, ...wallsOnSide(walls, room, side).map((w) => w.thickness)) / 2;
  return { x0: r.x0 + half("west"), x1: r.x1 - half("east"), y0: r.y0 + half("south"), y1: r.y1 - half("north") };
}

export interface ResolvedOpening {
  opening: Opening;
  /** Extent along the host wall line. */
  from: number;
  to: number;
  orient: "h" | "v";
  at: number;
  /** The wall that fully contains the opening, if any. */
  wall: Wall | null;
  /** The other room the opening leads to, or null for outside. */
  otherRoom: string | null;
}

export function resolveOpening(project: Project, walls: Wall[], opening: Opening): ResolvedOpening | null {
  const room = project.rooms.find((r) => r.id === opening.host.room);
  if (!room) return null;
  const seg = sideSegment(roomRect(room), opening.host.side);
  const from = seg.start + opening.offset;
  const to = from + opening.width;
  const wall =
    wallsOnSide(walls, room, opening.host.side).find((w) => w.from <= from && w.to >= to) ?? null;
  const otherRoom = wall?.sourceRooms.find((id) => id !== room.id) ?? null;
  return { opening, from, to, orient: seg.orient, at: seg.at, wall, otherRoom };
}
