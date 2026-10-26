import { describe, expect, it } from "vitest";
import {
  boundaryToRect,
  dryRun,
  ModelStore,
  newProject,
  Project,
  renderFloorPlanPdf,
  renderViewerHtml,
  siteplanSheet,
  stairLayout,
  structuralGrid,
  unionOutline,
  validate,
  type OpInput,
} from "../src/index.js";

const room = (id: string, x: number, y: number, width: number, depth: number, level = "lv_gf", type = "bedroom"): OpInput => ({
  op: "AddRoom",
  args: { id, name: id, type: type as never, level, x, y, width, depth },
});

/** 12 × 15 m plot. Core checks only unless a jurisdiction is given. */
function base(ops: OpInput[] = [], jurisdiction: "NONE" | "IN-TN-CMDA" = "NONE"): Project {
  const r = dryRun(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction }), ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const codes = (p: Project) => validate(p).map((f) => f.code);

describe("trees", () => {
  it("fills canopy and root zone from the species", () => {
    const p = base([{ op: "AddTree", args: { id: "t1", species: "Mango", x: 2000, y: 12000 } }]);
    expect(p.trees[0]).toMatchObject({ canopyRadius: 4500, rootRadius: 3000, keep: true });
  });

  it("blocks building in the root zone of a kept tree, and lets it go once the tree is marked for removal", () => {
    const p = base([{ op: "AddTree", args: { id: "t1", species: "Neem", x: 2000, y: 9000, rootRadius: 2000 } }]);
    const r = dryRun(p, [room("a", 1000, 3000, 3000, 4500)]);
    expect(r.status).toBe("blocked");
    expect(r.findings.find((f) => f.code === "tree.root_zone")?.message).toMatch(/0\.6\d m inside the root zone of the neem tree/);
    const removed = dryRun(p, [{ op: "UpdateTree", target: "t1", args: { keep: false } }, room("a", 1000, 3000, 3000, 4500)]);
    expect(removed.status).toBe("committed");
  });

  it("warns when an upper floor reaches into the canopy", () => {
    const p = base([
      { op: "AddTree", args: { id: "t1", species: "Coconut", x: 6000, y: 9000, rootRadius: 1000, canopyRadius: 3500 } },
      room("a", 1000, 1000, 4000, 4000),
      { op: "AddLevel", args: { id: "lv_ff", name: "First" } },
      room("b", 1000, 1000, 4000, 6000, "lv_ff"),
    ]);
    expect(codes(p)).toContain("tree.canopy");
  });
});

