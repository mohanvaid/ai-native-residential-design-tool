/**
 * Schedules as rows (for the viewer and CSV) and as printable sheets:
 * doors and windows, floor finishes with wastage and skirting, and
 * furniture with price bands.
 */
import { catalogueItem, defaultFloorFinish } from "../catalogue/catalogue.js";
import { boundaryToRect, rectArea, rectDepth, rectWidth } from "../model/geometry.js";
import type { Project } from "../model/schema.js";
import { formatFtIn, sqmToSqft } from "../model/units.js";
import { clearRect, deriveWalls } from "../model/walls.js";
import { areaStatement } from "../model/flats.js";
import { titleBlock, SMALL, TEXT } from "./frame.js";
import { openingSchedule } from "./schedule.js";
import type { Item, Sheet } from "./sheet.js";

export interface Table {
  title: string;
  head: string[];
  rows: string[][];
  /** Columns that hold numbers, right-aligned. */
  numeric: number[];
}

export function doorWindowTable(project: Project): Table {
  const levelOf = (id: string) => project.rooms.find((r) => r.id === id)?.level;
  return {
    title: "Door and window schedule",
    head: ["Mark", "Type", "Width", "Height", "Sill", "Product", ...project.levels.map((l) => l.name), "Total"],
    numeric: [6 + project.levels.length],
    rows: openingSchedule(project).map((r) => {
      const first = project.openings.find((o) => o.id === r.openings[0]);
      const per = project.levels.map((l) => String(r.openings.filter((id) => levelOf(project.openings.find((o) => o.id === id)!.host.room) === l.id).length));
      return [r.mark, r.type, `${r.width} mm`, `${r.height} mm`, `${r.sill} mm`, (first?.catalogue && catalogueItem(first.catalogue)?.name) || "—", ...per, String(r.count)];
    }),
  };
}

export interface FlooringRow {
  roomId: string;
  finishId: string;
  room: string;
  level: string;
  finish: string;
  areaSqm: number;
  wastage: number;
  orderSqm: number;
  tiles: number;
  skirtingM: number;
  priceInr: [number, number];
}

/** Floor finish per room: clear area, area to order with wastage, tile count and skirting (clear perimeter less door widths; none where walls are tiled). */
export function flooringRows(project: Project): FlooringRow[] {
  const out: FlooringRow[] = [];
  for (const level of project.levels) {
    const walls = deriveWalls(project, level.id);
    for (const room of project.rooms.filter((r) => r.level === level.id && boundaryToRect(r.boundary))) {
      const cat = catalogueItem(room.finishes.floor ?? defaultFloorFinish(room.type));
      if (!cat) continue;
      const c = clearRect(walls, room);
      const area = rectArea(c) / 1e6;
      const wastage = cat.wastage ?? 0.1;
      const doors = project.openings.filter((o) => (o.type === "door" || o.type === "opening") && o.host.room === room.id).reduce((s, o) => s + o.width, 0);
      const tiled = room.type === "toilet";
      out.push({
        roomId: room.id,
        finishId: cat.id,
        room: room.name,
        level: level.name,
        finish: cat.name,
        areaSqm: area,
        wastage,
        orderSqm: area * (1 + wastage),
        tiles: Math.ceil((area * (1 + wastage) * 1e6) / (cat.width * cat.depth)),
        skirtingM: tiled ? 0 : Math.max(0, 2 * (rectWidth(c) + rectDepth(c)) - doors) / 1000,
        priceInr: [Math.round(area * (1 + wastage) * cat.priceInr[0]), Math.round(area * (1 + wastage) * cat.priceInr[1])],
      });
    }
  }
  return out;
}

export function flooringTable(project: Project): Table {
  const rows = flooringRows(project);
  const total = rows.reduce((s, r) => s + r.orderSqm, 0);
  return {
    title: "Flooring schedule",
    head: ["Floor", "Room", "Finish", "Clear area", "Wastage", "To order", "Tiles", "Skirting"],
    numeric: [3, 4, 5, 6, 7],
    rows: [
      ...rows.map((r) => [r.level, r.room, r.finish, `${r.areaSqm.toFixed(1)} m² (${Math.round(sqmToSqft(r.areaSqm))} sq ft)`, `${Math.round(r.wastage * 100)}%`, `${r.orderSqm.toFixed(1)} m²`, String(r.tiles), r.skirtingM ? `${r.skirtingM.toFixed(1)} m` : "—"]),
      ["", "Total", "", "", "", `${total.toFixed(1)} m²`, "", `${rows.reduce((s, r) => s + r.skirtingM, 0).toFixed(1)} m`],
    ],
  };
}

