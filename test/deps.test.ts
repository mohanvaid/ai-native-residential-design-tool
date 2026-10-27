import { describe, expect, it } from "vitest";
import { affectedOutputs, allOutputs, dryRun, newProject, OutputCache, type OpInput, type Project } from "../src/index.js";

function two(): Project {
  const r = dryRun(newProject({ id: "d", name: "d", plotWidthMm: 15000, plotDepthMm: 18000, jurisdiction: "NONE" }), [
    { op: "AddLevel", args: { id: "lv_ff", name: "First" } },
    { op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 1000, y: 1000, width: 4500, depth: 4000 } },
    { op: "AddRoom", args: { id: "kit", name: "Kitchen", type: "kitchen", level: "lv_gf", x: 5500, y: 1000, width: 3000, depth: 2400 } },
    { op: "AddRoom", args: { id: "bed", name: "Bedroom", type: "bedroom", level: "lv_ff", x: 1000, y: 1000, width: 3600, depth: 4000 } },
    { op: "AddOpening", args: { type: "door", room: "liv", side: "south", offset: 600, width: 1050 } },
    { op: "AddOpening", args: { type: "door", room: "kit", side: "south", offset: 600 } },
    { op: "AddOpening", args: { type: "door", room: "bed", side: "south", offset: 600 } },
    { op: "AutoPlaceMep", args: {} },
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const edit = (p: Project, ops: OpInput[]) => {
  const r = dryRun(p, ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r;
};

describe("dependency graph", () => {
  const p = two();

  it("maps an edit to the outputs it can change and leaves the rest alone", () => {
    const r = edit(p, [{ op: "RenameRoom", target: "bed", args: { name: "Master" } }]);
    const a = affectedOutputs(p, r.project, r.changes);
    expect(a).toContain("plan:lv_ff");
    expect(a).not.toContain("plan:lv_gf");
    expect(a).toContain("checks");

    const point = edit(p, [{ op: "AddMepPoint", args: { kind: "socket-6a", room: "bed", x: 2000, y: 2000 } }]);
    const b = affectedOutputs(p, point.project, point.changes);
    expect([...b].sort()).toEqual(["boq", "checks", "elec:lv_ff", "schedule:circuits", "schedule:electrical", "schedule:plumbing"]);

    const plot = edit(p, [{ op: "SetPlot", args: { widthMm: 16000, depthMm: 18000 } }]);
    expect(affectedOutputs(p, plot.project, plot.changes).size).toBe(allOutputs(plot.project).length);
  });

  it("re-renders only the affected outputs, and a resize of one room stays well under 500 ms", () => {
    const cache = new OutputCache(p);
    const groundPlan = cache.get("plan:lv_gf");
    const elevation = cache.get("elevation:north");

    // A rename touches the plans of its own level and the room schedules, nothing else
    const renamed = edit(p, [{ op: "RenameRoom", target: "bed", args: { name: "Master" } }]);
    const first = cache.update(renamed.project, renamed.changes);
    expect(first.regenerated).toContain("plan:lv_ff");
    expect(first.regenerated).not.toContain("plan:lv_gf");
    expect(first.reused).toBeGreaterThan(first.regenerated.length);
    expect(cache.get("plan:lv_gf")).toBe(groundPlan);
    expect(cache.get("elevation:north")).toBe(elevation);

    // A resize changes the shape, so the elevations and 3D go too, and it is still fast
    const resized = edit(renamed.project, [{ op: "ResizeRoom", target: "bed", args: { edge: "north", delta: 300 } }]);
    const second = cache.update(resized.project, resized.changes);
    expect(second.regenerated).toContain("elevation:north");
    expect(second.regenerated).not.toContain("plan:lv_gf");
    expect(second.ms).toBeLessThan(500);
  });

  it("drops the outputs of a level that is removed", () => {
    const r = edit(p, [{ op: "RemoveRoom", target: "bed" }, { op: "RemoveLevel", target: "lv_ff" }]);
    const cache = new OutputCache(p);
    cache.update(r.project, r.changes);
    expect(cache.keys()).not.toContain("plan:lv_ff");
  });
});
