import { describe, expect, it } from "vitest";
import { computeBoq, drawingSet, dryRun, electricalTable, newProject, plumbingTable, renderFloorPlanSvg, validate, type OpInput, type Project } from "../src/index.js";

function house(ops: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "m", name: "m", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
    { op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 1000, y: 1000, width: 4500, depth: 4000 } },
    { op: "AddRoom", args: { id: "bed", name: "Bedroom", type: "bedroom", level: "lv_gf", x: 5500, y: 1000, width: 3600, depth: 4000 } },
    { op: "AddRoom", args: { id: "tlt", name: "Toilet", type: "toilet", level: "lv_gf", x: 5500, y: 5000, width: 1800, depth: 2400 } },
    { op: "AddRoom", args: { id: "kit", name: "Kitchen", type: "kitchen", level: "lv_gf", x: 1000, y: 5000, width: 3000, depth: 2400 } },
    { op: "AddOpening", args: { type: "door", room: "liv", side: "south", offset: 600, width: 1050 } },
    { op: "AddOpening", args: { type: "door", room: "bed", side: "west", offset: 600 } },
    { op: "AddOpening", args: { type: "door", room: "tlt", side: "south", offset: 300, width: 750 } },
    { op: "AddOpening", args: { type: "door", room: "kit", side: "south", offset: 600 } },
    ...ops,
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const auto = (p: Project) => {
  const r = dryRun(p, [{ op: "AutoPlaceMep", args: {} }]);
  if (r.status !== "committed") throw new Error(r.status);
  return r.project;
};

describe("electrical and plumbing points", () => {
  const p = auto(house());
  const kinds = (room: string) => p.mep.filter((x) => x.room === room).map((x) => x.kind);

  it("lays out points by room type with circuits, stacks and a distribution board", () => {
    expect(kinds("bed")).toEqual(expect.arrayContaining(["light", "fan", "switchboard", "socket-6a", "ac", "tv"]));
    expect(kinds("tlt")).toEqual(expect.arrayContaining(["wc-outlet", "floor-trap", "water-cold", "water-hot", "geyser", "exhaust", "stack"]));
    expect(p.mep.filter((x) => x.kind === "db")).toHaveLength(1);
    for (const ac of p.mep.filter((x) => x.kind === "ac")) expect(ac.circuit).toMatch(/ P\d+$/);
    const stack = p.mep.find((x) => x.room === "tlt" && x.kind === "stack")!;
    expect(p.mep.find((x) => x.room === "tlt" && x.kind === "wc-outlet")!.stack).toBe(stack.id);
    expect(validate(p).filter((f) => f.source === "mep")).toEqual([]);
  });

  it("puts schedules, layout sheets and priced points in the outputs", () => {
    expect(electricalTable(p).rows.at(-1)![2]).not.toBe("0");
    expect(plumbingTable(p).rows.length).toBeGreaterThan(2);
    expect(renderFloorPlanSvg(p, "lv_gf", { layer: "electrical" })).toContain("electrical layout");
    expect(drawingSet(p).map((d) => d.tab)).toEqual(expect.arrayContaining(["Ground elec.", "Ground plumb."]));
    const codes = computeBoq(p).lines.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(["EL-03", "EL-04", "PB-04", "PB-05"]));
    expect(codes).not.toContain("EL-01");
  });

  it("re-running keeps hand-placed points, and points move with their room", () => {
    const hand = dryRun(p, [{ op: "AddMepPoint", args: { id: "x", kind: "socket-6a", room: "liv", x: 2000, y: 1200 } }]).project;
    const again = auto(hand);
    expect(again.mep.some((x) => x.id === "x")).toBe(true);
    expect(again.mep.filter((x) => x.kind === "db")).toHaveLength(1);
    const moved = dryRun(again, [{ op: "MoveRoom", target: "liv", args: { dx: 0, dy: -200 } }]).project;
    expect(moved.mep.find((x) => x.id === "x")!.at).toEqual([2000, 1000]);
  });

  it("flags a socket low beside water, and a WC with no stack", () => {
    const wc = p.mep.find((x) => x.room === "tlt" && x.kind === "wc-outlet")!;
    const r = dryRun(p, [
      { op: "AddMepPoint", args: { id: "s", kind: "socket-6a", room: "tlt", x: wc.at[0] + 200, y: wc.at[1], heightMm: 300 } },
      ...p.mep.filter((x) => x.kind === "stack").map((x): OpInput => ({ op: "RemoveMepPoint", target: x.id })),
    ]);
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("mep.socket_wet_zone");
    expect(codes).toContain("mep.no_stack");
  });
});
