/**
 * A drawing sheet as a display list, so the same drawing goes to SVG (web,
 * viewer) and PDF (print, WhatsApp forwards) without being drawn twice.
 * Coordinates are model millimetres on the sheet, y pointing down.
 */

export type Pt = [number, number];

export interface Style {
  stroke?: string;
  /** Stroke width in model mm. */
  sw?: number;
  /** Dash pattern in model mm. */
  dash?: number[];
  /** A colour, or "hatch" for the brick hatch used on external walls. */
  fill?: string;
}

export type Item =
  | ({ kind: "rect"; x: number; y: number; w: number; h: number } & Style)
  | ({ kind: "line"; a: Pt; b: Pt } & Style)
  | ({ kind: "poly"; pts: Pt[]; closed: boolean } & Style)
  | ({ kind: "circle"; c: Pt; r: number } & Style)
  /** A circular arc from `from` to `to` about `c`; sweep 1 runs clockwise on the sheet. */
  | ({ kind: "arc"; c: Pt; r: number; from: Pt; to: Pt; sweep: 0 | 1 } & Style)
  | { kind: "text"; at: Pt; text: string; size: number; bold?: boolean; fill?: string; /** degrees, clockwise on the sheet */ rotate?: number };

export interface Sheet {
  title: string;
  /** Sheet size in model mm. */
  width: number;
  height: number;
  /** Drawing scale denominator the sheet is laid out for (100 = 1:100). */
  scale: number;
  items: Item[];
}

const HATCH_PATTERN = `<pattern id="hatch" patternUnits="userSpaceOnUse" width="120" height="120" patternTransform="rotate(45)"><rect width="120" height="120" fill="#c9c9c9"/><line x1="0" y1="0" x2="0" y2="120" stroke="#555" stroke-width="22"/></pattern>`;

const r1 = (n: number) => Math.round(n * 10) / 10;
export const escXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function style(s: Style, defaultFill = "none"): string {
  const fill = s.fill === "hatch" ? "url(#hatch)" : (s.fill ?? defaultFill);
  return [
    `fill="${fill}"`,
    s.stroke ? `stroke="${s.stroke}" stroke-width="${s.sw ?? 10}"` : "",
    s.dash ? `stroke-dasharray="${s.dash.join(" ")}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * SVG for a sheet. By default it is sized in real millimetres so it prints
 * at its scale; `fluid` drops the size so a viewer can fit it to the screen.
 */
export function sheetToSvg(sheet: Sheet, opts: { fluid?: boolean; id?: string } = {}): string {
  const size = opts.fluid ? "" : ` width="${r1(sheet.width / sheet.scale)}mm" height="${r1(sheet.height / sheet.scale)}mm"`;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg"${opts.id ? ` id="${opts.id}"` : ""}${size} viewBox="0 0 ${r1(sheet.width)} ${r1(sheet.height)}" font-family="Helvetica, Arial, sans-serif">`,
    `<title>${escXml(sheet.title)}</title><defs>${HATCH_PATTERN}</defs>`,
    `<rect width="${r1(sheet.width)}" height="${r1(sheet.height)}" fill="#ffffff"/>`,
  ];
  for (const it of sheet.items) {
    switch (it.kind) {
      case "rect":
        out.push(`<rect x="${r1(it.x)}" y="${r1(it.y)}" width="${r1(it.w)}" height="${r1(it.h)}" ${style(it, "none")}/>`);
        break;
      case "line":
        out.push(`<line x1="${r1(it.a[0])}" y1="${r1(it.a[1])}" x2="${r1(it.b[0])}" y2="${r1(it.b[1])}" ${style({ stroke: "#000", ...it })}/>`);
        break;
      case "poly":
        out.push(`<${it.closed ? "polygon" : "polyline"} points="${it.pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join(" ")}" ${style(it)}/>`);
        break;
      case "circle":
        out.push(`<circle cx="${r1(it.c[0])}" cy="${r1(it.c[1])}" r="${r1(it.r)}" ${style(it)}/>`);
        break;
      case "arc":
        out.push(`<path d="M ${r1(it.from[0])} ${r1(it.from[1])} A ${r1(it.r)} ${r1(it.r)} 0 0 ${it.sweep} ${r1(it.to[0])} ${r1(it.to[1])}" ${style(it)}/>`);
        break;
      case "text": {
        const rot = it.rotate ? ` transform="rotate(${it.rotate} ${r1(it.at[0])} ${r1(it.at[1])})"` : "";
        out.push(
          `<text x="${r1(it.at[0])}" y="${r1(it.at[1])}" font-size="${it.size}" text-anchor="middle" dominant-baseline="middle"${it.bold ? ` font-weight="bold"` : ""} fill="${it.fill ?? "#000"}"${rot}>${escXml(it.text)}</text>`,
        );
        break;
      }
    }
  }
  out.push("</svg>");
  return out.join("\n");
}
