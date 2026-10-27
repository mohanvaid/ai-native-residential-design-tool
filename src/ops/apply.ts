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
import { catalogueItem, FINISH_CATEGORIES, type Category, type CatalogueItem } from "../catalogue/catalogue.js";
import { rateFor } from "../cost/rates.js";
import { itemRect, placeItem } from "../model/furnishing.js";
import { INTERIOR_THEMES, interiorTheme, themeFinishes } from "../model/themes.js";
import { assignCircuits, boardPoints, linkStacks, roomPoints, STANDARD_HEIGHT, type MepDraft } from "../model/mep.js";
import { Column, Core, Level, MepPoint, Opening, PlacedItem, Room, Stair, Tree, type OpeningType, type Side } from "../model/schema.js";
import { DEFAULT_MAX_RISER_MM, levelIndex, proposeColumns, stairWellRect, stairWellSize, TREE_DEFAULTS, TREE_FALLBACK } from "../model/structure.js";
import { deriveWalls, roomRect } from "../model/walls.js";
import { zoneOf } from "../model/zones.js";
import { RULE_PACKS } from "../rules/registry.js";
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
      for (const c of draft.project.cores.filter((c) => c.fromLevel === op.target || c.toLevel === op.target)) {
        const lv = draft.project.levels;
        const j = lv.findIndex((l) => l.id === op.target);
        if (c.fromLevel === op.target && c.toLevel === op.target) draft.remove("core", c.id);
        else if (c.fromLevel === op.target) draft.put("core", { ...c, fromLevel: lv[j + 1]!.id });
        else draft.put("core", { ...c, toLevel: lv[j - 1]!.id });
      }
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
      for (const pt of draft.project.mep.filter((pt) => pt.room === op.target)) draft.remove("mep", pt.id);
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
      moveRoomBy(draft, draft.requireRoom(op.target), op.args.dx, op.args.dy);
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

    case "SetFinish": {
      const a = op.args;
      const cat = a.catalogue === null ? null : catalogueItem(a.catalogue);
      if (cat === undefined || (cat && !FINISH_FOR[a.surface].includes(cat.category)))
        throw new OpError(`"${a.catalogue}" is not a ${a.surface} finish in the catalogue.`, "catalogue.missing");
      for (const id of a.rooms) {
        const room = draft.requireRoom(id);
        const finishes = { ...room.finishes };
        if (cat) finishes[a.surface] = cat.id;
        else delete finishes[a.surface];
        draft.putRoom({ ...room, finishes });
      }
      return;
    }

    case "ApplyTheme": {
      const theme = interiorTheme(op.args.theme);
      if (!theme) throw new OpError(`There is no interior theme "${op.args.theme}"; try ${INTERIOR_THEMES.map((t) => t.id).join(", ")}.`, "theme.missing");
      const rooms = op.args.rooms ? op.args.rooms.map((id) => draft.requireRoom(id)) : draft.project.rooms;
      for (const room of rooms) {
        const set = themeFinishes(theme, room.type);
        const finishes = { ...room.finishes };
        for (const surface of ["floor", "wall", "ceiling"] as const) if (set[surface]) finishes[surface] = set[surface]!;
        draft.putRoom({ ...room, finishes });
      }
      if (!op.args.rooms) draft.setPrefs({ ...draft.project.prefs, interiorTheme: theme.id });
      return;
    }

    case "MergeRooms": {
      const rooms = [...new Set(op.args.rooms)].map((id) => draft.requireRoom(id));
      const keep = rooms[0]!;
      if (rooms.some((r) => r.level !== keep.level)) throw new OpError("Rooms on different levels cannot be merged.", "merge.levels");
      const rects = rooms.map(roomRect);
      const box = { x0: Math.min(...rects.map((r) => r.x0)), y0: Math.min(...rects.map((r) => r.y0)), x1: Math.max(...rects.map((r) => r.x1)), y1: Math.max(...rects.map((r) => r.y1)) };
      const sum = rects.reduce((t, r) => t + rectWidth(r) * rectDepth(r), 0);
      if (Math.abs(sum - rectWidth(box) * rectDepth(box)) > 1 || rects.some((a, i) => rects.some((b, j) => j > i && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1)))
        throw new OpError(`${rooms.map((r) => r.name).join(" and ")} do not make a rectangle together, so they cannot become one room.`, "merge.not_rectangle");
      const ids = new Set(rooms.map((r) => r.id));
      for (const o of draft.project.openings.filter((o) => ids.has(o.host.room))) {
        const from = roomRect(draft.requireRoom(o.host.room));
        const line = sideSegment(from, o.host.side).at;
        const onBoundary = isHorizontal(o.host.side) ? line === box.y0 || line === box.y1 : line === box.x0 || line === box.x1;
        // Openings between the merged rooms go with the walls they were in
        if (!onBoundary) draft.removeOpening(o.id);
        else draft.putOpening({ ...o, host: { ...o.host, room: keep.id }, offset: alongStart(from, o.host.side) + o.offset - alongStart(box, o.host.side) });
      }
      for (const it of draft.project.items.filter((it) => ids.has(it.room))) draft.put("item", { ...it, room: keep.id });
      for (const pt of draft.project.mep.filter((pt) => ids.has(pt.room))) draft.put("mep", { ...pt, room: keep.id });
      for (const r of rooms.slice(1)) draft.removeRoom(r.id);
      draft.putRoom({ ...keep, name: op.args.name ?? keep.name, type: op.args.type ?? keep.type, boundary: rectToBoundary(box) });
      return;
    }

    case "SplitRoom": {
      const a = op.args;
      const room = draft.requireRoom(op.target);
      const rect = roomRect(room);
      const ew = a.direction === "east-west";
      const span = ew ? rectWidth(rect) : rectDepth(rect);
      if (a.at < MIN_ROOM_DIM_MM || span - a.at < MIN_ROOM_DIM_MM)
        throw new OpError(`Splitting ${room.name} at ${a.at} mm leaves a part under ${MIN_ROOM_DIM_MM} mm across.`, "room.too_small");
      const cut = (ew ? rect.x0 : rect.y0) + a.at;
      const first: Rect = ew ? { ...rect, x1: cut } : { ...rect, y1: cut };
      const second: Rect = ew ? { ...rect, x0: cut } : { ...rect, y0: cut };
      const id = a.id ?? draft.nextId("rm");
      if (draft.room(id)) throw new OpError(`Room id "${id}" already exists.`, "room.duplicate");
      const other = Room.parse({ ...room, id, name: a.name ?? `${room.name} 2`, type: a.type ?? room.type, boundary: rectToBoundary(second), targets: {}, meta });
      draft.putRoom({ ...room, boundary: rectToBoundary(first) });
      draft.putRoom(other);
      const farSide: Side = ew ? "east" : "north";
      for (const o of draft.project.openings.filter((o) => o.host.room === room.id)) {
        if (o.host.side === farSide) {
          draft.putOpening({ ...o, host: { ...o.host, room: id } });
          continue;
        }
        const along = ew ? !isHorizontal(o.host.side) : isHorizontal(o.host.side);
        if (along) continue; // the near side stays with the first part
        // Sides the new wall crosses: the opening goes with the part holding its centre, kept inside that part
        const abs = alongStart(rect, o.host.side) + o.offset;
        const inSecond = abs + o.width / 2 > cut;
        const part = inSecond ? second : first;
        const len = sideLength(part, o.host.side);
        const offset = Math.min(Math.max(0, abs - alongStart(part, o.host.side)), Math.max(0, len - o.width));
        draft.putOpening({ ...o, host: { ...o.host, room: inSecond ? id : room.id }, offset, width: Math.min(o.width, len) });
      }
      const inside = (p: readonly [number, number]) => (ew ? p[0] >= cut : p[1] >= cut);
      for (const it of draft.project.items.filter((it) => it.room === room.id && inside(it.at))) draft.put("item", { ...it, room: id });
      for (const pt of draft.project.mep.filter((pt) => pt.room === room.id && inside(pt.at))) draft.put("mep", { ...pt, room: id });
      if (a.door) {
        const len = sideLength(first, farSide);
        const width = Math.min(room.type === "toilet" || other.type === "toilet" ? 750 : 900, len - 200);
        if (width >= 600)
          draft.putOpening(Opening.parse({ id: draft.nextId("op"), type: "door", host: { room: room.id, side: farSide }, offset: Math.round((len - width) / 2), ...OPENING_DEFAULTS.door, width, swing: { hinge: "start", into: "host" }, meta }));
      }
      return;
    }

    case "SetRuleProfile": {
      const a = op.args;
      if (a.ruleSets) {
        const unknown = a.ruleSets.filter((id) => !RULE_PACKS.some((p) => p.id === id));
        if (unknown.length) throw new OpError(`There is no rule pack "${unknown[0]}". Known packs: ${RULE_PACKS.map((p) => p.id).join(", ")}.`, "rulepack.unknown");
      }
      draft.setRules({ jurisdiction: a.jurisdiction, ruleSets: a.ruleSets });
      if (a.vastu) draft.setPrefs({ ...draft.project.prefs, vastu: a.vastu });
      return;
    }

    case "AutoPlaceMep": {
      const rooms = op.args.rooms ? op.args.rooms.map((id) => draft.requireRoom(id)) : draft.project.rooms;
      const ids = new Set(rooms.map((r) => r.id));
      for (const pt of draft.project.mep.filter((pt) => pt.auto && ids.has(pt.room))) draft.remove("mep", pt.id);
      const walls = new Map<string, ReturnType<typeof deriveWalls>>();
      const fresh: MepDraft[] = [];
      for (const room of rooms) {
        if (!walls.has(room.level)) walls.set(room.level, deriveWalls(draft.project, room.level));
        fresh.push(...roomPoints(draft.project, room, walls.get(room.level)));
      }
      fresh.push(...boardPoints(draft.project, [...draft.project.mep, ...fresh]));
      for (const pt of fresh) draft.put("mep", MepPoint.parse({ ...pt, id: draft.nextId("mep"), meta }));
      relinkMep(draft);
      return;
    }

    case "AddMepPoint": {
      const a = op.args;
      const room = draft.requireRoom(a.room);
      const id = a.id ?? draft.nextId("mep");
      if (draft.project.mep.some((p) => p.id === id)) throw new OpError(`Point id "${id}" already exists.`, "mep.duplicate");
      draft.put("mep", MepPoint.parse({ id, kind: a.kind, room: room.id, at: [a.x, a.y], heightMm: a.heightMm ?? STANDARD_HEIGHT[a.kind], circuit: a.circuit, auto: false, meta }));
      relinkMep(draft);
      return;
    }

    case "MoveMepPoint": {
      const pt = draft.project.mep.find((p) => p.id === op.target);
      if (!pt) throw new OpError(`There is no electrical or plumbing point "${op.target}".`, "mep.missing");
      const a = op.args;
      draft.put("mep", { ...pt, at: [pt.at[0] + (a.dx ?? 0), pt.at[1] + (a.dy ?? 0)], heightMm: a.heightMm ?? pt.heightMm, circuit: a.circuit ?? pt.circuit, auto: false });
      relinkMep(draft);
      return;
    }

    case "RemoveMepPoint": {
      if (!draft.project.mep.some((p) => p.id === op.target)) throw new OpError(`There is no electrical or plumbing point "${op.target}".`, "mep.missing");
      draft.remove("mep", op.target);
      relinkMep(draft);
      return;
    }

    case "AlignElements": {
      const { targets, to, edge } = op.args;
      const ref = elementRect(draft, to);
      const pick = (r: Rect) => ({ west: r.x0, east: r.x1, south: r.y0, north: r.y1, "centre-x": (r.x0 + r.x1) / 2, "centre-y": (r.y0 + r.y1) / 2 })[edge];
      const xAxis = edge === "west" || edge === "east" || edge === "centre-x";
      for (const id of targets) {
        if (id === to) continue;
        const d = Math.round(pick(ref) - pick(elementRect(draft, id)));
        if (!d) continue;
        const [dx, dy] = xAxis ? [d, 0] : [0, d];
        const room = draft.room(id);
        if (room) moveRoomBy(draft, room, dx, dy);
        else {
          const it = draft.project.items.find((i) => i.id === id)!;
          draft.put("item", { ...it, at: [it.at[0] + dx, it.at[1] + dy] });
        }
      }
      return;
    }

    case "SetPreferences": {
      const a = op.args;
      const prefs = { ...draft.project.prefs };
      for (const [k, v] of Object.entries(a)) if (v !== undefined) (prefs as Record<string, unknown>)[k] = v;
      draft.setPrefs(prefs);
      return;
    }

    case "SetRate": {
      const { code, rate } = op.args;
      const cat = catalogueItem(code);
      if (!rateFor(code) && !cat) throw new OpError(`"${code}" is not a rate code or catalogue id.`, "rate.unknown");
      const key = rateFor(code) ? code : cat!.id;
      const rates = { ...draft.project.prefs.rates };
      if (rate === null) delete rates[key];
      else rates[key] = rate;
      draft.setPrefs({ ...draft.project.prefs, rates });
      return;
    }

    case "RemoveStair": {
      draft.require("stair", op.target);
      draft.remove("stair", op.target);
      return;
    }

    case "AddCore": {
      const a = op.args;
      const id = a.id ?? draft.nextId(a.kind === "lift" ? "lift" : "core");
      if (draft.get("core", id)) throw new OpError(`Core id "${id}" already exists.`, "core.duplicate");
      const fromLevel = a.fromLevel ?? draft.project.levels[0]!.id;
      const toLevel = a.toLevel ?? topLevel(draft);
      draft.requireLevel(fromLevel);
      draft.requireLevel(toLevel);
      if (levelIndex(draft.project, fromLevel) > levelIndex(draft.project, toLevel)) throw new OpError("fromLevel is above toLevel.", "core.levels_reversed");
      draft.put(
        "core",
        Core.parse({
          id,
          kind: a.kind,
          name: a.name,
          boundary: rectToBoundary({ x0: a.x, y0: a.y, x1: a.x + a.width, y1: a.y + a.depth }),
          fromLevel,
          toLevel,
          doorSide: a.doorSide,
          persons: a.kind === "lift" ? (a.persons ?? 6) : undefined,
          meta,
        }),
      );
      return;
    }

    case "UpdateCore": {
      const c = draft.require("core", op.target);
      const a = op.args;
      const r = boundaryToRect(c.boundary);
      if (!r) throw new OpError("The core is not a rectangle.", "core.not_rectangle");
      const x0 = r.x0 + (a.dx ?? 0);
      const y0 = r.y0 + (a.dy ?? 0);
      const fromLevel = a.fromLevel ?? c.fromLevel;
      const toLevel = a.toLevel ?? c.toLevel;
      draft.requireLevel(fromLevel);
      draft.requireLevel(toLevel);
      if (levelIndex(draft.project, fromLevel) > levelIndex(draft.project, toLevel)) throw new OpError("fromLevel is above toLevel.", "core.levels_reversed");
      draft.put("core", {
        ...c,
        boundary: rectToBoundary({ x0, y0, x1: x0 + (a.width ?? rectWidth(r)), y1: y0 + (a.depth ?? rectDepth(r)) }),
        fromLevel,
        toLevel,
        ...(a.doorSide ? { doorSide: a.doorSide } : {}),
        ...(a.persons ? { persons: a.persons } : {}),
        ...(a.name ? { name: a.name } : {}),
      });
      return;
    }

    case "RemoveCore": {
      draft.require("core", op.target);
      draft.remove("core", op.target);
      return;
    }

    case "AssignFlat": {
      for (const id of op.args.rooms) {
        const { flat: _old, ...room } = draft.requireRoom(id);
        draft.putRoom(op.args.flat === null ? room : { ...room, flat: op.args.flat });
      }
      return;
    }

    case "SetSetback": {
      const { side, distanceMm, purpose, note } = op.args;
      const setbacks = draft.project.plot.setbacks.filter((s) => s.side !== side);
      if (distanceMm !== null) setbacks.push({ side, distanceMm, purpose, ...(note ? { note } : {}) });
      draft.setPlot({ ...draft.project.plot, setbacks });
      return;
    }

    case "SetCompoundWall": {
      const { sides, heightMm } = op.args;
      const { compoundWall: old, ...plot } = draft.project.plot;
      draft.setPlot(sides.length ? { ...plot, compoundWall: { sides: [...new Set(sides)], heightMm: heightMm ?? old?.heightMm ?? 1800 } } : plot);
      return;
    }
  }
}

