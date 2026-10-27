import { describe, expect, it } from "vitest";
import { dryRun, ModelStore, newProject, siteplanSheet, validate, vastuReport, zoneOfPoint, trueFacing, type OpInput, type Project } from "../src/index.js";

const room = (id: string, type: string, x: number, y: number, width: number, depth: number, level = "lv_gf"): OpInput => ({
  op: "AddRoom",
  args: { id, name: id, type: type as never, level, x, y, width, depth },
});

/** 12 m (W–E) × 15 m (S–N) plot, true north up unless rotated. */
function base(ops: OpInput[] = [], northAngle = 0): Project {
  const r = dryRun(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE", northAngle }), ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const codes = (p: Project) => validate(p).map((f) => f.code);

describe("wet stacking", () => {
  const ground = [room("bed", "bedroom", 1000, 1000, 4000, 4000), room("tlt", "toilet", 5000, 1000, 2000, 2000), room("kit", "kitchen", 5000, 3000, 2000, 2000)];
  const first = { op: "AddLevel", args: { id: "lv_ff", name: "First" } } as OpInput;

  it("is happy when the upper toilet sits over the lower one", () => {
    const p = base([...ground, first, room("tlt2", "toilet", 5000, 1000, 2000, 2000, "lv_ff"), room("bed2", "bedroom", 1000, 1000, 4000, 4000, "lv_ff")]);
    expect(codes(p).filter((c) => c.startsWith("wet."))).toEqual([]);
  });

  it("warns about a toilet over a bedroom or kitchen", () => {
    const p = base([...ground, first, room("tlt2", "toilet", 2000, 2000, 2000, 2000, "lv_ff")]);
    expect(validate(p).find((f) => f.code === "wet.toilet_above")?.message).toBe("tlt2 on First sits over bed on Ground; pipes would run through that ceiling.");
  });

  it("warns about a wet room that is not over a wet room", () => {
    const p = base([...ground, room("liv", "living", 7000, 1000, 4000, 4000), first, room("kit2", "kitchen", 7000, 1000, 3000, 3000, "lv_ff")]);
    expect(codes(p)).toContain("wet.not_stacked");
  });

  it("warns about a toilet with no outside wall", () => {
    const p = base([room("a", "bedroom", 1000, 1000, 6000, 6000), room("b", "bedroom", 1000, 7000, 6000, 3000), room("t", "toilet", 7000, 4000, 2000, 2000), room("c", "living", 7000, 1000, 3000, 3000), room("d", "dining", 7000, 6000, 3000, 4000), room("e", "store", 9000, 4000, 1000, 2000)]);
    expect(validate(p).find((f) => f.code === "wet.no_outside_wall")?.elements).toEqual(["t"]);
  });
});

describe("vastu", () => {
  it("finds zones from true north, including on a rotated plot", () => {
    const p = base();
    expect(zoneOfPoint(p, [11000, 14000])).toBe("NE");
    expect(zoneOfPoint(p, [6000, 7500])).toBe("C");
    expect(zoneOfPoint(p, [1000, 1000])).toBe("SW");
    // True north is plot +Y turned 90° clockwise, so the plot's east side faces true north
    const r = base([], 90);
    expect(trueFacing(90).east).toBe("N");
    expect(zoneOfPoint(r, [11000, 7500])).toBe("N");
    expect(zoneOfPoint(r, [1000, 7500])).toBe("S");
  });

  it("is off by default and never blocks", () => {
    const p = base([room("k", "kitchen", 8000, 11000, 3000, 3000)]);
    expect(codes(p).some((c) => c.startsWith("vastu."))).toBe(false);
    const on = dryRun(p, [{ op: "SetPreferences", args: { vastu: "strict" } }]);
    expect(on.status).toBe("committed");
    const f = on.findings.find((x) => x.code === "vastu.kitchen")!;
    expect(f.severity).toBe("warn");
    expect(f.message).toBe("Vastu: k is in the NE; preferred SE, acceptable NW/E/S.");
  });

  it("scores entrance, kitchen, master bedroom, pooja, toilets and stair", () => {
    const p = base([
      { op: "SetPreferences", args: { vastu: "prefer" } },
      room("bed", "bedroom", 1000, 1000, 3500, 4000),
      room("k", "kitchen", 8500, 1000, 3000, 3000),
      room("pj", "puja", 8500, 11000, 2500, 2500),
      room("t", "toilet", 1000, 7000, 2000, 2000),
      room("liv", "living", 4500, 1000, 4000, 4000),
      { op: "AddOpening", args: { type: "door", room: "liv", side: "south", width: 1050 } },
    ]);
    const rep = vastuReport(p);
    expect(rep.items.map((i) => [i.key, i.zone, i.grade])).toEqual([
      ["entrance", "S", "avoid"],
      ["kitchen", "SE", "best"],
      ["master", "SW", "best"],
      ["puja", "NE", "best"],
      ["toilet", "W", "best"],
    ]);
    expect(rep.score).toBe(8);
    expect(rep.max).toBe(10);
    expect(validate(p).find((f) => f.code === "vastu.entrance")?.severity).toBe("info");
  });

  it("flags rooms that fill the open centre and draws the zones on the site plan", () => {
    const p = base([{ op: "SetPreferences", args: { vastu: "prefer" } }, room("t", "toilet", 5000, 6500, 2000, 2000)]);
    expect(codes(p)).toContain("vastu.centre");
    expect(siteplanSheet(p).items.some((i) => i.kind === "text" && i.text === "SW")).toBe(true);
  });

  it("undoes a preference change", () => {
    const store = new ModelStore(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000 }));
    store.commit([{ op: "SetPreferences", args: { vastu: "prefer" } }]);
    expect(store.current.prefs.vastu).toBe("prefer");
    store.undo();
    expect(store.current.prefs.vastu).toBe("off");
  });
});
