import { describe, expect, it } from "vitest";
import {
  catalogueItem,
  CATALOGUE,
  changeSummary,
  dryRun,
  floorPlanSheet,
  itemRect,
  ModelStore,
  newProject,
  validate,
  type OpInput,
  type Project,
} from "../src/index.js";

const room = (id: string, x: number, y: number, width: number, depth: number, type = "bedroom"): OpInput => ({
  op: "AddRoom",
  args: { id, name: id, type: type as never, level: "lv_gf", x, y, width, depth },
});

function base(ops: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), ops);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

/** A 4.2 × 3.6 m bedroom (centreline) with a door on its east side near the north end. */
const bedroom = [room("bed", 1000, 1000, 4200, 3600), { op: "AddOpening", args: { id: "d1", type: "door", room: "bed", side: "east", offset: 2400 } } as OpInput];

const codes = (p: Project) => validate(p).map((f) => f.code);

describe("catalogue", () => {
  it("has unique versioned ids and resolves bare ids to the latest version", () => {
    const ids = CATALOGUE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /@\d+$/.test(id))).toBe(true);
    expect(catalogueItem("bed.queen")?.id).toBe("bed.queen@1");
    expect(catalogueItem("bed.queen@9")).toBeUndefined();
  });

  it("sizes an opening from a catalogue door", () => {
    const p = base([room("a", 1000, 1000, 4000, 4000), { op: "AddOpening", args: { id: "d", type: "door", room: "a", side: "south", catalogue: "door.main-teak" } }]);
    expect(p.openings[0]).toMatchObject({ width: 1050, height: 2100, catalogue: "door.main-teak@1" });
  });
});

describe("placing items", () => {
  it("puts a bed's head against the wall it is given, centred, and stores the versioned id", () => {
    const p = base([...bedroom, { op: "PlaceItem", args: { id: "b", catalogue: "bed.queen", room: "bed", against: "west" } }]);
    const it = p.items[0]!;
    expect(it).toMatchObject({ catalogue: "bed.queen@1", facing: "east" });
    const r = itemRect(it, catalogueItem(it.catalogue)!);
    // West wall is external (230), so the clear face is at 1115
    expect(r.x0).toBe(1115);
    expect((r.y0 + r.y1) / 2).toBeCloseTo(2800, -1);
    expect(codes(p)).not.toContain("item.clearance");
  });

  it("finds a spot clear of the door swing when no wall is given", () => {
    const p = base([...bedroom, { op: "PlaceItem", args: { id: "w", catalogue: "wardrobe.3door", room: "bed" } }]);
    expect(codes(p).filter((c) => c.startsWith("door.") || c.startsWith("item."))).toEqual([]);
  });

  it("stands a dining table in the middle of the room", () => {
    const p = base([room("din", 1000, 1000, 4000, 3300, "dining"), { op: "PlaceItem", args: { catalogue: "dining.4", room: "din" } }]);
    expect(p.items[0]!.at).toEqual([3000, 2650]);
    expect(codes(p)).not.toContain("item.clearance");
  });

  it("refuses an item that cannot fit", () => {
    const r = dryRun(base([room("t", 1000, 1000, 1200, 1200, "toilet")]), [{ op: "PlaceItem", args: { catalogue: "bed.king", room: "t" } }]);
    expect(r.status).toBe("rejected");
    expect(r.error?.message).toMatch(/king bed .* does not fit in t/);
  });

  it("refuses doors and windows, which belong on walls", () => {
    const r = dryRun(base(bedroom), [{ op: "PlaceItem", args: { catalogue: "door.flush", room: "bed" } }]);
    expect(r.error?.message).toMatch(/AddOpening/);
  });

  it("swaps a queen for a king keeping the headboard on the wall", () => {
    const p = base([...bedroom, { op: "PlaceItem", args: { id: "b", catalogue: "bed.queen", room: "bed", against: "west" } }]);
    const swapped = dryRun(p, [{ op: "SwapItem", target: "b", args: { catalogue: "bed.king" } }]);
    const it = swapped.project.items[0]!;
    expect(itemRect(it, catalogueItem(it.catalogue)!).x0).toBe(1115);
    expect(changeSummary(p, swapped.project, swapped.changes, swapped.findings)).toMatch(/queen bed swapped for king bed/);
  });

  it("moves items with their room and removes them with it", () => {
    const store = new ModelStore(newProject({ id: "t", name: "t", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }));
    store.commit([...bedroom, { op: "PlaceItem", args: { id: "b", catalogue: "bed.double", room: "bed", against: "west" } }]);
    const before = store.current.items[0]!.at;
    store.commit([{ op: "MoveRoom", target: "bed", args: { dx: 500, dy: 0 } }]);
    expect(store.current.items[0]!.at).toEqual([before[0] + 500, before[1]]);
    store.commit([{ op: "RemoveRoom", target: "bed" }]);
    expect(store.current.items).toHaveLength(0);
  });
});

describe("checks", () => {
  it("blocks overlapping items and items outside the room", () => {
    const p = base(bedroom);
    const overlap = dryRun(p, [
      { op: "PlaceItem", args: { catalogue: "bed.queen", room: "bed", against: "west" } },
      { op: "PlaceItem", args: { catalogue: "desk.study", room: "bed", x: 2200, y: 2800, facing: "north" } },
    ]);
    expect(overlap.status).toBe("blocked");
    expect(overlap.findings.map((f) => f.code)).toContain("item.overlap");
    const out = dryRun(p, [{ op: "PlaceItem", args: { catalogue: "bed.queen", room: "bed", x: 900, y: 2800, facing: "east" } }]);
    expect(out.findings.map((f) => f.code)).toContain("item.outside_room");
  });

  it("warns when a door swing, a doorway or a clearance is blocked", () => {
    const p = base(bedroom);
    // The door is on the east wall at y 3400–4300 and swings into the room
    const inSwing = dryRun(p, [{ op: "PlaceItem", args: { catalogue: "wardrobe.2door", room: "bed", x: 4500, y: 3900, facing: "west" } }]);
    expect(inSwing.findings.map((f) => f.code)).toContain("door.swing_blocked");
    const tight = dryRun(p, [{ op: "PlaceItem", args: { catalogue: "bed.queen", room: "bed", against: "north", align: "start" } }]);
    expect(tight.findings.find((f) => f.code === "item.clearance")?.message).toMatch(/queen bed in bed has 0'0" clear at its (left|right) side; it needs 2'0"/);
  });

  it("warns when doors swing into each other and when a passage is narrow", () => {
    const p = base([
      room("a", 1000, 1000, 3000, 3000),
      room("c", 1000, 4000, 6000, 800, "passage"),
      room("d", 1000, 4800, 3000, 3000),
      // Opposite doors across an 800 mm passage, both opening into it
      { op: "AddOpening", args: { type: "door", room: "a", side: "north", offset: 1900, swing: { hinge: "end", into: "other" } } },
      { op: "AddOpening", args: { type: "door", room: "d", side: "south", offset: 1900, swing: { hinge: "end", into: "other" } } },
    ]);
    expect(codes(p)).toContain("door.swing_clash");
    expect(codes(p)).toContain("passage.narrow");
  });

  it("draws placed items on the plan", () => {
    const p = base([...bedroom, { op: "PlaceItem", args: { catalogue: "car.sedan", room: "bed", against: "west" } }]);
    expect(floorPlanSheet(p, "lv_gf").items.some((i) => i.kind === "text" && i.text === "SEDAN")).toBe(true);
  });
});
