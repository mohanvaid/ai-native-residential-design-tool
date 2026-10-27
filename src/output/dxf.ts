/**
 * A sheet as DXF R12 (AC1009), the interchange format every Indian CAD office
 * reads. One ENTITIES section drawn from the same display list as the SVG and
 * PDF, in sheet millimetres with y flipped back so north is up in CAD. Colours
 * become ACI indices and items are grouped on layers by what they are, so a
 * draughtsman can freeze dimensions or furniture.
 */
import type { Item, Sheet, Style } from "./sheet.js";

/** AutoCAD Color Index for the nearest of the few colours the sheets use. */
const ACI: [string, number][] = [
  ["#000000", 7],
  ["#ffffff", 7],
  ["#555555", 8],
  ["#7a7a7a", 8],
  ["#9a9a9a", 9],
  ["#c9c9c9", 9],
  ["#c0392b", 1],
  ["#d35400", 30],
  ["#1f5fa8", 5],
  ["#6d4c41", 34],
  ["#2e7d32", 3],
];

function aci(colour: string | undefined): number {
  if (!colour || colour === "hatch" || colour === "none") return 7;
  const c = colour.toLowerCase();
  const hit = ACI.find(([h]) => h === c);
  if (hit) return hit[1];
  const m = /^#([0-9a-f]{6})$/.exec(c);
  if (!m) return 7;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (Math.max(r, g, b) - Math.min(r, g, b) < 24) return r > 200 ? 7 : r > 110 ? 8 : 7;
  if (r >= g && r >= b) return g > 120 ? 30 : 1;
  if (g >= b) return 3;
  return 5;
}

/** Layers by what an item is, named as a drawing office would. */
export const DXF_LAYERS = ["0", "WALLS", "OPENINGS", "FURNITURE", "SERVICES", "DIMENSIONS", "TEXT", "SITE"] as const;
export type DxfLayer = (typeof DXF_LAYERS)[number];

function layerOf(it: Item): DxfLayer {
  if (it.kind === "text") return "TEXT";
  const style = it as Style;
  if (style.fill === "hatch" || style.fill === "#9a9a9a") return "WALLS";
  if (style.dash) return "DIMENSIONS";
  if (style.stroke === "#d35400" || style.stroke === "#1f5fa8" || style.stroke === "#6d4c41") return "SERVICES";
  if (it.kind === "arc") return "OPENINGS";
  return "0";
}

const g = (code: number, value: string | number) => `${code}\n${value}\n`;

export function sheetToDxf(sheet: Sheet): string {
  const h = sheet.height;
  const out: string[] = [];
  // y points down on a sheet and up in CAD
  const pt = (x: number, y: number, z = 0) => g(10 + z, round(x)) + g(20 + z, round(h - y));
  const head = (type: string, it: Item) => g(0, type) + g(8, layerOf(it)) + g(62, aci(strokeOf(it)));

  for (const it of sheet.items) {
    switch (it.kind) {
      case "rect": {
        // Closed polyline, so a filled rect still reads as a boundary in CAD
        out.push(head("POLYLINE", it) + g(66, 1) + g(70, 1) + pt(0, 0));
        for (const [x, y] of [
          [it.x, it.y],
          [it.x + it.w, it.y],
          [it.x + it.w, it.y + it.h],
          [it.x, it.y + it.h],
        ])
          out.push(g(0, "VERTEX") + g(8, layerOf(it)) + pt(x!, y!));
        out.push(g(0, "SEQEND"));
        break;
      }
      case "line":
        out.push(head("LINE", it) + pt(it.a[0], it.a[1]) + pt(it.b[0], it.b[1], 1));
        break;
      case "poly": {
        out.push(head("POLYLINE", it) + g(66, 1) + g(70, it.closed ? 1 : 0) + pt(0, 0));
        for (const p of it.pts) out.push(g(0, "VERTEX") + g(8, layerOf(it)) + pt(p[0], p[1]));
        out.push(g(0, "SEQEND"));
        break;
      }
      case "circle":
        out.push(head("CIRCLE", it) + pt(it.c[0], it.c[1]) + g(40, round(it.r)));
        break;
      case "arc": {
        // DXF arcs run anticlockwise from the start angle; a clockwise sweep on the sheet is anticlockwise in CAD
        const ang = (p: [number, number]) => (Math.atan2(h - p[1] - (h - it.c[1]), p[0] - it.c[0]) * 180) / Math.PI;
        const [a, b] = it.sweep === 1 ? [ang(it.from), ang(it.to)] : [ang(it.to), ang(it.from)];
        out.push(head("ARC", it) + pt(it.c[0], it.c[1]) + g(40, round(it.r)) + g(50, round(norm(a))) + g(51, round(norm(b))));
        break;
      }
      case "text": {
        const align = it.align === "start" ? 0 : it.align === "end" ? 2 : 1;
        out.push(
          head("TEXT", it) +
            pt(it.at[0], it.at[1]) +
            g(40, round(it.size)) +
            g(1, ascii(it.text)) +
            g(50, round(it.rotate ? -it.rotate : 0)) +
            g(72, align) +
            g(73, 2) +
            pt(it.at[0], it.at[1], 1),
        );
        break;
      }
    }
  }

  return (
    g(0, "SECTION") +
    g(2, "HEADER") +
    g(9, "$ACADVER") +
    g(1, "AC1009") +
    g(9, "$INSUNITS") +
    g(70, 4) +
    g(9, "$DWGCODEPAGE") +
    g(3, "ANSI_1252") +
    g(9, "$EXTMIN") +
    g(10, 0) +
    g(20, 0) +
    g(9, "$EXTMAX") +
    g(10, round(sheet.width)) +
    g(20, round(sheet.height)) +
    g(0, "ENDSEC") +
    g(0, "SECTION") +
    g(2, "TABLES") +
    g(0, "TABLE") +
    g(2, "LAYER") +
    g(70, DXF_LAYERS.length) +
    DXF_LAYERS.map((l) => g(0, "LAYER") + g(2, l) + g(70, 0) + g(62, 7) + g(6, "CONTINUOUS")).join("") +
    g(0, "ENDTAB") +
    g(0, "ENDSEC") +
    g(0, "SECTION") +
    g(2, "ENTITIES") +
    out.join("") +
    g(0, "ENDSEC") +
    g(0, "EOF")
  );
}

/** DXF R12 text is single-byte, so the few typographic characters the sheets use become ASCII. */
const ASCII: [RegExp, string][] = [
  [/[·•]/g, "-"],
  [/[–—]/g, "-"],
  [/[’‘]/g, "'"],
  [/[“”]/g, '"'],
  [/×/g, "x"],
  [/²/g, "2"],
  [/³/g, "3"],
  [/₹/g, "Rs."],
  [/°/g, "deg"],
  [/…/g, "..."],
];

function ascii(text: string): string {
  let out = text.replace(/\n/g, " ");
  for (const [re, to] of ASCII) out = out.replace(re, to);
  // Anything still outside ASCII would be mis-read by the CAD program
  return out.replace(/[^\x20-\x7e]/g, "?");
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const norm = (deg: number) => ((deg % 360) + 360) % 360;
const strokeOf = (it: Item) => (it.kind === "text" ? it.fill : ((it as Style).stroke ?? ((it as Style).fill === "hatch" ? "#555555" : (it as Style).fill)));
