/**
 * A sheet as a PNG, for the preview image a WhatsApp or chat link shows before
 * anyone opens the drawing. Rasterized here rather than in a browser so a
 * share link can be answered by a plain server: a small scanline renderer over
 * the same display list, and a PNG written with node:zlib.
 */
import { deflateSync } from "node:zlib";
import type { Item, Pt, Sheet, Style } from "./sheet.js";

export interface PreviewOptions {
  /** Longest side of the image in pixels; default 1200. */
  width?: number;
  background?: string;
}

interface Canvas {
  w: number;
  h: number;
  /** RGB, row major. */
  px: Uint8Array;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function parseColour(c: string | undefined, fallback: [number, number, number] | null = null): [number, number, number] | null {
  if (!c || c === "none") return fallback;
  if (c === "hatch") return [201, 201, 201];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return fallback;
  const hex = m[1]!.length === 3 ? m[1]!.split("").map((h) => h + h).join("") : m[1]!;
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function blend(cv: Canvas, x: number, y: number, rgb: [number, number, number], a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 3;
  const al = clamp(a, 0, 1);
  for (let k = 0; k < 3; k++) cv.px[i + k] = Math.round(cv.px[i + k]! * (1 - al) + rgb[k]! * al);
}

/** A filled axis-aligned rectangle with soft edges, which is all the fills the sheets use. */
function fillRect(cv: Canvas, x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]): void {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [c, d] = [Math.min(y0, y1), Math.max(y0, y1)];
  for (let y = Math.floor(c); y <= Math.ceil(d); y++)
    for (let x = Math.floor(a); x <= Math.ceil(b); x++) {
      const cover = Math.max(0, Math.min(b, x + 1) - Math.max(a, x)) * Math.max(0, Math.min(d, y + 1) - Math.max(c, y));
      blend(cv, x, y, rgb, cover);
    }
}

/** A line of given width, drawn as a sequence of dabs; enough for a thumbnail. */
function strokeLine(cv: Canvas, a: Pt, b: Pt, rgb: [number, number, number], width: number): void {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(len));
  const half = Math.max(0.35, width / 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a[0] + (b[0] - a[0]) * t;
    const y = a[1] + (b[1] - a[1]) * t;
    fillRect(cv, x - half, y - half, x + half, y + half, rgb);
  }
}

function strokePoly(cv: Canvas, pts: Pt[], closed: boolean, rgb: [number, number, number], width: number): void {
  for (let i = 0; i + 1 < pts.length; i++) strokeLine(cv, pts[i]!, pts[i + 1]!, rgb, width);
  if (closed && pts.length > 2) strokeLine(cv, pts[pts.length - 1]!, pts[0]!, rgb, width);
}

function circlePts(c: Pt, r: number, from = 0, to = Math.PI * 2): Pt[] {
  const steps = Math.max(8, Math.ceil(r * 2));
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/**
 * Text is drawn as a grey bar of about the right length, not as glyphs: at
 * preview size the words are unreadable anyway, and the bars keep the drawing
 * looking like a drawing. The real text is in the SVG and the PDF.
 */
function textBar(cv: Canvas, it: Extract<Item, { kind: "text" }>, s: number, ox: number, oy: number): void {
  const rgb = parseColour(it.fill, [60, 60, 60])!;
  const h = it.size * s * 0.62;
  if (h < 1.2) return;
  const w = it.text.length * it.size * s * 0.5;
  const x = (it.at[0] - ox) * s;
  const y = (it.at[1] - oy) * s;
  const start = it.align === "start" ? x : it.align === "end" ? x - w : x - w / 2;
  if (it.rotate) {
    // Vertical labels: a bar the other way round
    fillRect(cv, x - h / 2, y - w / 2, x + h / 2, y + w / 2, rgb);
    return;
  }
  fillRect(cv, start, y - h / 2, start + w, y + h / 2, rgb);
}

/** The sheet drawn into an RGB canvas. */
export function rasterize(sheet: Sheet, opts: PreviewOptions = {}): Canvas {
  const target = opts.width ?? 1200;
  const s = target / sheet.width;
  const cv: Canvas = { w: Math.max(1, Math.round(sheet.width * s)), h: Math.max(1, Math.round(sheet.height * s)), px: new Uint8Array(Math.max(1, Math.round(sheet.width * s)) * Math.max(1, Math.round(sheet.height * s)) * 3) };
  cv.px.fill(255);
  const bg = parseColour(opts.background, [255, 255, 255])!;
  fillRect(cv, 0, 0, cv.w, cv.h, bg);
  const P = (p: Pt): Pt => [p[0] * s, p[1] * s];

  for (const it of sheet.items) {
    const st = it as Style;
    const sw = Math.max(0.7, (st.sw ?? 10) * s);
    const stroke = parseColour(st.stroke);
    switch (it.kind) {
      case "rect": {
        const fill = parseColour(st.fill);
        if (fill) fillRect(cv, it.x * s, it.y * s, (it.x + it.w) * s, (it.y + it.h) * s, fill);
        if (stroke)
          strokePoly(
            cv,
            [
              [it.x, it.y],
              [it.x + it.w, it.y],
              [it.x + it.w, it.y + it.h],
              [it.x, it.y + it.h],
            ].map((p) => P(p as Pt)),
            true,
            stroke,
            sw,
          );
        break;
      }
      case "line":
        strokeLine(cv, P(it.a), P(it.b), stroke ?? [0, 0, 0], sw);
        break;
      case "poly": {
        const fill = parseColour(st.fill);
        if (fill) {
          // Only the bounding box, which is enough for the small shapes the sheets fill
          const xs = it.pts.map((p) => p[0] * s);
          const ys = it.pts.map((p) => p[1] * s);
          fillRect(cv, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), fill);
        }
        strokePoly(cv, it.pts.map(P), it.closed, stroke ?? [0, 0, 0], sw);
        break;
      }
      case "circle": {
        const fill = parseColour(st.fill);
        const c = P(it.c);
        const r = it.r * s;
        if (fill) for (let y = Math.floor(c[1] - r); y <= Math.ceil(c[1] + r); y++) for (let x = Math.floor(c[0] - r); x <= Math.ceil(c[0] + r); x++) if (Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1]) <= r) blend(cv, x, y, fill, 1);
        if (stroke) strokePoly(cv, circlePts(c, r), true, stroke, sw);
        break;
      }
      case "arc": {
        const c = P(it.c);
        const r = it.r * s;
        const ang = (p: Pt) => Math.atan2(p[1] * s - c[1], p[0] * s - c[0]);
        let [a0, a1] = [ang(it.from), ang(it.to)];
        if (it.sweep === 1) {
          while (a1 < a0) a1 += Math.PI * 2;
        } else {
          while (a1 > a0) a1 -= Math.PI * 2;
        }
        strokePoly(cv, circlePts(c, r, a0, a1), false, stroke ?? [0, 0, 0], sw);
        break;
      }
      case "text":
        textBar(cv, it, s, 0, 0);
        break;
    }
  }
  return cv;
}

/** The sheet as a PNG, for a link preview. */
export function sheetToPng(sheet: Sheet, opts: PreviewOptions = {}): Uint8Array {
  const cv = rasterize(sheet, opts);
  const raw = new Uint8Array(cv.h * (cv.w * 3 + 1));
  for (let y = 0; y < cv.h; y++) {
    raw[y * (cv.w * 3 + 1)] = 0; // filter: none
    raw.set(cv.px.subarray(y * cv.w * 3, (y + 1) * cv.w * 3), y * (cv.w * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, cv.w);
  v.setUint32(4, cv.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array(0))]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
