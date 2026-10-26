import { describe, expect, it } from "vitest";
import {
  boundaryToRect,
  deriveWalls,
  dryRun,
  ModelStore,
  newProject,
  opToolDefinitions,
  validate,
  type OpInput,
  type Project,
} from "../src/index.js";

const room = (id: string, x: number, y: number, width: number, depth: number, extra: Record<string, unknown> = {}): OpInput => ({
  op: "AddRoom",
  args: { id, name: id, type: "bedroom", level: "lv_gf", x, y, width, depth, ...extra },
});

/** 12 × 15 m plot, no jurisdiction rules, so only core checks run. */
function base(ops: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const rect = (p: Project, id: string) => boundaryToRect(p.rooms.find((r) => r.id === id)!.boundary);

describe("walls", () => {
  it("makes one internal wall where two rooms meet and external walls elsewhere", () => {
    const p = base([room("a", 1000, 1000, 3000, 3000), room("b", 4000, 1000, 3000, 3000)]);
    const walls = deriveWalls(p, "lv_gf");
    const shared = walls.filter((w) => !w.isExternal);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ orient: "v", at: 4000, from: 1000, to: 4000, thickness: 115, sourceRooms: ["a", "b"] });
    expect(walls.filter((w) => w.isExternal)).toHaveLength(6);
  });

  it("splits a wall where a shorter neighbour stops", () => {
    const p = base([room("a", 0, 0, 3000, 4000), room("b", 3000, 0, 3000, 2000)]);
    const onLine = deriveWalls(p, "lv_gf").filter((w) => w.orient === "v" && w.at === 3000);
    expect(onLine.map((w) => [w.from, w.to, w.isExternal])).toEqual([
      [0, 2000, false],
      [2000, 4000, true],
    ]);
  });
});

describe("ops and transactions", () => {
  it("rejects an invalid op and applies nothing from the transaction", () => {
    const p = base();
    const r = dryRun(p, [room("a", 0, 0, 3000, 3000), { op: "ResizeRoom", target: "nope", args: { edge: "east", delta: 100 } }]);
    expect(r.status).toBe("rejected");
    expect(r.error).toMatchObject({ opIndex: 1, code: "room.missing" });
    expect(r.project.rooms).toHaveLength(0);
  });

  it("rejects ops that fail schema validation", () => {
    const r = dryRun(base(), [{ op: "ResizeRoom", target: "a", args: { edge: "east" } } as OpInput]);
    expect(r.status).toBe("rejected");
    expect(r.error!.code).toBe("op.invalid");
  });

  it("resizes to a target area by moving one edge", () => {
    const p = base([room("a", 0, 0, 3000, 4000)]);
    const r = dryRun(p, [{ op: "ResizeRoom", target: "a", args: { edge: "east", targetArea: 15 } }]);
    expect(rect(r.project, "a")).toEqual({ x0: 0, y0: 0, x1: 3750, y1: 4000 });
  });

  it("with strategy fail, a resize into a neighbour is blocked by validation", () => {
    const p = base([room("a", 0, 0, 3000, 3000), room("b", 3000, 0, 3000, 3000)]);
    const r = dryRun(p, [{ op: "ResizeRoom", target: "a", args: { edge: "east", delta: 600 } }]);
    expect(r.status).toBe("blocked");
    expect(r.findings.some((f) => f.code === "room.overlap")).toBe(true);
  });

  it("shrink_neighbour takes the space from the room next door", () => {
    const p = base([room("a", 0, 0, 3000, 3000), room("b", 3000, 0, 3000, 3000)]);
    const r = dryRun(p, [{ op: "ResizeRoom", target: "a", args: { edge: "east", delta: 600, strategy: "shrink_neighbour" } }]);
    expect(r.status).toBe("committed");
    expect(rect(r.project, "a")!.x1).toBe(3600);
    expect(rect(r.project, "b")).toEqual({ x0: 3600, y0: 0, x1: 6000, y1: 3000 });
  });

  it("shrink_neighbour refuses to crush a neighbour", () => {
    const p = base([room("a", 0, 0, 3000, 3000), room("b", 3000, 0, 1000, 3000)]);
    const r = dryRun(p, [{ op: "ResizeRoom", target: "a", args: { edge: "east", delta: 600, strategy: "shrink_neighbour" } }]);
    expect(r.status).toBe("rejected");
    expect(r.error!.code).toBe("neighbour.too_small");
  });

  it("push_neighbours moves the chain of rooms in the way", () => {
    const p = base([room("a", 0, 0, 3000, 3000), room("b", 3000, 0, 3000, 3000), room("c", 6000, 1000, 2000, 2000), room("d", 0, 3000, 3000, 2000)]);
    const r = dryRun(p, [{ op: "ResizeRoom", target: "a", args: { edge: "east", delta: 500, strategy: "push_neighbours" } }]);
    expect(rect(r.project, "b")!.x0).toBe(3500);
    expect(rect(r.project, "c")!.x0).toBe(6500);
    expect(rect(r.project, "d")!.x0).toBe(0); // not in the way
    expect(r.findings.filter((f) => f.code === "room.overlap")).toHaveLength(0);
  });

  it("keeps openings at the same absolute position when the start edge moves", () => {
    const p = base([room("a", 1000, 1000, 3000, 3000), { op: "AddOpening", args: { id: "w", type: "window", room: "a", side: "south", offset: 900 } }]);
    const r = dryRun(p, [{ op: "ResizeRoom", target: "a", args: { edge: "west", delta: 500 } }]);
    expect(r.project.openings[0]!.offset).toBe(1400);
  });

  it("moving a room carries its openings and removing it removes them", () => {
    const p = base([room("a", 1000, 1000, 3000, 3000), { op: "AddOpening", args: { id: "d", type: "door", room: "a", side: "east" } }]);
    const moved = dryRun(p, [{ op: "MoveRoom", target: "a", args: { dx: 500 } }]).project;
    expect(moved.openings[0]!.offset).toBe(p.openings[0]!.offset);
    const removed = dryRun(p, [{ op: "RemoveRoom", target: "a" }]);
    expect(removed.project.openings).toHaveLength(0);
    expect(removed.changes.map((c) => `${c.kind}:${c.id}`).sort()).toEqual(["opening:d", "room:a"]);
  });

  it("restacks level elevations and will not remove a level that has rooms", () => {
    const p = base([{ op: "AddLevel", args: { id: "ff", name: "First", floorToFloor: 3200 } }, { op: "AddLevel", args: { id: "sf", name: "Second" } }]);
    expect(p.levels.map((l) => l.elevation)).toEqual([0, 3000, 6200]);
    const r = dryRun(p, [{ op: "SetLevelHeight", target: "lv_gf", args: { floorToFloor: 3300 } }]);
    expect(r.project.levels.map((l) => l.elevation)).toEqual([0, 3300, 6500]);
    const withRoom = base([room("a", 0, 0, 3000, 3000)]);
    expect(dryRun(withRoom, [{ op: "RemoveLevel", target: "lv_gf" }]).error!.code).toBe("level.last");
  });

  it("centres a new opening by default and resizes about its centre", () => {
    const p = base([room("a", 0, 0, 3000, 3000), { op: "AddOpening", args: { id: "w", type: "window", room: "a", side: "north", width: 1200 } }]);
    expect(p.openings[0]).toMatchObject({ offset: 900, width: 1200, height: 1200, sill: 900 });
    const r = dryRun(p, [{ op: "ResizeOpening", target: "w", args: { width: 1800 } }]);
    expect(r.project.openings[0]).toMatchObject({ offset: 600, width: 1800 });
  });

  it("tags rooms with their compass zone from true north", () => {
    const p = base([room("sw", 0, 0, 3000, 3000), room("ne", 9000, 12000, 3000, 3000)]);
    expect(p.rooms.map((r) => r.zoneTags[0])).toEqual(["SW", "NE"]);
    const rotated = dryRun(p, [{ op: "SetPlot", args: { widthMm: 12000, depthMm: 15000, northAngle: 90 } }]).project;
    // True north now points along plot +X: the plot's west edge faces true south, its south edge true east.
    expect(rotated.rooms.map((r) => r.zoneTags[0])).toEqual(["SE", "NW"]);
  });
});

