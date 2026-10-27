import { describe, expect, it } from "vitest";
import { areaStatement, computeBoq, dryRun, flatCosts, newProject, renderFloorPlanSvg, validate, type OpInput, type Project } from "../src/index.js";
import { REF_BUILDING, REF_PARKING, REF_SITE, REF_STRUCTURE, referenceFlats, referencePlot } from "../src/templates/reference-project.js";

function commit(p: Project, ops: OpInput[]): Project {
  const r = dryRun(p, ops);
  if (r.status !== "committed") throw new Error(`${r.status}: ${r.error?.message ?? r.findings.filter((f) => f.severity === "block").map((f) => f.message).join("; ")}`);
  return r.project;
}

function reference(): Project {
  let p = referencePlot();
  for (const ops of [REF_SITE, REF_BUILDING]) p = commit(p, ops);
  p = commit(p, referenceFlats(p));
  for (const ops of [REF_PARKING, REF_STRUCTURE]) p = commit(p, ops);
  return p;
}

describe("reference project (stilt + 3, 62'6\" × 52')", () => {
  const p = reference();
  const findings = validate(p);

  it("builds with no blocking findings and passes the TN height and FSI rules", () => {
    expect(findings.filter((f) => f.severity === "block")).toEqual([]);
    expect(findings.some((f) => f.code === "tn.fsi.ok")).toBe(true);
    expect(p.levels.map((l) => l.kind)).toEqual(["stilt", "floor", "floor", "floor", "terrace"]);
  });

  it("keeps the trees, the 12 ft access passage and a lift on every floor", () => {
    expect(p.trees.filter((t) => t.keep).map((t) => t.species)).toEqual(["Mango", "Neem"]);
    expect(findings.some((f) => f.code === "setback.owner" || f.code === "tree.root_zone")).toBe(false);
    expect(findings.filter((f) => f.code.startsWith("lift.") || f.code === "door.swing_lift_lobby")).toEqual([]);
  });

  it("states areas per flat with the common area shared out, and costs per flat add up", () => {
    const st = areaStatement(p);
    expect(st.flats.map((f) => [f.flat, f.bedrooms])).toEqual([
      ["F1", 3],
      ["F2", 3],
      ["F3", 3],
    ]);
    expect(st.commonSqm).toBeGreaterThan(50);
    for (const f of st.flats) expect(f.superBuiltUpSqm).toBeCloseTo(f.builtUpSqm + f.commonShareSqm);
    const boq = computeBoq(p);
    expect(boq.lines.some((l) => l.code === "LF-01" && l.qty === 4)).toBe(true);
    expect(boq.lines.some((l) => l.code === "CW-01")).toBe(true);
    const costs = flatCosts(p, boq, st);
    expect(Math.abs(costs.reduce((s, c) => s + c.amount, 0) - boq.total)).toBeLessThan(5);
  });

  it("draws the lift, the access passage and the compound wall", () => {
    const svg = renderFloorPlanSvg(p, "lv_l1");
    expect(svg).toContain("ACCESS PASSAGE");
    expect(svg).toContain("THE LIFT");
  });
});

describe("cores, flats and owner setbacks", () => {
  const base = () =>
    commit(newProject({ id: "c", name: "c", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
      { op: "AddLevel", args: { id: "lv_ff", name: "First" } },
      { op: "AddRoom", args: { id: "lob", name: "Lobby", type: "lobby", level: "lv_gf", x: 2000, y: 2000, width: 3000, depth: 3000 } },
      { op: "AddRoom", args: { id: "bed", name: "Bedroom", type: "bedroom", level: "lv_ff", x: 2000, y: 2000, width: 3000, depth: 3000 } },
    ]);

  it("warns when a lift is too small, opens into a bedroom, or misses a floor", () => {
    const p = commit(base(), [{ op: "AddCore", args: { id: "lift", kind: "lift", x: 5000, y: 2000, width: 1500, depth: 1800, toLevel: "lv_gf", doorSide: "west", persons: 6 } }]);
    const codes = validate(p).map((f) => f.code);
    expect(codes).toContain("lift.small");
    expect(codes).toContain("lift.not_all_floors");
    const up = commit(p, [{ op: "UpdateCore", target: "lift", args: { toLevel: "lv_ff" } }]);
    expect(validate(up).find((f) => f.code === "lift.landing_room")?.elements).toEqual(["lift", "bed"]);
  });

  it("blocks a core through a room", () => {
    const r = dryRun(base(), [{ op: "AddCore", args: { kind: "duct", x: 2500, y: 2500, width: 600, depth: 600, toLevel: "lv_ff" } }]);
    expect(r.status).toBe("blocked");
    expect(r.findings.some((f) => f.code === "core.room_overlap")).toBe(true);
  });

  it("blocks building into an owner's access passage", () => {
    const r = dryRun(base(), [{ op: "SetSetback", args: { side: "north", distanceMm: 11000, purpose: "access" } }]);
    expect(r.status).toBe("blocked");
    expect(r.findings.find((f) => f.code === "setback.owner")?.message).toContain("access passage");
  });

  it("treats everything as one house until rooms are assigned to flats", () => {
    const p = base();
    expect(areaStatement(p).singleHome).toBe(true);
    const flats = commit(p, [{ op: "AssignFlat", args: { rooms: ["bed"], flat: "A" } }]);
    const st = areaStatement(flats);
    expect(st.flats.map((f) => f.flat)).toEqual(["A"]);
    expect(st.commonSqm).toBeGreaterThan(9);
  });
});
