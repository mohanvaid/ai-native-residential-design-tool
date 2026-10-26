import {
  OPPOSITE,
  OUTWARD,
  isHorizontal,
  moveEdge,
  rectDepth,
  rectToBoundary,
  rectWidth,
  sideLength,
  sideSegment,
  translateRect,
  type Rect,
} from "../model/geometry.js";
import { Level, Opening, Room, type OpeningType, type Side } from "../model/schema.js";
import { roomRect } from "../model/walls.js";
import { zoneOf } from "../model/zones.js";
import { Draft, OpError } from "./changes.js";
import type { Op } from "./definitions.js";

/** Smallest centreline dimension a room may be squeezed to. */
export const MIN_ROOM_DIM_MM = 600;

export const OPENING_DEFAULTS: Record<OpeningType, { width: number; height: number; sill: number }> = {
  door: { width: 900, height: 2100, sill: 0 },
  window: { width: 1200, height: 1200, sill: 900 },
  ventilator: { width: 600, height: 450, sill: 1650 },
  opening: { width: 900, height: 2100, sill: 0 },
};

export function applyOp(draft: Draft, op: Op, opIndex: number): void {
  const createdByOp = `v${draft.version}#${opIndex}:${op.op}`;
  const meta = { createdByOp, lastChangedVersion: draft.version };

  switch (op.op) {
    case "SetPlot": {
      const { widthMm: w, depthMm: d, northAngle } = op.args;
      draft.setPlot({
        ...draft.project.plot,
        boundary: rectToBoundary({ x0: 0, y0: 0, x1: w, y1: d }),
        northAngle: northAngle ?? draft.project.plot.northAngle,
      });
      return;
    }

    case "SetRoad": {
      const { side, widthM, name } = op.args;
      const roads = draft.project.plot.abuttingRoads.filter((r) => r.side !== side);
      if (widthM !== null) roads.push({ side, widthM, ...(name ? { name } : {}) });
      draft.setPlot({ ...draft.project.plot, abuttingRoads: roads });
      return;
    }

    case "AddLevel": {
      const id = op.args.id ?? draft.nextId("lv");
      if (draft.level(id)) throw new OpError(`Level id "${id}" already exists.`, "level.duplicate");
      const level = Level.parse({
        id,
        name: op.args.name,
        kind: op.args.kind,
        elevation: 0,
        floorToFloor: op.args.floorToFloor,
        slabThickness: op.args.slabThickness,
        meta,
      });
      draft.setLevels([...draft.project.levels, level]);
      return;
    }

    case "RemoveLevel": {
      draft.requireLevel(op.target);
      if (draft.project.levels.length === 1) throw new OpError("A project needs at least one level.", "level.last");
      const rooms = draft.project.rooms.filter((r) => r.level === op.target);
      if (rooms.length)
        throw new OpError(
          `Level still has ${rooms.length} room(s): ${rooms.map((r) => r.name).join(", ")}. Remove them first.`,
          "level.not_empty",
        );
      draft.setLevels(draft.project.levels.filter((l) => l.id !== op.target));
      return;
    }

    case "SetLevelHeight": {
      draft.requireLevel(op.target);
      draft.setLevels(
        draft.project.levels.map((l) =>
          l.id === op.target ? { ...l, floorToFloor: op.args.floorToFloor, meta: { ...l.meta, lastChangedVersion: draft.version } } : l,
        ),
      );
      return;
    }

    case "AddRoom": {
      const a = op.args;
      draft.requireLevel(a.level);
      const id = a.id ?? draft.nextId("rm");
      if (draft.room(id)) throw new OpError(`Room id "${id}" already exists.`, "room.duplicate");
      draft.putRoom(
        Room.parse({
          id,
          name: a.name,
          type: a.type,
          level: a.level,
          boundary: rectToBoundary({ x0: a.x, y0: a.y, x1: a.x + a.width, y1: a.y + a.depth }),
          targets: { minArea: a.minArea, minWidth: a.minWidth },
          meta,
        }),
      );
      return;
    }

    case "RemoveRoom": {
      draft.requireRoom(op.target);
      for (const o of draft.project.openings.filter((o) => o.host.room === op.target)) draft.removeOpening(o.id);
      draft.removeRoom(op.target);
      return;
    }

    case "ResizeRoom": {
      const room = draft.requireRoom(op.target);
      const rect = roomRect(room);
      const { edge, strategy } = op.args;
      const along = isHorizontal(edge) ? rectDepth(rect) : rectWidth(rect);
      const delta =
        op.args.delta ??
        Math.round((op.args.targetArea! * 1e6) / (isHorizontal(edge) ? rectWidth(rect) : rectDepth(rect)) / 10) * 10 - along;
      if (delta === 0) return;
      if (along + delta < MIN_ROOM_DIM_MM)
        throw new OpError(`${room.name} would be only ${along + delta} mm across.`, "room.too_small");

      const line = sideSegment(rect, edge);
      if (strategy === "shrink_neighbour") {
        for (const n of neighboursAcross(draft, room, rect, edge)) {
          const nRect = roomRect(n);
          const nAlong = isHorizontal(edge) ? rectDepth(nRect) : rectWidth(nRect);
          if (nAlong - delta < Math.max(MIN_ROOM_DIM_MM, n.targets.minWidth ?? 0))
            throw new OpError(`Shrinking ${n.name} by ${delta} mm makes it too small.`, "neighbour.too_small");
          moveRoomEdge(draft, n, OPPOSITE[edge], -delta);
        }
      } else if (strategy === "push_neighbours" && delta > 0) {
        const [ox, oy] = OUTWARD[edge];
        for (const n of roomsToPush(draft, room, rect, edge, line.at)) {
          draft.putRoom({ ...n, boundary: rectToBoundary(translateRect(roomRect(n), ox * delta, oy * delta)) });
        }
      }
      moveRoomEdge(draft, room, edge, delta);
      return;
    }

    case "MoveRoom": {
      const room = draft.requireRoom(op.target);
      draft.putRoom({ ...room, boundary: rectToBoundary(translateRect(roomRect(room), op.args.dx, op.args.dy)) });
      return;
    }

    case "RenameRoom": {
      draft.putRoom({ ...draft.requireRoom(op.target), name: op.args.name });
      return;
    }

    case "SetRoomType": {
      draft.putRoom({ ...draft.requireRoom(op.target), type: op.args.type });
      return;
    }

    case "AddOpening": {
      const a = op.args;
      const room = draft.requireRoom(a.room);
      const id = a.id ?? draft.nextId("op");
      if (draft.opening(id)) throw new OpError(`Opening id "${id}" already exists.`, "opening.duplicate");
      const d = OPENING_DEFAULTS[a.type];
      const width = a.width ?? d.width;
      const length = sideLength(roomRect(room), a.side);
      const offset = a.offset ?? Math.max(0, Math.round((length - width) / 2));
      draft.putOpening(
        Opening.parse({
          id,
          type: a.type,
          host: { room: room.id, side: a.side },
          offset,
          width,
          height: a.height ?? d.height,
          sill: a.sill ?? d.sill,
          catalogue: a.catalogue,
          swing: a.swing ?? (a.type === "door" ? { hinge: "start", into: "host" } : undefined),
          meta,
        }),
      );
      return;
    }

    case "MoveOpening": {
      const o = draft.requireOpening(op.target);
      const offset = op.args.offset ?? o.offset + op.args.delta!;
      if (offset < 0) throw new OpError(`That would move ${o.id} past the end of its wall.`, "opening.out_of_wall");
      draft.putOpening({ ...o, offset });
      return;
    }

    case "ResizeOpening": {
      const o = draft.requireOpening(op.target);
      const width = op.args.width ?? o.width;
      const shift = op.args.anchor === "start" ? 0 : op.args.anchor === "end" ? o.width - width : Math.round((o.width - width) / 2);
      const offset = o.offset + shift;
      if (offset < 0) throw new OpError(`${o.id} would extend past the start of its wall.`, "opening.out_of_wall");
      draft.putOpening({ ...o, width, offset, height: op.args.height ?? o.height, sill: op.args.sill ?? o.sill });
      return;
    }

    case "RemoveOpening": {
      draft.requireOpening(op.target);
      draft.removeOpening(op.target);
      return;
    }
  }
}

