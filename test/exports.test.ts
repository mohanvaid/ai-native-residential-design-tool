import { describe, expect, it } from "vitest";
import { boqTable, detailSpecs, detailSheet, doorWindowTable, dryRun, floorPlanSheet, newProject, overlaySheet, sheetToDxf, sheetToPng, sheetToSvg, tablesToXlsx, type OpInput, type Project } from "../src/index.js";

function house(extra: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "x", name: "X house", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
    { op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 1000, y: 1000, width: 4500, depth: 4000 } },
    { op: "AddRoom", args: { id: "kit", name: "Kitchen", type: "kitchen", level: "lv_gf", x: 5500, y: 1000, width: 3000, depth: 2700 } },
    { op: "AddOpening", args: { type: "door", room: "liv", side: "south", offset: 600, width: 1050 } },
    { op: "AddOpening", args: { type: "window", room: "liv", side: "west", width: 1500 } },
    { op: "AddOpening", args: { type: "door", room: "kit", side: "west", offset: 600 } },
    ...extra,
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

describe("exports", () => {
  const p = house();
  const sheet = floorPlanSheet(p, "lv_gf");

  it("writes a DXF with layers, ASCII text and the same entities as the SVG", () => {
    const dxf = sheetToDxf(sheet);
    expect(dxf.startsWith("0\nSECTION")).toBe(true);
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    expect(dxf).toContain("AC1009");
    expect(dxf).toContain("\nWALLS\n");
    expect(dxf).toContain("LIVING");
    // R12 is single byte, so the typographic characters in labels are transliterated
    expect(dxf).not.toMatch(/[^\x00-\x7f]/);
    const texts = sheet.items.filter((i) => i.kind === "text").length;
    expect(dxf.split("0\nTEXT\n").length - 1).toBe(texts);
  });

  it("writes an xlsx with one sheet per table and numbers as numbers", () => {
    const bytes = tablesToXlsx([boqTable(p), doorWindowTable(p)]);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("xl/worksheets/sheet2.xml");
    expect(text).toContain("Door and window schedule");
    expect(text).toMatch(/<c r="A1" t="inlineStr" s="1">/);
    expect(text).toMatch(/<v>\d/);
  });

  it("renders a PNG preview of a sheet", () => {
    const png = sheetToPng(sheet, { width: 400 });
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(400);
    expect(view.getUint32(20)).toBe(Math.round((400 / sheet.width) * sheet.height));
    expect(png.length).toBeGreaterThan(1000);
  });
});

describe("compare overlay", () => {
  it("marks added, removed and resized rooms against the earlier design", () => {
    const a = house();
    const b = dryRun(a, [
      { op: "ResizeRoom", target: "liv", args: { edge: "north", delta: 600 } },
      { op: "RemoveRoom", target: "kit" },
      { op: "AddRoom", args: { id: "study", name: "Study", type: "study", level: "lv_gf", x: 6000, y: 6000, width: 2400, depth: 2400 } },
    ]).project;
    const svg = sheetToSvg(overlaySheet(a, b, { labels: { a: "Rev A", b: "Rev B" } }));
    expect(svg).toContain("removed");
    expect(svg).toContain("STUDY");
    expect(svg).toContain("was ");
    expect(svg).toContain("added in Rev B");
  });
});

describe("detail elevations", () => {
  const p = house([
    { op: "AddRoom", args: { id: "bed", name: "Bedroom", type: "bedroom", level: "lv_gf", x: 1000, y: 5500, width: 3600, depth: 3600 } },
    { op: "AddOpening", args: { type: "door", room: "bed", side: "east", offset: 600 } },
    { op: "PlaceItem", args: { id: "w", catalogue: "wardrobe.sliding", room: "bed", against: "north" } },
    { op: "PlaceItem", args: { id: "s", catalogue: "module.sink-900", room: "kit", against: "north" } },
    { op: "AutoPlaceMep", args: {} },
  ]);

  it("finds the kitchen counter and the wardrobe wall, and draws them to size at 1:25", () => {
    const specs = detailSpecs(p);
    expect(specs.map((s) => `${s.room}/${s.kind}`)).toEqual(expect.arrayContaining(["kit/kitchen", "bed/wardrobe"]));
    const kitchen = detailSheet(p, specs.find((s) => s.kind === "kitchen")!);
    expect(kitchen.scale).toBe(25);
    expect(kitchen.title).toContain("Kitchen elevation");
    const svg = sheetToSvg(kitchen);
    expect(svg).toContain("COUNTER 850 AFF");
    expect(svg).toContain("DADO TILE");
    const wardrobe = sheetToSvg(detailSheet(p, specs.find((s) => s.kind === "wardrobe")!));
    expect(wardrobe).toContain("SLIDING WARDROBE");
    expect(wardrobe).toContain("LOFT");
  });
});
