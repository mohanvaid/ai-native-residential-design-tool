/**
 * Overlay sheet for comparing two designs: the old plan in grey behind the new
 * one in black, rooms that changed tinted (green added, red removed, amber
 * moved or resized), with the delta table beside it. This is the drawing half
 * of the compare the specification asks for; the numbers are in compare.ts.
 */
import { boundaryToRect, rectDepth, rectWidth, type Rect } from "../model/geometry.js";
import type { Project, Room } from "../model/schema.js";
import { formatFtIn } from "../model/units.js";
import { clearRect, deriveWalls, roomRect } from "../model/walls.js";
import type { Comparison } from "../store/compare.js";
import { sheetFrame, SMALL, TEXT, titleBlock } from "./frame.js";
import type { Item, Sheet } from "./sheet.js";

const ADDED = "#2e7d32";
const REMOVED = "#c0392b";
const CHANGED = "#b26a00";
const OLD = "#9a9a9a";

export interface OverlayOptions {
  /** Level to draw. Default: the first level both designs have. */
  levelId?: string;
  labels?: { a: string; b: string };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  return !!a && !!b && a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
}

/** A room's status between the two designs, matched by id and then by name on the same level. */
function match(a: Project, b: Project, room: Room): Room | undefined {
  return b.rooms.find((r) => r.id === room.id) ?? b.rooms.find((r) => r.level === room.level && r.name === room.name && !a.rooms.some((x) => x.id === r.id));
}

/**
 * The two plans on one sheet. `before` is drawn as a dashed grey outline,
 * `after` solid, so what moved reads at a glance.
 */
export function overlaySheet(before: Project, after: Project, opts: OverlayOptions = {}): Sheet {
  const levelId = opts.levelId ?? after.levels.find((l) => before.levels.some((x) => x.id === l.id))?.id ?? after.levels[0]!.id;
  const levelName = after.levels.find((l) => l.id === levelId)?.name ?? levelId;
  const labels = opts.labels ?? { a: "Before", b: "After" };
  const fr = sheetFrame(after, { showSetbacks: false });
  const { items, box, text, P } = fr;
  const wallsA = deriveWalls(before, levelId);
  const wallsB = deriveWalls(after, levelId);
  const roomsA = before.rooms.filter((r) => r.level === levelId && boundaryToRect(r.boundary));
  const roomsB = after.rooms.filter((r) => r.level === levelId && boundaryToRect(r.boundary));

  const tint = (r: Rect, colour: string) => items.push({ kind: "rect", ...box(r), fill: colour, stroke: "none" });

  // Removed rooms, then the old outlines
  for (const room of roomsA) {
    const now = match(before, after, room);
    if (!now || now.level !== levelId) tint(clearRect(wallsA, room), "#fbe4e0");
    else if (!sameRect(roomRect(room), roomRect(now))) tint(clearRect(wallsA, room), "#f7f1e2");
  }
  for (const room of roomsA) items.push({ kind: "rect", ...box(roomRect(room)), stroke: OLD, sw: 18, dash: [240, 140] });

  // New and changed rooms on top
  for (const room of roomsB) {
    const was = match(after, before, room);
    const changed = !was || was.level !== levelId || !sameRect(roomRect(was), roomRect(room));
    if (!was) tint(clearRect(wallsB, room), "#e3f1e4");
    items.push({ kind: "rect", ...box(roomRect(room)), stroke: changed ? (was ? CHANGED : ADDED) : "#000", sw: changed ? 30 : 18 });
    if (!changed) continue;
    const c = clearRect(wallsB, room);
    const [cx, cy] = P((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
    text([cx, cy - SMALL], room.name.toUpperCase(), SMALL, { bold: true, fill: was ? CHANGED : ADDED });
    text([cx, cy + SMALL * 0.2], `${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))}`, SMALL, { fill: was ? CHANGED : ADDED });
    if (was) {
      const w = clearRect(wallsA, was);
      text([cx, cy + SMALL * 1.4], `was ${formatFtIn(rectWidth(w))} × ${formatFtIn(rectDepth(w))}`, SMALL, { fill: OLD });
    }
  }
  for (const room of roomsA)
    if (!match(before, after, room)) {
      const c = clearRect(wallsA, room);
      const [cx, cy] = P((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
      text([cx, cy - SMALL * 0.4], room.name.toUpperCase(), SMALL, { bold: true, fill: REMOVED });
      text([cx, cy + SMALL * 0.8], "removed", SMALL, { fill: REMOVED });
    }

  // Legend
  const lx = fr.X(fr.plot.x1) + 400;
  const ly = fr.Y(fr.plot.y1) + 400;
  [
    [ADDED, `added in ${labels.b}`],
    [CHANGED, "moved or resized"],
    [REMOVED, `only in ${labels.a}`],
    [OLD, `${labels.a} outline`],
  ].forEach(([colour, label], i) => {
    items.push({ kind: "rect", x: lx, y: ly + i * 380 - 80, w: 320, h: 160, fill: colour as string });
    items.push({ kind: "text", at: [lx + 420, ly + i * 380 + 40], text: label as string, size: SMALL, align: "start" });
  });

  return fr.finish(`${levelName}: ${labels.a} compared with ${labels.b}`, `Solid lines and labels are ${labels.b}; dashed grey is ${labels.a}. Sizes are clear internal dimensions.`);
}

/** The delta table as its own sheet, to follow the overlay. */
export function comparisonSheet(c: Comparison, project: Project): Sheet {
  const W = 297 * 100;
  const H = 210 * 100;
  const items: Item[] = [];
  const left = 2000;
  let y = 3000;
  const row = (cells: string[], bold = false, fill?: string) => {
    const widths = [8000, 5500, 5500, 5000];
    let x = left;
    cells.forEach((cell, i) => {
      items.push({ kind: "text", at: [x, y], text: cell, size: TEXT, align: "start", bold, ...(fill ? { fill } : {}) });
      x += widths[i] ?? 5000;
    });
    y += TEXT * 2;
  };
  row([`${c.a} compared with ${c.b}`], true);
  y += TEXT;
  row(["", c.a, c.b, "Change"], true);
  for (const m of c.metrics) row([m.name, m.a, m.b, m.change], false, m.change ? CHANGED : undefined);
  y += TEXT * 1.5;
  row(["Room", c.a, c.b, ""], true);
  for (const r of c.rooms.filter((r) => r.change !== "same")) {
    if (y > H - 3000) break;
    row([`${r.room} (${r.level})`, r.a ?? "—", r.b ?? "—", r.change], false, r.change === "added" ? ADDED : r.change === "removed" ? REMOVED : CHANGED);
  }
  return titleBlock(items, W, H, project, "Comparison", "Figures are from the model; costs are indicative.", { north: false, scaleText: "" });
}
