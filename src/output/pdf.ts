/**
 * A small vector PDF writer for sheets: one page per sheet, printed to scale
 * on A4 or A3 landscape, using only the PDF base fonts so files stay small
 * (tens of kB) and open anywhere, including phones that were sent the file.
 */
import type { Item, Pt, Sheet, Style } from "./sheet.js";

const PT_PER_MM = 72 / 25.4;
const PAPERS = { A4: [297, 210], A3: [420, 297] } as const;
export type Paper = keyof typeof PAPERS;

/** Helvetica advance widths (1/1000 em) for ASCII 32–126. */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Unicode characters used on sheets, mapped to WinAnsiEncoding. */
const WIN_ANSI: Record<string, number> = { "×": 0xd7, "²": 0xb2, "·": 0xb7, "–": 0x96, "—": 0x97, "°": 0xb0, "₹": 0x52 };

function encode(s: string): number[] {
  return [...s].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c <= 126) return c;
    return WIN_ANSI[ch] ?? 0x3f;
  });
}

function textWidth(s: string, size: number, bold?: boolean): number {
  const w = encode(s).reduce((sum, c) => sum + (c >= 32 && c <= 126 ? HELV[c - 32]! : 556), 0);
  return (w / 1000) * size * (bold ? 1.06 : 1);
}

function pdfString(s: string): string {
  return (
    "(" +
    encode(s)
      .map((c) => (c === 0x28 || c === 0x29 || c === 0x5c ? "\\" + String.fromCharCode(c) : c > 126 ? "\\" + c.toString(8).padStart(3, "0") : String.fromCharCode(c)))
      .join("") +
    ")"
  );
}

