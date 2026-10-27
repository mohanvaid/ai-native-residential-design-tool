import { describe, expect, it } from "vitest";
import { boundaryToRect, computeBoq, dryRun, finishesTable, newProject, type OpInput, type Project } from "../src/index.js";

function base(ops: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "e", name: "e", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}
const room = (id: string, x: number, y: number, width: number, depth: number, type = "bedroom"): OpInput => ({ op: "AddRoom", args: { id, name: id, type, level: "lv_gf", x, y, width, depth } }) as OpInput;
const rect = (p: Project, id: string) => boundaryToRect(p.rooms.find((r) => r.id === id)!.boundary);
const run = (p: Project, ops: OpInput[]) => {
  const r = dryRun(p, ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
};

describe("merge and split", () => {
  it("merges two rooms into one, dropping the door between them and keeping the outer window", () => {
    const p = base([
      room("a", 1000, 1000, 3000, 3000),
      room("b", 4000, 1000, 3000, 3000),
      { op: "AddOpening", args: { id: "d", type: "door", room: "a", side: "east" } },
      { op: "AddOpening", args: { id: "w", type: "window", room: "b", side: "south", offset: 500 } },
      { op: "PlaceItem", args: { id: "bed", catalogue: "bed.queen", room: "b" } },
    ]);
    const m = run(p, [{ op: "MergeRooms", args: { rooms: ["a", "b"], name: "Master" } }]);
    expect(m.rooms.map((r) => r.id)).toEqual(["a"]);
    expect(rect(m, "a")).toEqual({ x0: 1000, y0: 1000, x1: 7000, y1: 4000 });
    expect(m.openings.map((o) => [o.id, o.host.room, o.offset])).toEqual([["w", "a", 3500]]);
    expect(m.items[0]!.room).toBe("a");
  });

  it("refuses to merge rooms that do not make a rectangle", () => {
    const r = dryRun(base([room("a", 0, 0, 3000, 3000), room("b", 3000, 0, 3000, 2000)]), [{ op: "MergeRooms", args: { rooms: ["a", "b"] } }]);
    expect(r.error?.code).toBe("merge.not_rectangle");
  });

  it("splits a room with a door in the new wall and moves openings to the part they are in", () => {
    const p = base([room("a", 1000, 1000, 6000, 3000), { op: "AddOpening", args: { id: "w1", type: "window", room: "a", side: "south", offset: 4000 } }, { op: "AddOpening", args: { id: "w2", type: "window", room: "a", side: "east" } }]);
    const s = run(p, [{ op: "SplitRoom", target: "a", args: { direction: "east-west", at: 3500, id: "b", name: "Study", type: "study" } }]);
    expect(rect(s, "a")).toEqual({ x0: 1000, y0: 1000, x1: 4500, y1: 4000 });
    expect(rect(s, "b")).toEqual({ x0: 4500, y0: 1000, x1: 7000, y1: 4000 });
    expect(s.openings.find((o) => o.id === "w1")!.host).toEqual({ room: "b", side: "south" });
    expect(s.openings.find((o) => o.id === "w1")!.offset).toBe(500);
    expect(s.openings.find((o) => o.id === "w2")!.host.room).toBe("b");
    expect(s.openings.some((o) => o.type === "door" && o.host.room === "a" && o.host.side === "east")).toBe(true);
  });
});

describe("align", () => {
  it("lines up a room's north wall with another's and carries its contents", () => {
    const p = base([room("a", 0, 0, 3000, 3000), room("b", 4000, 500, 3000, 3000), { op: "PlaceItem", args: { id: "bed", catalogue: "bed.double", room: "b" } }]);
    const at = p.items[0]!.at;
    const q = run(p, [{ op: "AlignElements", args: { targets: ["b"], to: "a", edge: "north" } }]);
    expect(rect(q, "b")!.y1).toBe(3000);
    expect(q.items[0]!.at).toEqual([at[0], at[1] - 500]);
  });
});

describe("finishes and themes", () => {
  it("sets wall and ceiling finishes, checks the category, and prices them", () => {
    const p = base([room("a", 0, 0, 4000, 4000)]);
    expect(dryRun(p, [{ op: "SetFinish", args: { rooms: ["a"], surface: "wall", catalogue: "tile.vitrified-600" } }]).error?.code).toBe("catalogue.missing");
    const q = run(p, [
      { op: "SetFinish", args: { rooms: ["a"], surface: "wall", catalogue: "paint.premium-sage" } },
      { op: "SetFinish", args: { rooms: ["a"], surface: "ceiling", catalogue: "ceiling.gypsum" } },
    ]);
    expect(q.rooms[0]!.finishes).toMatchObject({ wall: "paint.premium-sage@1", ceiling: "ceiling.gypsum@1" });
    const codes = computeBoq(q).lines.map((l) => l.code);
    expect(codes).toContain("paint.premium-sage@1");
    expect(codes).toContain("ceiling.gypsum@1");
  });

  it("applies an interior theme to every room by type", () => {
    const p = base([room("a", 0, 0, 4000, 4000), room("t", 4000, 0, 1500, 2000, "toilet"), room("l", 0, 4000, 5000, 4000, "living")]);
    const q = run(p, [{ op: "ApplyTheme", args: { theme: "warm-contemporary" } }]);
    expect(q.prefs.interiorTheme).toBe("warm-contemporary");
    const f = Object.fromEntries(q.rooms.map((r) => [r.id, r.finishes]));
    expect(f.a!.floor).toBe("tile.wood-laminate@1");
    expect(f.t!.wall).toBe("walltile.glazed-300x450@1");
    expect(f.l!.ceiling).toBe("ceiling.gypsum@1");
    expect(finishesTable(q).rows.find((r) => r[1] === "l")![4]).toContain("Gypsum");
    expect(dryRun(p, [{ op: "ApplyTheme", args: { theme: "nope" } }]).error?.code).toBe("theme.missing");
  });
});
