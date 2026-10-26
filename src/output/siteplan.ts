/**
 * Site plan: the plot with roads, setbacks, kept and removed trees, the
 * ground footprint, upper-floor outlines, stairs, the column grid and a short
 * area statement.
 */
import { builtUpArea, outerRect, plotArea } from "../model/areas.js";
import type { Rect } from "../model/geometry.js";
import type { Project } from "../model/schema.js";
import { sqmToSqft } from "../model/units.js";
import { drawStair, drawStructure, drawTree, sheetFrame, SMALL, TEXT } from "./frame.js";
import type { Pt, Sheet } from "./sheet.js";

export function siteplanSheet(project: Project): Sheet {
  const fr = sheetFrame(project);
  const { items, plot, P, text } = fr;
  const [lowest, ...upper] = project.levels;
  const rectsOn = (id: string) => project.rooms.filter((r) => r.level === id).map(outerRect).filter((r): r is Rect => r !== null);

  for (const t of project.trees) drawTree(fr, t);

  // Ground footprint, solid; upper floors as dashed outlines
  if (lowest) {
    const ground = rectsOn(lowest.id);
    for (const r of ground) items.push({ kind: "rect", ...fr.box(r), fill: "#d6d6d6" });
    for (const [a, b] of unionOutline(ground)) items.push({ kind: "line", a: P(a[0], a[1]), b: P(b[0], b[1]), stroke: "#000", sw: 35 });
  }
  upper.forEach((level, i) => {
    for (const [a, b] of unionOutline(rectsOn(level.id))) items.push({ kind: "line", a: P(a[0], a[1]), b: P(b[0], b[1]), stroke: "#000", sw: 15, dash: [150 + i * 60, 90] });
  });
  for (const s of project.stairs.filter((s) => s.fromLevel === lowest?.id)) drawStair(fr, project, s, "UP");
  drawStructure(fr, project, null);

  // Area statement under the plot
  const plotSqm = plotArea(project);
  const floors = project.levels.map((l) => ({ name: l.name, kind: l.kind, sqm: builtUpArea(project.rooms.filter((r) => r.level === l.id)) }));
  const total = floors.filter((x) => x.kind !== "stilt").reduce((s, x) => s + x.sqm, 0);
  const coverage = floors[0] ? (floors[0].sqm / plotSqm) * 100 : 0;
  const sq = (m2: number) => `${m2.toFixed(1)} m² (${Math.round(sqmToSqft(m2))} sq ft)`;
  const y0 = plot.y0 - 700;
  const cx = (plot.x0 + plot.x1) / 2;
  const line = (i: number, s: string, bold = false) => text(P(cx, y0 - i * 330), s, i === 0 ? TEXT : SMALL, { bold });
  line(0, "AREA STATEMENT", true);
  line(1, `Plot ${sq(plotSqm)} · Built-up ${floors.map((x) => `${x.name} ${x.sqm.toFixed(1)}`).join(", ")} m²`);
  line(2, `Total ${sq(total)} · FSI ${(total / plotSqm).toFixed(2)} · Ground coverage ${coverage.toFixed(0)}%`);

  // Legend
  const lg: Pt = [600, 700];
  const legend: [string, () => void][] = [
    ["Ground floor footprint", () => items.push({ kind: "rect", x: lg[0], y: lg[1] - 90, w: 400, h: 180, fill: "#d6d6d6", stroke: "#000", sw: 20 })],
    ["Upper floor outline", () => items.push({ kind: "line", a: [lg[0], lg[1] + 450], b: [lg[0] + 400, lg[1] + 450], stroke: "#000", sw: 15, dash: [150, 90] })],
    ["Tree canopy / root zone", () => items.push({ kind: "circle", c: [lg[0] + 200, lg[1] + 900], r: 140, stroke: "#2e7d32", sw: 20, dash: [100, 60] })],
  ];
  legend.forEach(([label, draw], i) => {
    draw();
    items.push({ kind: "text", at: [lg[0] + 500 + label.length * 45, lg[1] + i * 450], text: label, size: SMALL - 20 });
  });

  return fr.finish("Site plan", "Trees, setbacks and footprint from the design model. Verify boundaries and trees against a site survey.");
}

/** Outline segments of a union of rectangles: the parts of each edge with nothing on its outer side. */
export function unionOutline(rects: Rect[]): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  const inside = (x: number, y: number) => rects.some((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1);
  for (const r of rects) {
    const edges: { a: Pt; b: Pt; normal: Pt }[] = [
      { a: [r.x0, r.y0], b: [r.x1, r.y0], normal: [0, -1] },
      { a: [r.x0, r.y1], b: [r.x1, r.y1], normal: [0, 1] },
      { a: [r.x0, r.y0], b: [r.x0, r.y1], normal: [-1, 0] },
      { a: [r.x1, r.y0], b: [r.x1, r.y1], normal: [1, 0] },
    ];
    for (const e of edges) {
      const horiz = e.a[1] === e.b[1];
      const lo = horiz ? e.a[0] : e.a[1];
      const hi = horiz ? e.b[0] : e.b[1];
      const cuts = [...new Set([lo, hi, ...rects.flatMap((o) => (horiz ? [o.x0, o.x1] : [o.y0, o.y1])).filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const m = (cuts[i]! + cuts[i + 1]!) / 2;
        const px = horiz ? m : e.a[0];
        const py = horiz ? e.a[1] : m;
        // Outer side free, and not double-counted by an identical edge of a neighbour
        if (inside(px + e.normal[0], py + e.normal[1]) || !inside(px - e.normal[0], py - e.normal[1])) continue;
        out.push(horiz ? [[cuts[i]!, e.a[1]], [cuts[i + 1]!, e.a[1]]] : [[e.a[0], cuts[i]!], [e.a[0], cuts[i + 1]!]]);
      }
    }
  }
  return out;
}
