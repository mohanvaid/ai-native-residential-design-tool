import { describe, expect, it } from "vitest";
import { carBays, drivePath, dryRun, newProject, validate, type OpInput, type Project } from "../src/index.js";

/** A 40 × 50 ft plot with a road on the north and an open parking area in front of the house. */
function site(extra: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "p", name: "P", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
    { op: "SetRoad", args: { side: "north", widthM: 9, name: "30 ft road" } },
    { op: "AddRoom", args: { id: "park", name: "Parking", type: "parking", level: "lv_gf", x: 500, y: 7000, width: 11000, depth: 7500 } },
    { op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 500, y: 500, width: 6000, depth: 6500 } },
    { op: "AddOpening", args: { type: "door", room: "liv", side: "north", offset: 600, width: 1050 } },
    { op: "AddOpening", args: { type: "window", room: "liv", side: "west", width: 1500 } },
    ...extra,
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const car = (id: string, x: number, y: number, facing = "south"): OpInput => ({ op: "PlaceItem", args: { id, catalogue: "car.sedan", room: "park", x, y, facing } }) as OpInput;
const codes = (p: Project) => validate(p).filter((f) => f.source === "parking").map((f) => f.code);

describe("car parking", () => {
  it("accepts a bay the car can be driven straight into from the road", () => {
    const p = site([car("c1", 3000, 10000)]);
    expect(carBays(p)).toHaveLength(1);
    expect(drivePath(p, carBays(p)[0]!)).toMatchObject({ ok: true, shape: "straight" });
    expect(codes(p)).not.toContain("parking.no_drive_path");
  });

  it("flags a bay with a tree in the way of the drive", () => {
    const blocked = site([car("c1", 3000, 10000), { op: "AddTree", args: { id: "tr", species: "Mango", x: 3000, y: 13500, rootRadius: 2400, keep: true } }]);
    const path = drivePath(blocked, carBays(blocked)[0]!);
    expect(path.ok).toBe(false);
    expect(path.blockedBy).toBe("the mango");
    const finding = validate(blocked).find((f) => f.code === "parking.no_drive_path")!;
    expect(finding.message).toContain("the mango is in the way");
    expect(finding.message).toContain("site engineer");
  });

  it("sees a second car blocking the first", () => {
    const two = site([car("c1", 3000, 9000), car("c2", 3000, 13000)]);
    expect(drivePath(two, carBays(two).find((b) => b.item.id === "c1")!)).toMatchObject({ ok: false, blockedBy: "another car" });
    expect(drivePath(two, carBays(two).find((b) => b.item.id === "c2")!).ok).toBe(true);
  });

  it("counts bays against the dwellings and notices cars with no parking area", () => {
    expect(codes(site())).toContain("parking.count");
    const flats = dryRun(site([car("c1", 3000, 10000)]), [
      { op: "AddRoom", args: { id: "b1", name: "Bedroom", type: "bedroom", level: "lv_gf", x: 6500, y: 500, width: 4000, depth: 3500 } },
      { op: "AddOpening", args: { type: "door", room: "b1", side: "west", offset: 600 } },
      { op: "AssignFlat", args: { rooms: ["liv"], flat: "F1" } },
      { op: "AssignFlat", args: { rooms: ["b1"], flat: "F2" } },
    ]).project;
    expect(codes(flats)).toContain("parking.count");
    const noRoom = dryRun(newProject({ id: "n", name: "N", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
      { op: "AddRoom", args: { id: "yard", name: "Yard", type: "other", level: "lv_gf", x: 500, y: 500, width: 8000, depth: 8000 } },
      { op: "PlaceItem", args: { id: "c", catalogue: "car.hatchback", room: "yard" } },
    ]).project;
    expect(codes(noRoom)).toEqual(["parking.no_room"]);
  });
});