function rgb(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  const n = parseInt(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** Chooses the smallest paper that holds the sheet at its scale, else A3 at the next standard scale. */
export function fitPaper(sheet: Sheet, paper?: Paper): { paper: Paper; scale: number } {
  const fits = (p: Paper, scale: number) => sheet.width / scale <= PAPERS[p][0] - 10 && sheet.height / scale <= PAPERS[p][1] - 10;
  if (paper) {
    for (const scale of [sheet.scale, 150, 200, 250, 500]) if (fits(paper, scale)) return { paper, scale };
    return { paper, scale: 500 };
  }
  for (const p of ["A4", "A3"] as Paper[]) if (fits(p, sheet.scale)) return { paper: p, scale: sheet.scale };
  for (const scale of [150, 200, 250, 500]) if (fits("A3", scale)) return { paper: "A3", scale };
  return { paper: "A3", scale: 500 };
}

/**
 * One PDF page per sheet. Sheets drawn for 1:100 that do not fit A3 are
 * printed at a smaller scale, and their title should say so; pass `paper`
 * to force a size.
 */
export function sheetsToPdf(sheets: Sheet[], opts: { paper?: Paper } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // 1-based object numbers
  const catalog = add("");
  const pagesObj = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds: number[] = [];

  for (const sheet of sheets) {
    const { paper, scale } = fitPaper(sheet, opts.paper);
    const [pw, ph] = PAPERS[paper];
    const k = PT_PER_MM / scale; // model mm → points
    const offX = ((pw - sheet.width / scale) / 2) * PT_PER_MM;
    const offY = ((ph - sheet.height / scale) / 2) * PT_PER_MM;
    // Sheet coordinates are y-down; PDF is y-up.
    const T = ([x, y]: Pt): string => `${f(offX + x * k)} ${f(offY + (sheet.height - y) * k)}`;
    const ops: string[] = [];
    for (const it of sheet.items) ops.push(drawItem(it, T, k));
    const content = ops.join("\n");
    const stream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${f(pw * PT_PER_MM)} ${f(ph * PT_PER_MM)}] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

function strokeOps(s: Style, k: number): string {
  if (!s.stroke) return "";
  const [r, g, b] = rgb(s.stroke);
  return `${f(r)} ${f(g)} ${f(b)} RG ${f((s.sw ?? 10) * k)} w ${s.dash ? `[${s.dash.map((d) => f(d * k)).join(" ")}] 0 d` : "[] 0 d"}`;
}

function fillOps(color: string): string {
  const [r, g, b] = rgb(color);
  return `${f(r)} ${f(g)} ${f(b)} rg`;
}

/** Paints a closed path already described by `path`: fill (or hatch), then stroke. */
function paint(path: string, s: Style, k: number, hatchBox?: [Pt, Pt], T?: (p: Pt) => string): string {
  const out: string[] = [];
  if (s.fill === "hatch" && hatchBox && T) {
    const [[x0, y0], [x1, y1]] = hatchBox;
    out.push(`q ${fillOps("#c9c9c9")} ${path} f`);
    out.push(`${path} W n 0.333 0.333 0.333 RG ${f(22 * k)} w [] 0 d`);
    const span = x1 - x0 + (y1 - y0);
    for (let d = 0; d <= span; d += 170) out.push(`${T([x0 + d, y0])} m ${T([x0 + d - (y1 - y0), y1])} l S`);
    out.push("Q");
  } else if (s.fill && s.fill !== "none") {
    out.push(`${fillOps(s.fill)} ${path} f`);
  }
  if (s.stroke) out.push(`${strokeOps(s, k)} ${path} S`);
  return out.join("\n");
}

function drawItem(it: Item, T: (p: Pt) => string, k: number): string {
  switch (it.kind) {
    case "rect": {
      const pts: Pt[] = [
        [it.x, it.y],
        [it.x + it.w, it.y],
        [it.x + it.w, it.y + it.h],
        [it.x, it.y + it.h],
      ];
      const path = `${T(pts[0]!)} m ${pts.slice(1).map((p) => `${T(p)} l`).join(" ")} h`;
      return paint(path, it, k, [pts[0]!, pts[2]!], T);
    }
    case "line":
      return `${strokeOps({ stroke: "#000", ...it }, k)} ${T(it.a)} m ${T(it.b)} l S`;
    case "poly": {
      const path = `${T(it.pts[0]!)} m ${it.pts.slice(1).map((p) => `${T(p)} l`).join(" ")}${it.closed ? " h" : ""}`;
      return it.closed ? paint(path, it, k) : `${strokeOps(it, k)} ${path} S`;
    }
    case "circle": {
      const c = 0.5523 * it.r;
      const [cx, cy] = it.c;
      const path = [
        `${T([cx + it.r, cy])} m`,
        `${T([cx + it.r, cy + c])} ${T([cx + c, cy + it.r])} ${T([cx, cy + it.r])} c`,
        `${T([cx - c, cy + it.r])} ${T([cx - it.r, cy + c])} ${T([cx - it.r, cy])} c`,
        `${T([cx - it.r, cy - c])} ${T([cx - c, cy - it.r])} ${T([cx, cy - it.r])} c`,
        `${T([cx + c, cy - it.r])} ${T([cx + it.r, cy - c])} ${T([cx + it.r, cy])} c h`,
      ].join(" ");
      return paint(path, it, k);
    }
    case "arc": {
      // Door swings are quarter circles; one cubic Bézier is accurate to 0.03% for 90°.
      const [cx, cy] = it.c;
      const a0 = Math.atan2(it.from[1] - cy, it.from[0] - cx);
      let a1 = Math.atan2(it.to[1] - cy, it.to[0] - cx);
      // Sheet y points down, so clockwise on the sheet is increasing angle.
      if (it.sweep === 1 && a1 < a0) a1 += 2 * Math.PI;
      if (it.sweep === 0 && a1 > a0) a1 -= 2 * Math.PI;
      const parts = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
      const step = (a1 - a0) / parts;
      const h = (4 / 3) * Math.tan(step / 4) * it.r;
      const P = (a: number): Pt => [cx + it.r * Math.cos(a), cy + it.r * Math.sin(a)];
      const segs: string[] = [`${T(P(a0))} m`];
      for (let i = 0; i < parts; i++) {
        const s = a0 + i * step;
        const e = s + step;
        const p0 = P(s);
        const p3 = P(e);
        const c1: Pt = [p0[0] - h * Math.sin(s), p0[1] + h * Math.cos(s)];
        const c2: Pt = [p3[0] + h * Math.sin(e), p3[1] - h * Math.cos(e)];
        segs.push(`${T(c1)} ${T(c2)} ${T(p3)} c`);
      }
      return `${strokeOps(it, k)} ${segs.join(" ")} S`;
    }
    case "text": {
      const size = it.size * k;
      const w = textWidth(it.text, size, it.bold);
      // Centre (or start or end) on the anchor; rotation is clockwise on the sheet, i.e. negative in PDF space.
      const a = (-(it.rotate ?? 0) * Math.PI) / 180;
      const [ax, ay] = T(it.at).split(" ").map(Number) as [number, number];
      const dx = it.align === "start" ? 0 : it.align === "end" ? -w : -w / 2;
      const dy = -size * 0.35;
      const x = ax + dx * Math.cos(a) - dy * Math.sin(a);
      const y = ay + dx * Math.sin(a) + dy * Math.cos(a);
      return `BT ${fillOps(it.fill ?? "#000")} /${it.bold ? "F2" : "F1"} ${f(size)} Tf ${f(Math.cos(a))} ${f(Math.sin(a))} ${f(-Math.sin(a))} ${f(Math.cos(a))} ${f(x)} ${f(y)} Tm ${pdfString(it.text)} Tj ET`;
    }
  }
}