export function furnitureTable(project: Project): Table {
  return {
    title: "Furniture and fixtures",
    head: ["Floor", "Room", "Item", "Size", "Price band (INR)"],
    numeric: [4],
    rows: project.items.flatMap((it) => {
      const cat = catalogueItem(it.catalogue);
      const room = project.rooms.find((r) => r.id === it.room);
      if (!cat || !room) return [];
      const level = project.levels.find((l) => l.id === room.level)?.name ?? "";
      const price = cat.priceInr[1] ? `${cat.priceInr[0].toLocaleString("en-IN")}–${cat.priceInr[1].toLocaleString("en-IN")}` : "—";
      return [[level, room.name, cat.name, `${formatFtIn(cat.width)} × ${formatFtIn(cat.depth)}`, price]];
    }),
  };
}

const sqftText = (sqm: number) => `${Math.round(sqmToSqft(sqm)).toLocaleString("en-IN")} sq ft`;

/** Area statement: carpet, built-up, common share and super built-up per flat. */
export function areaStatementTable(project: Project): Table {
  const st = areaStatement(project);
  const rows = st.flats.map((f) => [f.flat, f.levels.join(", "), `${f.bedrooms} BR, ${f.rooms} rooms`, sqftText(f.carpetSqm), sqftText(f.builtUpSqm), sqftText(f.commonShareSqm), sqftText(f.superBuiltUpSqm)]);
  const sum = (k: "carpetSqm" | "builtUpSqm" | "commonShareSqm" | "superBuiltUpSqm") => st.flats.reduce((s, f) => s + f[k], 0);
  if (st.flats.length > 1) rows.push(["Total", "", "", sqftText(sum("carpetSqm")), sqftText(sum("builtUpSqm")), sqftText(sum("commonShareSqm")), sqftText(sum("superBuiltUpSqm"))]);
  return {
    title: "Area statement",
    head: ["Flat", "Floor", "Rooms", "Carpet", "Built-up", "Common share", "Super built-up"],
    numeric: [3, 4, 5, 6],
    rows,
  };
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A table as CSV, which opens in Excel or Google Sheets. */
export function tableToCsv(t: Table): string {
  return tablesToCsv([t]);
}

/** Several tables in one CSV, a blank row apart. Starts with a byte-order mark so Excel reads ₹ and × correctly. */
export function tablesToCsv(tables: Table[]): string {
  return "\uFEFF" + tables.map(csvRows).join("\r\n");
}

function csvRows(t: Table): string {
  // Plain numbers in numeric columns, so a spreadsheet can add them up
  const plain = (s: string, i: number) => (t.numeric.includes(i) && /^-?[\d,]+(\.\d+)?$/.test(s) ? s.replace(/,/g, "") : s);
  return [t.head, ...t.rows.map((r) => r.map(plain))].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Tables laid out on A4 landscape sheets, continuing onto more sheets when long. */
export function scheduleSheets(project: Project, tables: Table[] = [doorWindowTable(project), flooringTable(project), furnitureTable(project)]): Sheet[] {
  const W = 29700;
  const H = 21000;
  const top = 1200;
  const bottom = H - 1600;
  const rowH = 420;
  const sheets: Sheet[] = [];
  let items: Item[] = [];
  let y = top;
  const flush = () => {
    sheets.push(titleBlock(items, W, H, project, "Schedules", "Quantities are computed from the design model; check on site before ordering.", { north: false, scaleText: "Not to scale" }));
    items = [];
    y = top;
  };
  for (const t of tables) {
    if (!t.rows.length) continue;
    const widths = t.head.map((h, i) => Math.max(h.length, ...t.rows.map((r) => (r[i] ?? "").length)));
    const unit = (W - 1200) / widths.reduce((s, w) => s + w + 2, 0);
    const xs: number[] = [];
    let x = 600;
    for (const w of widths) {
      xs.push(x);
      x += (w + 2) * unit;
    }
    xs.push(x);
    // Numbers line up on the right, words on the left
    const pad = unit;
    const cell = (i: number) => (t.numeric.includes(i) ? { align: "end" as const, x: xs[i + 1]! - pad } : { align: "start" as const, x: xs[i]! + pad });
    const header = () => {
      items.push({ kind: "text", at: [600, y], text: t.title.toUpperCase(), size: TEXT, bold: true, align: "start" });
      y += rowH;
      items.push({ kind: "rect", x: 600, y: y - rowH / 2, w: x - 600, h: rowH, fill: "#eeeeee" });
      t.head.forEach((h, i) => items.push({ kind: "text", align: cell(i).align, at: [cell(i).x, y], text: h, size: SMALL - 10, bold: true }));
      y += rowH;
    };
    if (y + 3 * rowH > bottom) flush();
    header();
    for (const r of t.rows) {
      if (y > bottom) {
        flush();
        header();
      }
      items.push({ kind: "line", a: [600, y - rowH / 2], b: [x, y - rowH / 2], stroke: "#cccccc", sw: 8 });
      r.forEach((text, i) => items.push({ kind: "text", align: cell(i).align, at: [cell(i).x, y], text, size: SMALL - 20 }));
      y += rowH;
    }
    y += rowH;
  }
  if (items.length) flush();
  return sheets;
}