/**
 * Moves one edge of a room outward by delta and keeps every opening at the
 * same absolute position. Offsets are measured from the west or south end of
 * a side, so moving the west or south edge shifts the perpendicular sides' origin.
 */
function moveRoomEdge(draft: Draft, room: Room, side: Side, delta: number): void {
  draft.putRoom({ ...room, boundary: rectToBoundary(moveEdge(roomRect(room), side, delta)) });
  if (side !== "west" && side !== "south") return;
  const perpendicular: Side[] = side === "west" ? ["north", "south"] : ["east", "west"];
  for (const o of draft.project.openings) {
    if (o.host.room === room.id && perpendicular.includes(o.host.side)) draft.putOpening({ ...o, offset: o.offset + delta });
  }
}

/** Rooms on the same level whose opposite side sits on this edge's line and overlaps it. */
function neighboursAcross(draft: Draft, room: Room, rect: Rect, edge: Side): Room[] {
  const seg = sideSegment(rect, edge);
  return draft.project.rooms.filter((n) => {
    if (n.id === room.id || n.level !== room.level) return false;
    const ns = sideSegment(roomRect(n), OPPOSITE[edge]);
    return ns.at === seg.at && ns.start < seg.end && ns.end > seg.start;
  });
}

/**
 * Rooms beyond the moved edge that are in the way, directly or through a
 * chain of rooms that are themselves pushed.
 */
function roomsToPush(draft: Draft, room: Room, rect: Rect, edge: Side, lineAt: number): Room[] {
  const beyond = (r: Rect) => {
    switch (edge) {
      case "east":
        return r.x0 >= lineAt;
      case "west":
        return r.x1 <= lineAt;
      case "north":
        return r.y0 >= lineAt;
      case "south":
        return r.y1 <= lineAt;
    }
  };
  const span = (r: Rect): [number, number] => (isHorizontal(edge) ? [r.x0, r.x1] : [r.y0, r.y1]);
  const candidates = draft.project.rooms.filter((n) => n.id !== room.id && n.level === room.level && beyond(roomRect(n)));
  const pushed: Room[] = [];
  const spans: [number, number][] = [span(rect)];
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of candidates) {
      if (pushed.includes(c)) continue;
      const [s, e] = span(roomRect(c));
      if (spans.some(([a, b]) => s < b && e > a)) {
        pushed.push(c);
        spans.push([s, e]);
        grew = true;
      }
    }
  }
  return pushed;
}

/** Derived fields kept on the model: level elevations and room zone tags. */
export function normalize(draft: Draft): void {
  let elevation = 0;
  let restacked = false;
  const levels = draft.project.levels.map((l) => {
    const next = l.elevation === elevation ? l : ((restacked = true), { ...l, elevation });
    elevation += l.floorToFloor;
    return next;
  });
  if (restacked) draft.setLevels(levels);

  for (const room of draft.project.rooms) {
    const zone = zoneOf(draft.project, room);
    if (room.zoneTags.length !== 1 || room.zoneTags[0] !== zone) draft.putRoom({ ...room, zoneTags: [zone] });
  }
}