/** Re-assigns circuits and stacks after points change; only points whose circuit or stack actually changes are touched. */
function relinkMep(draft: Draft): void {
  const linked = linkStacks(draft.project, assignCircuits(draft.project, draft.project.mep));
  for (const p of linked) {
    const was = draft.project.mep.find((x) => x.id === p.id)!;
    if (was.circuit !== p.circuit || was.stack !== p.stack) draft.put("mep", p);
  }
}

/** Catalogue categories each surface accepts. */
const FINISH_FOR: Record<"floor" | "wall" | "ceiling", Category[]> = { floor: ["tile"], wall: ["paint", "wall-tile"], ceiling: ["ceiling", "paint"] };

/** Where offsets along a side are measured from: its west end (north/south sides) or south end (east/west sides). */
const alongStart = (r: Rect, side: Side) => (isHorizontal(side) ? r.x0 : r.y0);

/** Moves a room with its items and electrical/plumbing points; openings keep their offsets. */
function moveRoomBy(draft: Draft, room: Room, dx: number, dy: number): void {
  draft.putRoom({ ...room, boundary: rectToBoundary(translateRect(roomRect(room), dx, dy)) });
  for (const it of draft.project.items.filter((it) => it.room === room.id)) draft.put("item", { ...it, at: [it.at[0] + dx, it.at[1] + dy] });
  for (const pt of draft.project.mep.filter((pt) => pt.room === room.id)) draft.put("mep", { ...pt, at: [pt.at[0] + dx, pt.at[1] + dy] });
}

/** A room's or placed item's footprint. */
function elementRect(draft: Draft, id: string): Rect {
  const room = draft.room(id);
  if (room) return roomRect(room);
  const it = draft.project.items.find((i) => i.id === id);
  if (!it) throw new OpError(`There is no room or item "${id}".`, "element.missing");
  return itemRect(it, catalogueItem(it.catalogue)!);
}

function requireCatalogue(id: string): CatalogueItem {
  const cat = catalogueItem(id);
  if (!cat) throw new OpError(`"${id}" is not in the catalogue.`, "catalogue.missing");
  if (cat.category === "door" || cat.category === "window") throw new OpError(`"${id}" is a ${cat.category}; add it with AddOpening.`, "catalogue.not_placeable");
  if (FINISH_CATEGORIES.has(cat.category)) throw new OpError(`"${id}" is a finish; set it with SetFinish.`, "catalogue.not_placeable");
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
