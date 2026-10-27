import { describe, expect, it } from "vitest";
import { describeOutput, Design, dryRun, ModelStore, newProject, resolveReference, validate, type OpInput, type Project } from "../src/index.js";

function flatBuilding(): Project {
  const r = dryRun(newProject({ id: "a", name: "A block", plotWidthMm: 15000, plotDepthMm: 18000, jurisdiction: "NONE" }), [
    { op: "AddLevel", args: { id: "lv_ff", name: "First" } },
    { op: "AddRoom", args: { id: "mbr", name: "Master bedroom", type: "bedroom", level: "lv_gf", x: 1000, y: 1000, width: 4200, depth: 4000 } },
    { op: "AddRoom", args: { id: "bed2", name: "Bedroom 2", type: "bedroom", level: "lv_gf", x: 5200, y: 1000, width: 3300, depth: 4000 } },
    { op: "AddRoom", args: { id: "kit", name: "Kitchen", type: "kitchen", level: "lv_gf", x: 1000, y: 5000, width: 3000, depth: 2700 } },
    { op: "AddRoom", args: { id: "kit2", name: "Kitchen", type: "kitchen", level: "lv_ff", x: 1000, y: 5000, width: 3000, depth: 2700 } },
    { op: "AddOpening", args: { id: "kw", type: "window", room: "kit", side: "west", width: 1200 } },
    { op: "AddOpening", args: { id: "md", type: "door", room: "mbr", side: "south", offset: 600 } },
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

describe("resolve_reference", () => {
  const p = flatBuilding();

  it("turns what the user called something into ids, best first, with the near misses", () => {
    expect(resolveReference(p, "the master bedroom")[0]).toMatchObject({ id: "mbr", kind: "room" });
    expect(resolveReference(p, "the kitchen window")[0]!.id).toBe("kw");
    const kitchens = resolveReference(p, "the kitchen", "room");
    expect(kitchens.map((r) => r.id).sort()).toEqual(["kit", "kit2"]);
    expect(kitchens[0]!.why).toContain("kitchen");
    expect(resolveReference(p, "the lift")).toEqual([]);
  });

  it("understands the words Chennai clients use", () => {
    expect(resolveReference(p, "pooja room")).toEqual([]);
    const hall = dryRun(p, [{ op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 5200, y: 5000, width: 4000, depth: 4000 } }] as OpInput[]).project;
    expect(resolveReference(hall, "the hall")[0]!.id).toBe("liv");
    // Only the word "door" matches, which the tool reports as a weak candidate rather than acting on
    const weak = resolveReference(hall, "the bathroom door");
    expect(weak[0]).toMatchObject({ id: "md", kind: "opening" });
    expect(weak[0]!.score).toBeLessThan(0.6);
  });
});

describe("generate", () => {
  const p = flatBuilding();

  it("reports what each output holds and names the levels when one is wrong", () => {
    expect(describeOutput(p, "plan", "lv_gf")).toContain("Master bedroom");
    expect(describeOutput(p, "drawings")).toContain("sheets:");
    expect(describeOutput(p, "estimate")).toContain("per sq ft");
    expect(describeOutput(p, "schedules")).toContain("Door and window schedule");
    expect(describeOutput(p, "3d")).toContain("solids");
    expect(() => describeOutput(p, "plan", "lv_zz")).toThrow(/Levels: lv_gf/);
    expect(() => describeOutput(p, "nope")).toThrow(/no output/);
  });
});

describe("rule profile and version history", () => {
  it("switches jurisdiction and Vastu, and the checks follow", () => {
    const p = flatBuilding();
    expect(validate(p).some((f) => f.code.startsWith("tn."))).toBe(false);
    const r = dryRun(p, [{ op: "SetRuleProfile", args: { jurisdiction: "IN-TN-CMDA", vastu: "prefer" } }]);
    expect(r.project.jurisdiction).toBe("IN-TN-CMDA");
    expect(r.findings.some((f) => f.code.startsWith("tn."))).toBe(true);
    expect(r.findings.some((f) => f.source === "vastu")).toBe(true);
    expect(dryRun(p, [{ op: "SetRuleProfile", args: { ruleSets: ["nope"] } }]).error?.code).toBe("rulepack.unknown");
  });

  it("records who made a revision and what they assumed", () => {
    const store = new ModelStore(flatBuilding());
    store.commit([{ op: "RenameRoom", target: "bed2", args: { name: "Guest bedroom" } }], { label: "rename it", author: "claude", assumptions: ["the user meant the second bedroom"] });
    const design = new Design("d", "D", flatBuilding());
    design.store.commit([{ op: "RenameRoom", target: "bed2", args: { name: "Guest" } }], { label: "rename", author: "claude", assumptions: ["bare numbers are feet"] });
    const rev = design.revisions().at(-1)!;
    expect(rev).toMatchObject({ author: "claude", assumptions: ["bare numbers are feet"] });
    const back = Design.fromJSON(JSON.parse(JSON.stringify(design.toJSON())));
    expect(back.revisions().at(-1)).toMatchObject({ author: "claude", assumptions: ["bare numbers are feet"] });
  });
});
