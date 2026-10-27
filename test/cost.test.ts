import { describe, expect, it } from "vitest";
import { boqTable, changeSummary, computeBoq, costDelta, drawingSet, dryRun, formatInr, newProject, tableToCsv, validate, type OpInput, type Project } from "../src/index.js";

/** A 12 × 15 m plot with one 4 × 3 m room (wall centrelines) on the ground floor. */
function base(ops: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
    { op: "AddRoom", args: { id: "rm", name: "Room", type: "bedroom", level: "lv_gf", x: 2000, y: 2000, width: 4000, depth: 3000 } },
    ...ops,
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const line = (p: Project, code: string) => computeBoq(p).lines.find((l) => l.code === code);

describe("quantity takeoff", () => {
  it("is empty for an empty plot", () => {
    const p = newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000 });
    expect(computeBoq(p).lines).toEqual([]);
    expect(computeBoq(p).total).toBe(0);
  });

  it("measures walls, slab and finishes from the geometry", () => {
    const p = base();
    // 14 m of 230 mm wall, 3000 − 150 slab − 300 beam = 2.55 m high
    expect(line(p, "BW-01")!.qty).toBeCloseTo(14 * 2.55 * 0.23, 2);
    expect(line(p, "BW-01")!.sources).toEqual(["rm"]);
    // Slab over the outer face: 4.23 × 3.23 × 0.15
    expect(line(p, "RC-04")!.qty).toBeCloseTo(4.23 * 3.23 * 0.15, 2);
    expect(line(p, "EL-01")!.qty).toBe(10);
    expect(line(p, "WP-01")!.qty).toBeCloseTo(4.23 * 3.23, 2);
    expect(line(p, "tile.vitrified-600@1")!.qty).toBeCloseTo(3.77 * 2.77, 2);
  });

  it("cuts openings out of the wall and prices the window", () => {
    const before = line(base(), "BW-01")!.qty;
    const p = base([{ op: "AddOpening", args: { type: "window", room: "rm", side: "south", width: 1200, height: 1200 } }]);
    expect(line(p, "BW-01")!.qty).toBeCloseTo(before - 1.2 * 1.2 * 0.23, 2);
    expect(line(p, "JN-02")!.qty).toBeCloseTo(1.44, 2);
  });

  it("assumes columns when none are placed, and keeps furniture out of the construction total", () => {
    const p = base([{ op: "PlaceItem", args: { room: "rm", catalogue: "bed.queen" } }]);
    const boq = computeBoq(p);
    expect(boq.assumptions[0]).toMatch(/^No columns placed yet, so 4 columns/);
    expect(boq.furniture.map((f) => f.name)).toEqual(["Queen bed"]);
    expect(boq.furnitureTotal).toBe(43500);
    expect(boq.total).toBe(boq.subtotal + boq.margin + boq.contingency);
    expect(boq.margin).toBe(Math.round(boq.subtotal * 0.1));
  });
});

describe("rates and money", () => {
  it("formats lakh and crore", () => {
    expect(formatInr(2_960_000)).toBe("₹29.6 lakh");
    expect(formatInr(12_500_000)).toBe("₹1.25 crore");
    expect(formatInr(45_000)).toBe("₹45,000");
    expect(formatInr(-88_250)).toBe("−₹88,250");
    expect(formatInr(150_000, "Rs ")).toBe("Rs 1.5 lakh");
  });

  it("overrides a rate per project, and resets it", () => {
    const p = base([{ op: "SetRate", args: { code: "BW-01", rate: 9000 } }]);
    const bw = line(p, "BW-01")!;
    expect(bw.rate).toBe(9000);
    expect(bw.overridden).toBe(true);
    expect(bw.amount).toBe(Math.round(bw.qty * 9000));
    const reset = dryRun(p, [{ op: "SetRate", args: { code: "BW-01", rate: null } }]).project;
    expect(line(reset, "BW-01")!.rate).toBe(7600);
    expect(dryRun(p, [{ op: "SetRate", args: { code: "XX-99", rate: 5 } }]).error?.code).toBe("rate.unknown");
  });

  it("warns when the estimate passes the budget", () => {
    const p = base([{ op: "SetPreferences", args: { budgetInr: 500_000 } }]);
    const f = validate(p).find((x) => x.code === "cost.over_budget")!;
    expect(f.severity).toBe("warn");
    expect(f.message).toMatch(/^Estimated construction cost ₹[\d.]+ lakh is over the ₹5.0 lakh budget by/);
  });
});

describe("cost delta", () => {
  it("reports what an edit did to the estimate, line by line", () => {
    const p = base();
    const r = dryRun(p, [{ op: "AddRoom", args: { id: "rm2", name: "Study", type: "study", level: "lv_gf", x: 6000, y: 2000, width: 3000, depth: 3000 } }]);
    const d = costDelta(p, r.project);
    expect(d.delta).toBeGreaterThan(100_000);
    expect(d.delta).toBe(d.after - d.before);
    expect(d.lines.find((l) => l.code === "EL-01")?.delta).toBe(8 * 1700);
    expect(changeSummary(p, r.project, r.changes, r.findings)).toMatch(/; cost \+₹[\d.]+ lakh to ₹[\d.]+ lakh · /);
  });

  it("starts the summary with an estimate", () => {
    const empty = newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" });
    const r = dryRun(empty, [{ op: "AddRoom", args: { name: "Room", type: "bedroom", level: "lv_gf", x: 2000, y: 2000, width: 4000, depth: 3000 } }]);
    expect(changeSummary(empty, r.project, r.changes, r.findings)).toMatch(/; estimate ₹[\d.]+ lakh · /);
  });
});

describe("cost outputs", () => {
  it("puts the BOQ in the drawing set and a CSV with plain numbers", () => {
    const p = base();
    const t = boqTable(p);
    expect(t.rows.at(-1)![1]).toMatch(/^Construction total \(\d[\d,]* per sq ft built-up\)$/);
    const csv = tableToCsv(t);
    expect(csv).toMatch(/\r\nBW-01,Brickwork 230 mm in CM 1:6,\d+\.\d+,cu m,7600,\d+\r\n/);
    const sheets = drawingSet(p).filter((d) => d.tab.startsWith("Schedules"));
    expect(sheets.some((d) => d.sheet.items.some((i) => i.kind === "text" && i.text.startsWith("COST ESTIMATE")))).toBe(true);
  });
});
