import { describe, expect, it } from "vitest";
import {
  buildScene,
  doorWindowTable,
  drawingSet,
  dryRun,
  elevationSheet,
  flooringRows,
  flooringTable,
  newProject,
  renderDrawingSetPdf,
  renderViewer3dHtml,
  sceneToGlb,
  scheduleSheets,
  sectionSheet,
  tableToCsv,
  type OpInput,
  type Project,
} from "../src/index.js";

const room = (id: string, type: string, x: number, y: number, width: number, depth: number, level = "lv_gf"): OpInput => ({
  op: "AddRoom",
  args: { id, name: id, type: type as never, level, x, y, width, depth },
});

function house(extra: OpInput[] = []): Project {
  const r = dryRun(newProject({ id: "t", name: "Test house", plotWidthMm: 12000, plotDepthMm: 15000 }), [
    { op: "SetRoad", args: { side: "south", widthM: 9 } },
    room("liv", "living", 1500, 3000, 5000, 4000),
    room("bed", "bedroom", 6500, 3000, 4000, 4000),
    room("tlt", "toilet", 6500, 7000, 2000, 2000),
    { op: "AddOpening", args: { id: "d1", type: "door", room: "liv", side: "south", width: 1050 } },
    { op: "AddOpening", args: { id: "w1", type: "window", room: "bed", side: "south" } },
    { op: "AddOpening", args: { id: "d2", type: "door", room: "bed", side: "west" } },
    { op: "AddOpening", args: { id: "d3", type: "door", room: "tlt", side: "south", width: 750 } },
    { op: "AddLevel", args: { id: "lv_ff", name: "First" } },
    room("bed2", "bedroom", 1500, 3000, 5000, 4000, "lv_ff"),
    { op: "AddStair", args: { fromLevel: "lv_gf", x: 1700, y: 3200, up: "east" } },
    ...extra,
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const texts = (items: { kind: string }[]) => items.filter((i): i is { kind: "text"; text: string } => i.kind === "text").map((i) => i.text);

describe("elevations and section", () => {
  it("names elevations by true direction and marks the road side", () => {
    const s = elevationSheet(house(), "south");
    expect(s.title).toContain("South elevation (road side)");
    expect(texts(s.items)).toContain("First +3.00 m");
    // Door d1 is drawn: a door-coloured rect 1050 wide
    expect(s.items.some((i) => i.kind === "rect" && i.w === 1050 && i.fill === "#7b4a26")).toBe(true);
  });

  it("follows the colour theme", () => {
    const modern = house([{ op: "SetPreferences", args: { theme: "modern" } }]);
    expect(elevationSheet(modern, "south").items.some((i) => i.kind === "rect" && i.fill === "#f4f4f2")).toBe(true);
  });

  it("cuts the section through the stair", () => {
    const s = sectionSheet(house());
    expect(texts(s.items).some((t) => t.startsWith("SECTION A–A (y ="))).toBe(true);
    expect(s.items.some((i) => i.kind === "poly" && i.fill === "#7a7a7a")).toBe(true);
  });

  it("puts every sheet in one PDF: site, floors, 4 elevations, section, schedules", () => {
    const p = house();
    const set = drawingSet(p);
    expect(set.map((d) => d.tab).slice(0, 8)).toEqual(["Site", "Ground", "First", "South elev.", "North elev.", "East elev.", "West elev.", "Section"]);
    const pdf = Buffer.from(renderDrawingSetPdf(p)).toString("latin1");
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(set.length);
  });
});

describe("schedules", () => {
  it("counts doors and windows per floor", () => {
    const t = doorWindowTable(house());
    expect(t.head).toEqual(["Mark", "Type", "Width", "Height", "Sill", "Product", "Ground", "First", "Total"]);
    expect(t.rows.find((r) => r[0] === "D1")).toEqual(["D1", "door", "1050 mm", "2100 mm", "0 mm", "—", "1", "0", "1"]);
  });

  it("works out tiles, wastage and skirting per room", () => {
    const p = house([{ op: "SetFinish", args: { rooms: ["bed"], catalogue: "tile.vitrified-800" } }]);
    const rows = flooringRows(p);
    const bed = rows.find((r) => r.room === "bed")!;
    expect(bed.finish).toBe("Vitrified tile 800 × 800");
    expect(bed.wastage).toBe(0.12);
    expect(bed.tiles).toBe(Math.ceil((bed.areaSqm * 1.12) / 0.64));
    const tlt = rows.find((r) => r.room === "tlt")!;
    expect(tlt.finish).toBe("Anti-skid ceramic tile 300 × 300");
    expect(tlt.skirtingM).toBe(0);
    expect(tableToCsv(flooringTable(p)).split("\r\n")[0]).toBe("\uFEFFFloor,Room,Finish,Clear area,Wastage,To order,Tiles,Skirting");
  });

  it("rejects a finish that is not a tile", () => {
    const r = dryRun(house(), [{ op: "SetFinish", args: { rooms: ["bed"], catalogue: "bed.queen" } }]);
    expect(r.status).toBe("rejected");
  });

  it("lays tables out on sheets", () => {
    expect(scheduleSheets(house()).length).toBeGreaterThanOrEqual(1);
  });
});

describe("3D", () => {
  it("builds walls, glass, doors, slabs, parapets and stair steps", () => {
    const sc = buildScene(house());
    const mats = new Set(sc.boxes.map((b) => b.material));
    for (const m of ["wall", "glass", "door", "slab", "accent", "stair", "ground", "road"]) expect(mats).toContain(m);
    // 16 risers: 8 + 7 nosed steps and a landing
    expect(sc.boxes.filter((b) => b.material === "stair")).toHaveLength(16);
  });

  it("writes a valid binary glTF", () => {
    const glb = sceneToGlb(buildScene(house()));
    const dv = new DataView(glb.buffer);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes.length).toBe(json.materials.length);
    expect(json.buffers[0].byteLength).toBeLessThanOrEqual(dv.getUint32(20 + jsonLen, true));
  });

  it("is a single offline HTML file under 5 MB", () => {
    const html = renderViewer3dHtml(house());
    expect(html.length).toBeLessThan(5_000_000);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain("window.THREE=");
    expect(html).toContain(`"levels":["Ground","First"]`);
    expect(html).toContain("S (road)");
  });
});