describe("validation", () => {
  it("flags windows on internal walls, rooms without windows and openings past the wall end", () => {
    const p = base([
      room("a", 0, 0, 3000, 3000),
      room("b", 3000, 0, 3000, 3000),
      { op: "AddOpening", args: { id: "w", type: "window", room: "a", side: "east" } },
      { op: "AddOpening", args: { id: "x", type: "window", room: "b", side: "south", offset: 2500, width: 1000 } },
    ]);
    const codes = validate(p).map((f) => `${f.code}:${f.elements[0]}`);
    expect(codes).toContain("opening.window_internal:w");
    expect(codes).toContain("room.no_window:a");
    expect(codes).toContain("opening.out_of_wall:x");
  });
});

describe("blocking", () => {
  it("only blocks on problems the transaction introduces", () => {
    const overlapping = dryRun(base(), [room("a", 0, 0, 3000, 3000), room("b", 2000, 0, 3000, 3000)]);
    expect(overlapping.status).toBe("blocked");
    const rename = dryRun(overlapping.project, [{ op: "RenameRoom", target: "a", args: { name: "Hall" } }]);
    expect(rename.status).toBe("committed");
    expect(rename.findings.some((f) => f.code === "room.overlap")).toBe(true);
  });
});

describe("ModelStore", () => {
  it("commits, refuses blocked transactions unless accepted, and undoes", () => {
    const store = new ModelStore(base());
    store.commit([room("a", 0, 0, 3000, 3000)]);
    const before = structuredClone(store.current);
    store.commit([{ op: "ResizeRoom", target: "a", args: { edge: "north", delta: 1000 } }, { op: "RenameRoom", target: "a", args: { name: "Master" } }]);
    expect(store.current.rooms[0]!.name).toBe("Master");

    const blocked = store.commit([room("b", 1000, 1000, 3000, 3000)]);
    expect(blocked.status).toBe("blocked");
    expect(store.current.rooms).toHaveLength(1);

    const undo = store.undo()!;
    expect(undo.status).toBe("committed");
    expect(store.current.rooms).toEqual(before.rooms);
    expect(store.current.version).toBe(before.version + 2);
  });
});

describe("tool definitions", () => {
  it("exposes every op as a JSON-schema tool", () => {
    const tools = opToolDefinitions();
    expect(tools.map((t) => t.name)).toContain("ResizeRoom");
    expect(tools).toHaveLength(29);
    expect(JSON.stringify(tools.find((t) => t.name === "AddRoom")!.input_schema)).toContain("depth");
  });
});