describe("columns", () => {
  const twoRooms = [room("a", 1000, 1000, 3000, 4000), room("b", 4000, 1000, 6000, 4000)];

  it("places a column at every wall corner and junction, splitting long runs", () => {
    const p = base([...twoRooms, { op: "PlaceColumns", args: {} }]);
    const at = p.columns.map((c) => c.at.join(","));
    for (const corner of ["1000,1000", "4000,1000", "10000,1000", "1000,5000", "4000,5000", "10000,5000"]) expect(at).toContain(corner);
    // The 6 m walls of room b get a column at mid-span (limit 4.5 m)
    expect(at).toContain("7000,1000");
    expect(at).toContain("7000,5000");
    expect(p.columns).toHaveLength(8);
    expect(codes(p)).not.toContain("beam.span");
    expect(structuralGrid(p).x.map((g) => g.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("flags long spans and unsupported upper walls, and stops columns under open terraces", () => {
    const p = base([...twoRooms, { op: "AddLevel", args: { id: "lv_ff", name: "First" } }, room("c", 1000, 1000, 3000, 4000, "lv_ff")]);
    const ok = dryRun(p, [{ op: "PlaceColumns", args: {} }]).project;
    expect(ok.columns.find((c) => c.at.join() === "10000,1000")?.toLevel).toBe("lv_gf");
    expect(ok.columns.find((c) => c.at.join() === "1000,1000")?.toLevel).toBe("lv_ff");

    const sparse = dryRun(p, [
      { op: "AddColumn", args: { x: 1000, y: 1000, fromLevel: "lv_gf" } },
      { op: "AddColumn", args: { x: 10000, y: 1000, fromLevel: "lv_gf", toLevel: "lv_gf" } },
    ]).project;
    expect(codes(sparse)).toContain("beam.span");

    const floating = dryRun(p, [{ op: "AddColumn", args: { x: 2500, y: 1000, fromLevel: "lv_ff" } }]).project;
    expect(codes(floating)).toContain("column.floating");

    const overhang = base([...twoRooms, { op: "AddLevel", args: { id: "lv_ff", name: "First" } }, room("c", 1000, 1000, 3000, 5000, "lv_ff")]);
    expect(validate(overhang).find((f) => f.code === "wall.unsupported")?.message).toMatch(/3\.00 m wall of c on First/);
  });

  it("warns about a column standing free in a room", () => {
    const p = base([...twoRooms, { op: "AddColumn", args: { x: 7000, y: 3000, fromLevel: "lv_gf" } }]);
    expect(codes(p)).toContain("column.free_standing");
  });
});

describe("stairs", () => {
  const house = [
    room("liv", 1000, 1000, 5000, 5000, "lv_gf", "living"),
    { op: "AddLevel", args: { id: "lv_ff", name: "First" } } as OpInput,
    room("lob", 1000, 1000, 5000, 5000, "lv_ff", "passage"),
  ];

  it("sizes a dog-leg well from the floor height: 16 risers of 187.5 mm, 2.65 × 1.8 m", () => {
    const p = base([...house, { op: "AddStair", args: { id: "st", fromLevel: "lv_gf", x: 1200, y: 1200, up: "north" } }]);
    const r = boundaryToRect(p.stairs[0]!.boundary)!;
    expect([r.x1 - r.x0, r.y1 - r.y0]).toEqual([1800, 2650]);
    const lay = stairLayout(p, p.stairs[0]!)!;
    expect(lay.risers).toBe(16);
    expect(lay.riserHeight).toBe(187.5);
    expect(lay.flights.map((f) => f.risers)).toEqual([8, 8]);
    expect(lay.flights[0]!.nosings).toHaveLength(8);
    expect(lay.flights[1]!.nosings).toHaveLength(7);
    expect(codes(p)).not.toContain("stair.too_small");
    expect(codes(p)).not.toContain("stair.missing");
  });

  it("blocks a well that is too short, and warns when an upper level has no stair", () => {
    const p = base([...house, { op: "AddStair", args: { id: "st", fromLevel: "lv_gf", x: 1200, y: 1200, up: "north" } }]);
    const r = dryRun(p, [{ op: "UpdateStair", target: "st", args: { depth: 2000 } }]);
    expect(r.status).toBe("blocked");
    expect(r.findings.find((f) => f.code === "stair.too_small")?.message).toMatch(/needs 8'8" \(2\.65 m\)/);
    expect(codes(base(house))).toContain("stair.missing");
  });

  it("refuses a stair with nothing above it", () => {
    const r = dryRun(base([room("liv", 1000, 1000, 5000, 5000)]), [{ op: "AddStair", args: { fromLevel: "lv_gf", x: 1200, y: 1200, up: "north" } }]);
    expect(r.status).toBe("rejected");
    expect(r.error?.message).toMatch(/no level above/);
  });

  it("checks TNCDBR r.52(17): risers, treads and width", () => {
    const tn = (args: Record<string, unknown>) =>
      dryRun(base([{ op: "SetRoad", args: { side: "south", widthM: 9 } }, ...house], "IN-TN-CMDA"), [
        { op: "AddStair", args: { id: "st", fromLevel: "lv_gf", x: 1200, y: 1200, up: "north", ...args } },
      ]);
    expect(tn({}).findings.filter((f) => f.code.startsWith("tn.stair") && f.severity === "block")).toEqual([]);
    expect(tn({ risers: 14 }).findings.map((f) => f.code)).toContain("tn.stair.riser");
    expect(tn({ tread: 230 }).findings.map((f) => f.code)).toContain("tn.stair.tread");
    expect(tn({ flightWidth: 700 }).findings.map((f) => f.code)).toContain("tn.stair.width");
  });

  it("allows an open stair in the setback per r.28(a)(iii) only clear of the boundary", () => {
    const p = base([{ op: "SetRoad", args: { side: "south", widthM: 9 } }, ...house], "IN-TN-CMDA");
    const add = (x: number) => dryRun(p, [{ op: "AddStair", args: { id: "st", fromLevel: "lv_gf", x, y: 7000, up: "north", shape: "straight", external: true, risers: 15 } }]);
    // East of the house, 1.0 m inside the side boundary: fine
    expect(add(10100).findings.map((f) => f.code)).not.toContain("tn.stair.setback_gap");
    // 0.2 m from the east boundary: too close
    expect(add(10900).findings.find((f) => f.code === "tn.stair.setback_gap")?.message).toMatch(/0\.20 m from the east boundary/);
  });
});

describe("levels, undo and outputs", () => {
  it("removing a level takes its stair with it and trims columns", () => {
    const store = new ModelStore(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }));
    store.commit([room("a", 1000, 1000, 5000, 5000, "lv_gf", "living"), { op: "AddLevel", args: { id: "lv_ff", name: "First" } }]);
    store.commit([{ op: "AddStair", args: { fromLevel: "lv_gf", x: 1200, y: 1200, up: "north" } }, { op: "AddColumn", args: { x: 1000, y: 1000, fromLevel: "lv_gf", toLevel: "lv_ff" } }]);
    const r = store.commit([{ op: "RemoveLevel", target: "lv_ff" }]);
    expect(r.status).toBe("committed");
    expect(store.current.stairs).toHaveLength(0);
    expect(store.current.columns[0]).toMatchObject({ fromLevel: "lv_gf", toLevel: "lv_gf" });
    store.undo();
    expect(store.current.stairs).toHaveLength(1);
    expect(store.current.columns[0]!.toLevel).toBe("lv_ff");
  });

  it("reads models saved before trees, columns and stairs existed", () => {
    const old = JSON.parse(JSON.stringify(newProject({ id: "t", name: "t", plotWidthMm: 9000, plotDepthMm: 12000 })));
    delete old.trees;
    delete old.columns;
    delete old.stairs;
    expect(Project.parse(old)).toMatchObject({ trees: [], columns: [], stairs: [] });
  });

  it("draws a site plan and puts it first in the PDF and viewer", () => {
    const p = base([
      { op: "AddTree", args: { species: "Mango", x: 9000, y: 12000 } },
      room("a", 1000, 1000, 4000, 4000),
      { op: "PlaceColumns", args: {} },
    ]);
    const sheet = siteplanSheet(p);
    expect(sheet.title).toContain("Site plan");
    expect(sheet.items.some((i) => i.kind === "text" && i.text === "MANGO")).toBe(true);
    expect(sheet.items.some((i) => i.kind === "text" && i.text === "AREA STATEMENT")).toBe(true);
    expect(Buffer.from(renderFloorPlanPdf(p)).toString("latin1").match(/\/Type \/Page\b/g)).toHaveLength(2);
    expect(renderViewerHtml(p, { includePdf: false })).toContain(">Site</button>");
  });

  it("outlines a union of rectangles without internal edges", () => {
    const segs = unionOutline([
      { x0: 0, y0: 0, x1: 10, y1: 10 },
      { x0: 10, y0: 0, x1: 20, y1: 10 },
    ]);
    const len = segs.reduce((s, [a, b]) => s + Math.hypot(b[0] - a[0], b[1] - a[1]), 0);
    expect(len).toBe(60);
  });
});
