/** Plan symbols for placed catalogue items, drawn in the item's own frame and turned to face its way. */
import type { CatalogueItem } from "../catalogue/catalogue.js";
import { OUTWARD } from "../model/geometry.js";
import type { PlacedItem } from "../model/schema.js";
import type { Frame } from "./frame.js";
import type { Item, Pt } from "./sheet.js";

const INK = "#4a4a4a";
const SW = 10;

/** Draws one item. Local frame: u across the item (left to right seen from its front), v from the back (0) to the front (depth). */
export function drawPlacedItem(fr: Frame, it: PlacedItem, cat: CatalogueItem): void {
  const w = cat.width;
  const d = cat.depth;
  const F = OUTWARD[it.facing];
  const R: [number, number] = [-F[1], F[0]];
  const m = it.mirror ? -1 : 1;
  const L = (u: number, v: number): Pt => {
    const x = it.at[0] + F[0] * (v - d / 2) + R[0] * u * m;
    const y = it.at[1] + F[1] * (v - d / 2) + R[1] * u * m;
    return fr.P(x, y);
  };
  const items: Item[] = fr.items;
  const poly = (pts: [number, number][], o: { fill?: string; dash?: number[]; sw?: number } = {}) =>
    items.push({ kind: "poly", pts: pts.map(([u, v]) => L(u, v)), closed: true, stroke: INK, sw: o.sw ?? SW, fill: o.fill ?? "none", ...(o.dash ? { dash: o.dash } : {}) });
  const rect = (u0: number, v0: number, u1: number, v1: number, o: { fill?: string; dash?: number[] } = {}) =>
    poly(
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      o,
    );
  const line = (u0: number, v0: number, u1: number, v1: number, dash?: number[]) => items.push({ kind: "line", a: L(u0, v0), b: L(u1, v1), stroke: INK, sw: SW, ...(dash ? { dash } : {}) });
  const ellipse = (cu: number, cv: number, ru: number, rv: number, fill = "none") =>
    poly(
      Array.from({ length: 20 }, (_, i) => [cu + ru * Math.cos((i / 20) * 2 * Math.PI), cv + rv * Math.sin((i / 20) * 2 * Math.PI)] as [number, number]),
      { fill },
    );
  const label = (s: string) => fr.text(L(0, d / 2), s, 130, { fill: INK, bold: true });
  const W2 = w / 2;

  switch (cat.symbol) {
    case "bed": {
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      const pillows = w >= 1300 ? [-W2 + 80, 40] : [-W2 + 80];
      for (const u0 of pillows) rect(u0, 80, u0 + (w >= 1300 ? W2 - 120 : w - 160), 450);
      line(-W2, d * 0.4, W2, d * 0.4);
      line(-W2, d * 0.4, -W2 + 250, d * 0.4 + 250);
      break;
    }
    case "sofa":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      line(-W2, 200, W2, 200);
      line(-W2 + 150, 200, -W2 + 150, d);
      line(W2 - 150, 200, W2 - 150, d);
      break;
    case "sofa-chaise": {
      const seat = 900;
      const chaise = 750;
      poly(
        [
          [-W2, 0],
          [W2, 0],
          [W2, d],
          [W2 - chaise, d],
          [W2 - chaise, seat],
          [-W2, seat],
        ],
        { fill: "#ffffff" },
      );
      line(-W2, 200, W2 - 150, 200);
      line(-W2 + 150, 200, -W2 + 150, seat);
      line(W2 - 150, 200, W2 - 150, d);
      line(W2 - chaise, seat, W2 - 150, seat);
      break;
    }
    case "table":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      break;
    case "dining": {
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      const n = Math.max(1, Math.round(w / 650));
      for (let i = 0; i < n; i++) {
        const cu = -W2 + (w / n) * (i + 0.5);
        rect(cu - 200, -450, cu + 200, -50);
        rect(cu - 200, d + 50, cu + 200, d + 450);
      }
      if (w >= 1700) {
        rect(-W2 - 450, d / 2 - 200, -W2 - 50, d / 2 + 200);
        rect(W2 + 50, d / 2 - 200, W2 + 450, d / 2 + 200);
      }
      break;
    }
    case "wardrobe": {
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      line(-W2, d - 60, W2, d - 60);
      const doors = Math.max(1, Math.round(w / 450));
      for (let i = 1; i < doors; i++) line(-W2 + (w / doors) * i, d - 60, -W2 + (w / doors) * i, d);
      line(-W2, 0, W2, d - 60, [60, 60]);
      break;
    }
    case "unit":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      line(-W2, d - 60, W2, d - 60);
      break;
    case "desk":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      ellipse(0, d + 280, 220, 220);
      break;
    case "swing":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      line(-W2 + 100, d / 2, W2 - 100, d / 2, [80, 60]);
      rect(-W2, -cat.clearance.back, W2, d + cat.clearance.front, { dash: [120, 80] });
      break;
    case "wc":
      rect(-W2, 0, W2, 180, { fill: "#ffffff" });
      ellipse(0, 180 + (d - 180) / 2, W2 - 20, (d - 180) / 2, "#ffffff");
      break;
    case "wc-indian":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      ellipse(0, d * 0.45, W2 - 90, d * 0.3);
      rect(-W2 + 30, d - 170, -50, d - 40);
      rect(50, d - 170, W2 - 30, d - 40);
      break;
    case "basin":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      ellipse(0, d * 0.55, W2 - 80, d * 0.32);
      break;
    case "shower":
      rect(-W2, 0, W2, d, { dash: [80, 60] });
      line(-W2, 0, W2, d);
      line(W2, 0, -W2, d);
      ellipse(0, d / 2, 60, 60, "#ffffff");
      break;
    case "appliance":
      rect(-W2, 0, W2, d, { fill: "#ffffff" });
      label(cat.id.startsWith("fridge") ? "F" : cat.id.startsWith("washer") ? "WM" : "");
      break;
    case "car": {
      const c = 350;
      poly(
        [
          [-W2 + c, 0],
          [W2 - c, 0],
          [W2, c],
          [W2, d - c * 1.4],
          [W2 - c, d],
          [-W2 + c, d],
          [-W2, d - c * 1.4],
          [-W2, c],
        ],
        { fill: "#ffffff", sw: 15 },
      );
      line(-W2 + 150, d * 0.68, W2 - 150, d * 0.68);
      line(-W2 + 150, d * 0.24, W2 - 150, d * 0.24);
      line(-W2 + 150, d * 0.68, -W2 + 150, d * 0.24);
      line(W2 - 150, d * 0.68, W2 - 150, d * 0.24);
      label(cat.name.toUpperCase());
      break;
    }
    case "scooter":
      ellipse(0, d / 2, W2, d / 2, "#ffffff");
      line(-W2 - 100, d * 0.8, W2 + 100, d * 0.8);
      break;
    case "box":
      rect(-W2, 0, W2, d);
      break;
  }
}
