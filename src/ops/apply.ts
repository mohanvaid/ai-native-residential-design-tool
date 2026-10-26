import {
  boundaryToRect,
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
import { catalogueItem, type CatalogueItem } from "../catalogue/catalogue.js";
import { placeItem } from "../model/furnishing.js";
import { Column, Level, Opening, PlacedItem, Room, Stair, Tree, type OpeningType, type Side } from "../model/schema.js";
import { DEFAULT_MAX_RISER_MM, levelIndex, proposeColumns, stairWellRect, stairWellSize, TREE_DEFAULTS, TREE_FALLBACK } from "../model/structure.js";
import { deriveWalls, roomRect } from "../model/walls.js";
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
      const levels = draft.project.levels;
      const i = levels.findIndex((l) => l.id === op.target);
      for (const st of draft.project.stairs.filter((st) => st.fromLevel === op.target || st.toLevel === op.target)) draft.remove("stair", st.id);
      for (const c of [...draft.project.columns]) {
        if (c.fromLevel === op.target && c.toLevel === op.target) draft.remove("column", c.id);
        else if (c.fromLevel === op.target) draft.put("column", { ...c, fromLevel: levels[i + 1]!.id });
        else if (c.toLevel === op.target) draft.put("column", { ...c, toLevel: levels[i - 1]!.id });
      }
      draft.setLevels(levels.filter((l) => l.id !== op.target));
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
      for (const it of draft.project.items.filter((it) => it.room === op.target)) draft.remove("item", it.id);
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
      for (const it of draft.project.items.filter((it) => it.room === room.id)) draft.put("item", { ...it, at: [it.at[0] + op.args.dx, it.at[1] + op.args.dy] });
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
      const cat = a.catalogue ? catalogueItem(a.catalogue) : undefined;
      if (a.catalogue && !cat) throw new OpError(`"${a.catalogue}" is not in the catalogue.`, "catalogue.missing");
      const d = cat ? { ...OPENING_DEFAULTS[a.type], width: cat.width, height: cat.height } : OPENING_DEFAULTS[a.type];
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
          catalogue: cat?.id,
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

    case "AddTree": {
      const a = op.args;
      const id = a.id ?? draft.nextId("tr");
      if (draft.get("tree", id)) throw new OpError(`Tree id "${id}" already exists.`, "tree.duplicate");
      const d = TREE_DEFAULTS[a.species.toLowerCase()] ?? TREE_FALLBACK;
      draft.put("tree", Tree.parse({ id, species: a.species, at: [a.x, a.y], canopyRadius: a.canopyRadius ?? d.canopy, rootRadius: a.rootRadius ?? d.root, keep: a.keep, meta }));
      return;
    }

    case "UpdateTree": {
      const t = draft.require("tree", op.target);
      const a = op.args;
      draft.put("tree", {
        ...t,
        at: [a.x ?? t.at[0], a.y ?? t.at[1]],
        canopyRadius: a.canopyRadius ?? t.canopyRadius,
        rootRadius: a.rootRadius ?? t.rootRadius,
        keep: a.keep ?? t.keep,
      });
      return;
    }

    case "RemoveTree": {
      draft.require("tree", op.target);
      draft.remove("tree", op.target);
      return;
    }

    case "AddColumn": {
      const a = op.args;
      draft.requireLevel(a.fromLevel);
      const toLevel = a.toLevel ?? topLevel(draft);
      draft.requireLevel(toLevel);
      const id = a.id ?? draft.nextId("col");
      if (draft.get("column", id)) throw new OpError(`Column id "${id}" already exists.`, "column.duplicate");
      draft.put("column", Column.parse({ id, at: [a.x, a.y], width: a.width ?? COLUMN_DEFAULT.width, depth: a.depth ?? COLUMN_DEFAULT.depth, fromLevel: a.fromLevel, toLevel, meta }));
      return;
    }

    case "MoveColumn": {
      const c = draft.require("column", op.target);
      draft.put("column", { ...c, at: [c.at[0] + op.args.dx, c.at[1] + op.args.dy] });
      return;
    }

    case "RemoveColumn": {
      draft.require("column", op.target);
      draft.remove("column", op.target);
      return;
    }

    case "PlaceColumns": {
      const a = op.args;
      const p = draft.project;
      const fromLevel = a.fromLevel ?? p.levels[0]!.id;
      const toLevel = a.toLevel ?? topLevel(draft);
      draft.requireLevel(fromLevel);
      draft.requireLevel(toLevel);
      const [i0, i1] = [levelIndex(p, fromLevel), levelIndex(p, toLevel)];
      if (i0 > i1) throw new OpError("fromLevel is above toLevel.", "column.levels_reversed");
      const ids = p.levels.slice(i0, i1 + 1).map((l) => l.id);
      const pts = proposeColumns(p, ids, a.maxSpan ?? p.prefs.maxSpanMm);
      if (!pts.length) throw new OpError("There are no walls on those levels to place columns on.", "column.no_walls");
      for (const c of p.columns.filter((c) => levelIndex(p, c.fromLevel) >= i0 && levelIndex(p, c.toLevel) <= i1)) draft.remove("column", c.id);
      // Each column rises to the highest level in the range that has a wall on it, so it stops under open terraces.
      const wallsAt = ids.map((id) => deriveWalls(p, id));
      for (const at of pts) {
        let top = 0;
        wallsAt.forEach((walls, i) => {
          if (walls.some((w) => (w.orient === "h" ? Math.abs(at[1] - w.at) <= 50 && at[0] >= w.from - 50 && at[0] <= w.to + 50 : Math.abs(at[0] - w.at) <= 50 && at[1] >= w.from - 50 && at[1] <= w.to + 50))) top = i;
        });
        draft.put("column", Column.parse({ id: draft.nextId("col"), at, width: a.width ?? COLUMN_DEFAULT.width, depth: a.depth ?? COLUMN_DEFAULT.depth, fromLevel, toLevel: ids[top]!, meta }));
      }
      return;
    }

    case "AddStair": {
      const a = op.args;
      const from = draft.requireLevel(a.fromLevel);
      const i = levelIndex(draft.project, a.fromLevel);
      const toLevel = a.toLevel ?? draft.project.levels[i + 1]?.id;
      if (!toLevel) throw new OpError(`There is no level above ${from.name} for the stair to reach. Add the level first.`, "stair.no_level_above");
      draft.requireLevel(toLevel);
      const id = a.id ?? draft.nextId("st");
      if (draft.get("stair", id)) throw new OpError(`Stair id "${id}" already exists.`, "stair.duplicate");
      const risers = a.risers ?? Math.ceil(from.floorToFloor / DEFAULT_MAX_RISER_MM);
      const size = stairWellSize(a.shape, risers, a.tread, a.flightWidth);
      const fitted = stairWellRect(a.x, a.y, a.up, size);
      const well = { x0: a.x, y0: a.y, x1: a.x + (a.width ?? fitted.x1 - fitted.x0), y1: a.y + (a.depth ?? fitted.y1 - fitted.y0) };
      draft.put(
        "stair",
        Stair.parse({ id, fromLevel: a.fromLevel, toLevel, boundary: rectToBoundary(well), shape: a.shape, up: a.up, turn: a.turn, risers: a.risers, tread: a.tread, external: a.external, meta }),
      );
      return;
    }

    case "UpdateStair": {
      const s = draft.require("stair", op.target);
      const a = op.args;
      const r = boundaryToRect(s.boundary);
      if (!r) throw new OpError("The stair is not a rectangle.", "stair.not_rectangle");
      const x0 = r.x0 + (a.dx ?? 0);
      const y0 = r.y0 + (a.dy ?? 0);
      const well = { x0, y0, x1: x0 + (a.width ?? rectWidth(r)), y1: y0 + (a.depth ?? rectDepth(r)) };
      draft.put("stair", {
        ...s,
        boundary: rectToBoundary(well),
        up: a.up ?? s.up,
        shape: a.shape ?? s.shape,
        turn: a.turn ?? s.turn,
        tread: a.tread ?? s.tread,
        ...(a.risers !== undefined ? { risers: a.risers } : {}),
        external: a.external ?? s.external,
      });
      return;
    }

    case "PlaceItem": {
      const a = op.args;
      const room = draft.requireRoom(a.room);
      const cat = requireCatalogue(a.catalogue);
      const id = a.id ?? draft.nextId("it");
      if (draft.get("item", id)) throw new OpError(`Item id "${id}" already exists.`, "item.duplicate");
      const spot = placeItem(draft.project, room, cat, a);
      if ("error" in spot) throw new OpError(spot.error, "item.no_fit");
      draft.put("item", PlacedItem.parse({ id, catalogue: cat.id, room: room.id, at: spot.at, facing: spot.facing, mirror: a.mirror ?? false, meta }));
      return;
    }

    case "MoveItem": {
      const it = draft.require("item", op.target);
      const a = op.args;
      const room = draft.requireRoom(a.room ?? it.room);
      const cat = requireCatalogue(it.catalogue);
      if (a.dx !== undefined || a.dy !== undefined) {
        draft.put("item", { ...it, room: room.id, at: [it.at[0] + (a.dx ?? 0), it.at[1] + (a.dy ?? 0)], facing: a.facing ?? it.facing });
        return;
      }
      if (!a.against && a.x === undefined && a.facing && a.room === undefined) {
        draft.put("item", { ...it, facing: a.facing });
        return;
      }
      const spot = placeItem(draft.project, room, cat, a.x !== undefined ? { ...a, facing: a.facing ?? it.facing } : a, it.id);
      if ("error" in spot) throw new OpError(spot.error, "item.no_fit");
      draft.put("item", { ...it, room: room.id, at: spot.at, facing: spot.facing });
      return;
    }

    case "SwapItem": {
      const it = draft.require("item", op.target);
      const cat = requireCatalogue(op.args.catalogue);
      const old = requireCatalogue(it.catalogue);
      // Keep the back against the same place: shift the centre by half the depth change.
      const dd = (cat.depth - old.depth) / 2;
      const [fx, fy] = OUTWARD[it.facing];
      draft.put("item", { ...it, catalogue: cat.id, at: [Math.round(it.at[0] + fx * dd), Math.round(it.at[1] + fy * dd)] });
      return;
    }

    case "RemoveItem": {
      draft.require("item", op.target);
      draft.remove("item", op.target);
      return;
    }

    case "SetPreferences": {
      const a = op.args;
      const prefs = { ...draft.project.prefs };
      for (const [k, v] of Object.entries(a)) if (v !== undefined) (prefs as Record<string, unknown>)[k] = v;
      draft.setPrefs(prefs);
      return;
    }

    case "RemoveStair": {
      draft.require("stair", op.target);
      draft.remove("stair", op.target);
      return;
    }
  }
}

function requireCatalogue(id: string): CatalogueItem {
  const cat = catalogueItem(id);
  if (!cat) throw new OpError(`"${id}" is not in the catalogue.`, "catalogue.missing");
  if (cat.category === "door" || cat.category === "window") throw new OpError(`"${id}" is a ${cat.category}; add it with AddOpening.`, "catalogue.not_placeable");
  return cat;
}

/** 9" × 12", the usual column for a G+2 house frame. */
export const COLUMN_DEFAULT = { width: 230, depth: 300 };

/** The highest level that has rooms, or the lowest level if none do. */
function topLevel(draft: Draft): string {
  const p = draft.project;
  const withRooms = p.levels.filter((l) => l.kind !== "terrace" && p.rooms.some((r) => r.level === l.id));
  return (withRooms[withRooms.length - 1] ?? p.levels[0]!).id;
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
