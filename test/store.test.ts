import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareProjects, comparisonTables, comparisonText, Design, FileRepository, newProject, slugify, type OpInput } from "../src/index.js";

const room = (id: string, name: string, type: string, x: number, y: number, width: number, depth: number): OpInput => ({
  op: "AddRoom",
  args: { id, name, type: type as never, level: "lv_gf", x, y, width, depth },
});

function sample(): Design {
  const d = new Design("house", "House", newProject({ id: "h", name: "House", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }));
  d.store.commit([room("rm_bed", "Bedroom", "bedroom", 1000, 1000, 4000, 4000)], { label: "Bedroom" });
  d.store.commit([room("rm_liv", "Living", "living", 5000, 1000, 4000, 4000)], { label: "Living" });
  d.store.commit([{ op: "AddOpening", args: { type: "door", room: "rm_liv", side: "south" } }], { label: "Front door" });
  return d;
}

const tmp = () => mkdtempSync(join(tmpdir(), "designs-"));

describe("saved designs", () => {
  it("round-trips every version of every branch, with tags and undo", () => {
    const d = sample();
    d.tag("First sketch");
    d.createBranch("wide-living");
    d.store.commit([{ op: "ResizeRoom", target: "rm_liv", args: { edge: "east", delta: 1000 } }], { label: "Wider living" });
    d.switchTo("main");
    d.store.revert(1);
    const repo = new FileRepository(tmp());
    repo.save(d);
    const back = repo.load("house");
    expect(back.current).toBe("main");
    expect([...back.branches.keys()]).toEqual(["main", "wide-living"]);
    for (const name of back.branches.keys()) expect(back.branch(name).store.versions.map((v) => v.project)).toEqual(d.branch(name).store.versions.map((v) => v.project));
    expect(back.revisions().map((r) => [r.rev, r.label, r.tag])).toEqual([
      ["0", "Created", undefined],
      ["A", "Bedroom", undefined],
      ["B", "Living", undefined],
      ["C", "Front door", "First sketch"],
      ["D", "Revert to v1", undefined],
    ]);
    expect(back.branch("wide-living").from).toEqual({ branch: "main", version: 3 });
    // Undo still reverses the branch's own last edit after loading
    const undone = back.switchTo("wide-living").undo();
    expect(undone?.summary).toEqual(["Undo: Wider living"]);
    expect(back.store.current.rooms.find((r) => r.id === "rm_liv")!.boundary).toEqual(d.resolve("main@C").project.rooms.find((r) => r.id === "rm_liv")!.boundary);
  });

  it("stores change sets, with a snapshot only where they cannot rebuild a version", () => {
    const d = sample();
    d.store.revert(1);
    const json = d.toJSON();
    expect(json.branches.main!.history.map((e) => e.snapshot !== undefined)).toEqual([true, false, false, false, true]);
  });

  it("continues revision letters on a branch and checks branch names", () => {
    const d = sample();
    d.createBranch("option-b", { version: 2 });
    expect(d.revisions().map((r) => r.rev)).toEqual(["B"]);
    expect(d.revisions()[0]!.label).toBe("Branched from main Rev B");
    d.store.commit([room("rm_kit", "Kitchen", "kitchen", 9000, 1000, 2500, 3000)]);
    expect(d.revisions().at(-1)!.rev).toBe("C");
    expect(() => d.createBranch("Option B")).toThrow(/lower-case letters/);
    expect(() => d.createBranch("main")).toThrow(/already a branch/);
    expect(() => d.switchTo("nope")).toThrow(/no branch "nope"/);
  });

  it("finds designs by branch, revision or tag", () => {
    const d = sample();
    d.tag("Sent to engineer", 2);
    expect(d.resolve("main").version).toBe(3);
    expect(d.resolve("main@B").version).toBe(2);
    expect(d.resolve("@A").project.rooms).toHaveLength(1);
    expect(d.resolve("sent to engineer").version).toBe(2);
    expect(() => d.resolve("main@Z")).toThrow(/no Rev Z/);
  });

  it("gives new designs unused ids and lists them newest first", () => {
    const dir = tmp();
    const repo = new FileRepository(dir);
    const p = newProject({ id: "x", name: "x", plotWidthMm: 9000, plotDepthMm: 12000 });
    expect(slugify("Demo house, 30×40 East")).toBe("demo-house-30x40-east");
    const a = repo.create("Kumar residence", p);
    const b = repo.create("Kumar residence", p);
    expect([a.id, b.id]).toEqual(["kumar-residence", "kumar-residence-2"]);
    b.store.commit([room("rm", "Hall", "living", 1000, 1000, 3000, 3000)]);
    repo.save(b);
    expect(repo.list().map((l) => [l.id, l.rev])).toEqual([["kumar-residence-2", "A"], ["kumar-residence", "0"]]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(() => repo.load("../etc")).toThrow(/not a design id/);
  });
});

describe("compare", () => {
  it("lists what differs between two branches", () => {
    const d = sample();
    d.createBranch("option-b");
    d.store.commit([
      { op: "ResizeRoom", target: "rm_liv", args: { edge: "east", delta: 1000 } },
      room("rm_tlt", "Toilet", "toilet", 1000, 5000, 2000, 2000),
      { op: "SetFinish", args: { rooms: ["rm_bed"], catalogue: "tile.wood-laminate" } },
    ]);
    const c = compareProjects(d.resolve("main").project, d.store.current, { a: "main", b: "option-b" });
    expect(c.rooms.map((r) => [r.room, r.change])).toEqual([
      ["Bedroom", "refinished"],
      ["Living", "resized"],
      ["Toilet", "added"],
    ]);
    expect(c.metrics.find((m) => m.name === "Toilets")).toEqual({ name: "Toilets", a: "0", b: "1", change: "+1" });
    expect(c.metrics.find((m) => m.name === "Construction cost")!.change).toMatch(/^\+₹[\d.]+ lakh$/);
    const text = comparisonText(c);
    expect(text).toContain("- Bedroom (Ground) floor: Vitrified tile 600 × 600 → Wooden laminate 1200 × 200");
    expect(text).toContain("- Added Toilet on Ground");
    expect(comparisonTables(c)[1]!.rows[2]).toEqual(["Ground", "Toilet", "—", "5'10\" × 6'0\" (35 sq ft)", "added"]);
  });

  it("says when two designs are the same", () => {
    const d = sample();
    const p = d.store.current;
    expect(comparisonText(compareProjects(p, structuredClone(p), { a: "x", b: "y" }))).toBe("y and x are the same design.");
  });
});
