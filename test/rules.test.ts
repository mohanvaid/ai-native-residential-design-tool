import { describe, expect, it } from "vitest";
import { dryRun, newProject, renderFloorPlanSvg, tncdbr2019, validate, type OpInput, type Project } from "../src/index.js";

/** A 30 ft (9144) frontage on the east, 40 ft (12192) deep, CMDA. */
function plot(roadM: number | null, ops: OpInput[] = []): Project {
  const p = newProject({ id: "t", name: "t", plotWidthMm: 12192, plotDepthMm: 9144 });
  const road: OpInput[] = roadM === null ? [] : [{ op: "SetRoad", args: { side: "east", widthM: roadM } }];
  const r = dryRun(p, [...road, ...ops]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const house = (x0: number, x1: number, y0: number, y1: number, level = "lv_gf"): OpInput => ({
  op: "AddRoom",
  args: { name: `R${level}`, type: "living", level, x: x0, y: y0, width: x1 - x0, depth: y1 - y0 },
});
const env = (p: Project) => tncdbr2019.derive(p);
const req = (p: Project, side: string) => env(p).setbacks.find((s) => s.side === side)!;

describe("TNCDBR 2019 envelope", () => {
  it("picks the front setback from the road width band (r.35(1)(a) E(i))", () => {
    expect(req(plot(9.0), "east").requiredMm).toBe(1500);
    expect(req(plot(9.14), "east").requiredMm).toBe(3000);
    expect(req(plot(24), "east").requiredMm).toBe(4500);
    expect(req(plot(40), "east").requiredMm).toBe(6000);
  });

  it("assigns rear to the side opposite the road and side setbacks by plot width and height", () => {
    const p = plot(9.14, [house(600, 9000, 1200, 8700)]);
    expect(req(p, "west")).toMatchObject({ role: "rear", requiredMm: 0 });
    // 9.14 m frontage, 3 m high: 1 m on one side.
    expect(req(p, "north")).toMatchObject({ role: "side", requiredMm: 1000, applies: "one_of_sides" });

    const g2 = plot(9.14, [
      { op: "AddLevel", args: { id: "ff", name: "First" } },
      { op: "AddLevel", args: { id: "sf", name: "Second" } },
    ]);
    // 9 m high: 1.5 m on one side, and a 1.5 m rear setback once above 7 m.
    expect(req(g2, "north")).toMatchObject({ requiredMm: 1500, applies: "one_of_sides" });
    expect(req(g2, "west").requiredMm).toBe(1500);
  });

  it("blocks a building inside the front setback and passes one that respects it", () => {
    const ok = plot(9.14, [house(600, 9000, 1200, 8700)]);
    expect(validate(ok).filter((f) => f.severity === "block")).toEqual([]);
    const tooClose = plot(9.14, [house(600, 9500, 1200, 8700)]);
    expect(validate(tooClose).find((f) => f.code === "tn.setback.front")?.message).toMatch(/needs 3.00 m/);
  });

  it("needs at least one side setback, not both", () => {
    const neither = plot(9.14, [house(600, 9000, 500, 8700)]);
    expect(validate(neither).some((f) => f.code === "tn.setback.side")).toBe(true);
  });

  it("limits height and storeys by road width", () => {
    // GF+2 at 3.2 m floor to floor: 9.6 m and three storeys, on a road that allows GF+1 / 9 m.
    const narrow = plot(5, [
      { op: "SetLevelHeight", target: "lv_gf", args: { floorToFloor: 3200 } },
      { op: "AddLevel", args: { id: "ff", name: "First", floorToFloor: 3200 } },
      { op: "AddLevel", args: { id: "sf", name: "Second", floorToFloor: 3200 } },
    ]);
    const codes = validate(narrow).map((f) => f.code);
    expect(codes).toContain("tn.height.exceeded");
    expect(codes).toContain("tn.storeys.exceeded");
    expect(codes).toContain("tn.height.confirm"); // the 3–6 m column is flagged uncertain
    const wide = plot(9.14, [
      { op: "AddLevel", args: { id: "ff", name: "First" } },
      { op: "AddLevel", args: { id: "sf", name: "Second" } },
      { op: "AddLevel", args: { id: "tr", name: "Terrace", kind: "terrace" } },
    ]);
    expect(validate(wide).map((f) => f.code)).not.toContain("tn.height.exceeded");
  });

  it("counts FSI on all floors, allows premium FSI by road width and blocks beyond it", () => {
    const levels: OpInput[] = [
      { op: "AddLevel", args: { id: "ff", name: "First" } },
      { op: "AddLevel", args: { id: "sf", name: "Second" } },
    ];
    // ~79 m² footprint per floor on a 111.5 m² plot: 3 floors ≈ FSI 2.1.
    const big = [...levels, house(0, 9000, 0, 8700), house(0, 9000, 0, 8700, "ff"), house(0, 9000, 0, 8700, "sf")];
    expect(validate(plot(9.14, big)).find((f) => f.code.startsWith("tn.fsi"))?.code).toBe("tn.fsi.premium");
    expect(validate(plot(6, big)).find((f) => f.code.startsWith("tn.fsi"))?.code).toBe("tn.fsi.exceeded");
  });

  it("leaves open stilt parking and the terrace stair room out of FSI", () => {
    const p = plot(9.14, [
      { op: "AddLevel", args: { id: "tr", name: "Terrace", kind: "terrace" } },
      house(600, 9000, 1200, 8700),
      { op: "AddRoom", args: { name: "Stair room", type: "staircase", level: "tr", x: 600, y: 1200, width: 2400, depth: 3600 } },
    ]);
    const fsi = validate(p).find((f) => f.code === "tn.fsi.ok")!;
    expect(fsi.message).toMatch(/FSI used 0\.6\d of 2\.00/);
  });

  it("asks for the road when none is set, and flags uncertain CBA values", () => {
    expect(validate(plot(null, [house(600, 9000, 1200, 8700)])).map((f) => f.code)).toContain("tn.road.missing");
    const cba = dryRun(plot(9.14), [{ op: "SetPlot", args: { widthMm: 12192, depthMm: 9144 } }]).project;
    cba.plot.areaClass = "CBA";
    expect(validate(cba).map((f) => f.code)).toContain("tn.road.confirm");
  });
});

describe("floor plan", () => {
  it("draws rooms, openings, marks and the setback line at 1:100", () => {
    const p = plot(9.14, [
      house(600, 9000, 1200, 8700),
      { op: "AddOpening", args: { type: "door", room: "rm_1", side: "east" } },
      { op: "AddOpening", args: { type: "window", room: "rm_1", side: "south" } },
    ]);
    const svg = renderFloorPlanSvg(p, "lv_gf");
    expect(svg).toMatch(/^<svg[^>]+width="\d+(\.\d+)?mm"/);
    expect(svg).toContain("RLV_GF");
    expect(svg).toContain(">D1<");
    expect(svg).toContain(">W1<");
    expect(svg).toContain("Front 3.08 m (req. 3.00 m)");
    expect(svg).toContain("Scale 1:100");
  });
});
