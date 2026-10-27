/**
 * Bill of quantities: a quantity takeoff from the design model, priced with
 * the Chennai rate table. Every line keeps the ids of the elements it came
 * from, so "why did masonry go up?" can be traced to the rooms that moved.
 *
 * The takeoff follows a typical framed G+2 house: isolated footings, RCC
 * columns, plinth and floor beams under every wall, slabs over every
 * footprint, 230 mm outer and 115 mm inner brick walls. It is a planning
 * estimate, accurate to perhaps ±15%, not a tender BOQ.
 */
import { catalogueItem } from "../catalogue/catalogue.js";
import { outerRect, unionArea } from "../model/areas.js";
import { boundaryToRect, rectDepth, rectWidth, type Rect } from "../model/geometry.js";
import type { Finding, MepKind, Project, RoomType } from "../model/schema.js";
import { sqmToSqft } from "../model/units.js";
import { levelIndex, proposeColumns, stairLayout } from "../model/structure.js";
import { clearRect, deriveWalls, resolveOpening } from "../model/walls.js";
import { flooringRows, type Table } from "../output/schedules.js";
import { areaStatement, flatCosts } from "../model/flats.js";
import { CONTINGENCY, MARGIN, RATE_TABLE_VERSION, rateFor, RATES, type Unit } from "./rates.js";

export interface BoqLine {
  /** Rate code, or a catalogue id for priced products. */
  code: string;
  trade: string;
  description: string;
  unit: Unit;
  qty: number;
  rate: number;
  amount: number;
  /** True when the project overrides the table rate. */
  overridden: boolean;
  /** Element ids the quantity was measured from. */
  sources: string[];
}

export interface FurnitureLine {
  id: string;
  name: string;
  room: string;
  amount: number;
}

export interface Boq {
  lines: BoqLine[];
  subtotal: number;
  margin: number;
  contingency: number;
  /** Construction total including margin and contingency. */
  total: number;
  /** Furniture and appliances the owner buys, kept out of the construction total. */
  furniture: FurnitureLine[];
  furnitureTotal: number;
  /** Total built-up area across all levels, m². */
  builtUpSqm: number;
  perSqft: number;
  rateTable: string;
  assumptions: string[];
}

/** Section and depth assumptions, mm. */
const BEAM = { width: 230, depthBelowSlab: 300 };
const PLINTH = { height: 450, beamDepth: 450, pcc: 100 };
const FOOTING = { depth: 450, digDepth: 1800, workingSpace: 600, pcc: 100, belowPlinth: 1500 };
const LINTEL = { bearing: 150, depth: 150 };
const COLUMN_SIZE = { width: 230, depth: 300 };
const PARAPET_MM = 1000;
const TOILET_DADO_MM = 2100;
const STAIR_WAIST_MM = 150;
/** Reinforcement, kg per m³ of concrete. */
const STEEL: Record<string, number> = { "RC-01": 80, "RC-02": 180, "RC-03": 150, "RC-04": 90, "RC-05": 100 };
/** Electrical points by room type, a common Chennai allowance. */
const POINTS: Partial<Record<RoomType, number>> & { default: number } = {
  living: 12,
  dining: 6,
  kitchen: 12,
  bedroom: 10,
  toilet: 4,
  puja: 3,
  study: 8,
  utility: 4,
  store: 2,
  balcony: 2,
  "sit-out": 3,
  "car-porch": 3,
  default: 3,
};

const mid = (band: [number, number]) => (band[0] + band[1]) / 2;

/** Rate code for each kind of electrical or plumbing point. */
const MEP_RATE: Partial<Record<MepKind, string>> = {
  light: "EL-03",
  fan: "EL-03",
  switchboard: "EL-03",
  exhaust: "EL-03",
  "socket-6a": "EL-05",
  tv: "EL-05",
  data: "EL-05",
  "socket-16a": "EL-04",
  ac: "EL-04",
  geyser: "EL-04",
  "water-cold": "PB-04",
  "water-hot": "PB-04",
  drain: "PB-05",
  "floor-trap": "PB-05",
  "wc-outlet": "PB-05",
};
const m = (mm: number) => mm / 1000;

/** Total area of the overlap of two sets of rectangles, mm². */
function overlapOfUnions(a: Rect[], b: Rect[]): number {
  const cuts: Rect[] = [];
  for (const p of a)
    for (const q of b) {
      const r = { x0: Math.max(p.x0, q.x0), y0: Math.max(p.y0, q.y0), x1: Math.min(p.x1, q.x1), y1: Math.min(p.y1, q.y1) };
      if (r.x1 > r.x0 && r.y1 > r.y0) cuts.push(r);
    }
  return unionArea(cuts);
}

class Takeoff {
  private qty = new Map<string, { qty: number; sources: Set<string>; label?: { trade: string; description: string; unit: Unit; rate: number } }>();

  add(code: string, qty: number, sources: Iterable<string>): void {
    if (!(qty > 0)) return;
    const e = this.qty.get(code) ?? { qty: 0, sources: new Set<string>() };
    e.qty += qty;
    for (const s of sources) e.sources.add(s);
    this.qty.set(code, e);
  }

  /** A catalogue product priced from its band rather than the rate table. */
  addProduct(code: string, trade: string, description: string, unit: Unit, rate: number, qty: number, sources: Iterable<string>): void {
    this.add(code, qty, sources);
    this.qty.get(code)!.label ??= { trade, description, unit, rate };
  }

  lines(overrides: Record<string, number>): BoqLine[] {
    const order = (code: string) => {
      const i = RATES.findIndex((r) => r.code === code);
      return i >= 0 ? i : RATES.findIndex((r) => r.trade === this.qty.get(code)?.label?.trade) + 0.5;
    };
    return [...this.qty.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
      .map(([code, e]) => {
        const base = rateFor(code) ?? e.label!;
        const rate = overrides[code] ?? base.rate;
        const qty = Math.round(e.qty * 100) / 100;
        return { code, trade: base.trade, description: base.description, unit: base.unit, qty, rate, amount: Math.round(qty * rate), overridden: code in overrides, sources: [...e.sources].sort() };
      });
  }
}

export function computeBoq(project: Project): Boq {
  const t = new Takeoff();
  const assumptions: string[] = [];
  const roomLevels = project.levels.filter((l) => project.rooms.some((r) => r.level === l.id));
  const roomsOn = (id: string) => project.rooms.filter((r) => r.level === id && boundaryToRect(r.boundary));
  const ground = roomLevels[0];
  const steel = (code: string, m3: number, sources: Iterable<string>) => t.add("ST-01", m3 * (STEEL[code] ?? 0), sources);
  const concrete = (code: string, m3: number, sources: string[]) => {
    t.add(code, m3, sources);
    steel(code, m3, sources);
  };

  let builtUp = 0;
  const footprints = new Map<string, Rect[]>();
  for (const level of roomLevels) {
    const rooms = roomsOn(level.id);
    const rects = rooms.map(outerRect).filter((r): r is Rect => r !== null);
    footprints.set(level.id, rects);
    builtUp += unionArea(rects) / 1e6;
  }

  // Substructure: columns, footings, plinth beams and filling
  const levelsUp = (fromIdx: number, toIdx: number) => project.levels.slice(fromIdx, toIdx + 1).reduce((s, l) => s + l.floorToFloor, 0);
  const columns: { id: string; w: number; d: number; height: number; storeys: number; footing: boolean }[] = [];
  if (project.columns.length) {
    for (const c of project.columns) {
      const a = levelIndex(project, c.fromLevel);
      const b = levelIndex(project, c.toLevel);
      columns.push({ id: c.id, w: c.width, d: c.depth, height: levelsUp(a, b) + (a === 0 ? FOOTING.belowPlinth : 0), storeys: b - a + 1, footing: a === 0 });
    }
  } else if (ground) {
    const top = levelIndex(project, roomLevels[roomLevels.length - 1]!.id);
    const pts = proposeColumns(project, roomLevels.map((l) => l.id), project.prefs.maxSpanMm);
    for (const _ of pts) columns.push({ id: "", w: COLUMN_SIZE.width, d: COLUMN_SIZE.depth, height: levelsUp(0, top) + FOOTING.belowPlinth, storeys: top + 1, footing: true });
    if (pts.length) assumptions.push(`No columns placed yet, so ${pts.length} columns of ${COLUMN_SIZE.width} × ${COLUMN_SIZE.depth} mm are assumed at wall junctions.`);
  }
  for (const c of columns) {
    const src = c.id ? [c.id] : [];
    concrete("RC-02", m(c.w) * m(c.d) * m(c.height), src);
    if (!c.footing) continue;
    // Footing side grows with the floors it carries: 1.2 m for one, 1.8 m for three
    const side = 0.9 + 0.3 * c.storeys;
    concrete("RC-01", side * side * m(FOOTING.depth), src);
    t.add("CC-01", (side + 0.2) ** 2 * m(FOOTING.pcc), src);
    t.add("EW-01", (side + m(FOOTING.workingSpace)) ** 2 * m(FOOTING.digDepth), src);
  }
  if (columns.length) assumptions.push(`Footings are isolated pads, 1.2 m square for one floor plus 0.3 m per extra floor, ${m(FOOTING.digDepth)} m deep in ordinary soil; the engineer sizes them from a soil test.`);

  if (ground) {
    const area = unionArea(footprints.get(ground.id)!) / 1e6;
    const ids = roomsOn(ground.id).map((r) => r.id);
    t.add("EW-02", area * m(PLINTH.height), ids);
    t.add("CC-01", area * m(PLINTH.pcc), ids);
    const walls = deriveWalls(project, ground.id);
    for (const w of walls) concrete("RC-03", m(w.to - w.from) * m(BEAM.width) * m(PLINTH.beamDepth), w.sourceRooms);
  }

  // Superstructure, level by level
  for (const [i, level] of roomLevels.entries()) {
    const rooms = roomsOn(level.id);
    const walls = deriveWalls(project, level.id);
    const masonryH = level.floorToFloor - level.slabThickness - BEAM.depthBelowSlab;
    const clearH = level.floorToFloor - level.slabThickness;
    const rects = footprints.get(level.id)!;
    const ids = rooms.map((r) => r.id);

    // Slab and beams over this level
    concrete("RC-04", (unionArea(rects) / 1e6) * m(level.slabThickness), ids);
    for (const w of walls) concrete("RC-03", m(w.to - w.from) * m(BEAM.width) * m(BEAM.depthBelowSlab), w.sourceRooms);

    // Openings cut from the wall that holds them
    const cut = new Map<string, number>();
    const openings = project.openings.filter((o) => rooms.some((r) => r.id === o.host.room));
    for (const o of openings) {
      const res = resolveOpening(project, walls, o);
      if (!res?.wall) continue;
      const area = m(o.width) * m(Math.min(o.height, masonryH));
      cut.set(res.wall.id, (cut.get(res.wall.id) ?? 0) + area);
      concrete("RC-03", m(o.width + 2 * LINTEL.bearing) * m(res.wall.thickness) * m(LINTEL.depth), [o.id]);
    }
    let extFace = 0;
    for (const w of walls) {
      const face = m(w.to - w.from) * m(masonryH) - (cut.get(w.id) ?? 0);
      if (w.isExternal) {
        t.add("BW-01", face * m(w.thickness), w.sourceRooms);
        extFace += m(w.to - w.from) * m(level.floorToFloor) - (cut.get(w.id) ?? 0);
      } else t.add("BW-02", face, w.sourceRooms);
    }
    t.add("PL-02", extFace, ids);
    t.add("PT-02", extFace, ids);

    // Inside faces: each room's clear perimeter to the ceiling, the ceiling itself, less openings on its sides
    for (const room of rooms) {
      const c = clearRect(walls, room);
      const through = project.openings.filter((o) => {
        if (o.host.room === room.id) return true;
        const res = resolveOpening(project, walls, o);
        return res?.otherRoom === room.id && rooms.some((r) => r.id === o.host.room);
      });
      const holes = through.reduce((s, o) => s + m(o.width) * m(Math.min(o.height, clearH)), 0);
      const perimeter = 2 * (m(rectWidth(c)) + m(rectDepth(c)));
      const ceiling = m(rectWidth(c)) * m(rectDepth(c));
      const wallFace = Math.max(0, perimeter * m(clearH) - holes);
      t.add("PL-01", wallFace + ceiling, [room.id]);
      if (room.type === "toilet") {
        const doors = through.filter((o) => o.type === "door" || o.type === "opening").reduce((s, o) => s + m(o.width), 0);
        t.add("FL-03", Math.max(0, (perimeter - doors) * m(TOILET_DADO_MM)), [room.id]);
        t.add("PT-01", Math.max(0, wallFace - (perimeter - doors) * m(TOILET_DADO_MM)) + ceiling, [room.id]);
        t.add("WP-01", ceiling, [room.id]);
      } else t.add("PT-01", wallFace + ceiling, [room.id]);
      if (!project.mep.length) t.add("EL-01", POINTS[room.type] ?? POINTS.default, [room.id]);
      if (room.type === "toilet") t.add("PB-01", 1, [room.id]);
      if (room.type === "kitchen") t.add("PB-02", 1, [room.id]);
    }

    // Doors and windows
    for (const o of openings) {
      const cat = o.catalogue ? catalogueItem(o.catalogue) : undefined;
      if (cat) t.addProduct(cat.id, "Doors and windows", cat.name, "no.", mid(cat.priceInr), 1, [o.id]);
      else if (o.type === "door") t.add("JN-01", 1, [o.id]);
      else if (o.type === "window" || o.type === "ventilator") t.add("JN-02", m(o.width) * m(o.height), [o.id]);
    }

    // Roof exposed to the sky: this footprint less what the next level covers
    const above = roomLevels[i + 1];
    const covered = above ? overlapOfUnions(rects, footprints.get(above.id)!) : 0;
    const exposed = (unionArea(rects) - covered) / 1e6;
    t.add("WP-01", exposed, ids);
    if (!above) {
      const parapet = walls.filter((w) => w.isExternal).reduce((s, w) => s + m(w.to - w.from), 0) * m(PARAPET_MM);
      t.add("BW-02", parapet, ids);
      t.add("PL-02", 2 * parapet, ids);
      t.add("PT-02", 2 * parapet, ids);
    }
  }
  if (roomLevels.length) assumptions.push(`Walls are brick, 230 mm outside and 115 mm inside, between ${BEAM.width} × ${BEAM.depthBelowSlab} mm beams under every wall; a ${PARAPET_MM} mm parapet edges the top roof.`);

  // Stairs: waist slab, steps and landing, with a railing along each flight
  for (const st of project.stairs) {
    const lay = stairLayout(project, st);
    if (!lay) continue;
    let vol = 0;
    let rail = 0;
    for (const f of lay.flights) {
      const run = m((f.risers - 1) * st.tread);
      const rise = m(f.risers * lay.riserHeight);
      const slope = Math.hypot(run, rise);
      vol += slope * m(lay.flightWidth) * m(STAIR_WAIST_MM) + f.risers * 0.5 * m(st.tread) * m(lay.riserHeight) * m(lay.flightWidth);
      rail += slope;
    }
    if (lay.landing) vol += (m(rectWidth(lay.landing)) * m(rectDepth(lay.landing))) * m(STAIR_WAIST_MM);
    concrete("RC-05", vol, [st.id]);
    t.add("RL-01", rail, [st.id]);
  }

  // Floor finishes from the flooring schedule, priced per m² laid
  for (const row of flooringRows(project)) {
    const cat = catalogueItem(row.finishId)!;
    t.addProduct(cat.id, "Flooring", `${cat.name}, laid`, "m²", mid(cat.priceInr), row.areaSqm, [row.roomId]);
    t.add("FL-02", row.skirtingM, [row.roomId]);
  }

  // Lifts, shafts and ducts: enclosure walls over their full height, and the lift itself per stop
  for (const c of project.cores) {
    const r = boundaryToRect(c.boundary);
    const a = levelIndex(project, c.fromLevel);
    const b = levelIndex(project, c.toLevel);
    if (!r || a < 0 || b < 0) continue;
    const height = levelsUp(a, b);
    t.add("LF-02", 2 * (m(rectWidth(r)) + m(rectDepth(r))) * m(height), [c.id]);
    if (c.kind === "lift") t.add("LF-01", b - a + 1, [c.id]);
  }

  // Compound wall along the chosen plot sides
  const cw = project.plot.compoundWall;
  if (cw?.sides.length) {
    const plot = boundaryToRect(project.plot.boundary);
    if (plot) {
      const len = cw.sides.reduce((s, side) => s + (side === "north" || side === "south" ? rectWidth(plot) : rectDepth(plot)), 0);
      t.add("CW-01", m(len) * (cw.heightMm / 1800), ["plot"]);
      assumptions.push(`Compound wall priced per metre for a 1.8 m wall, scaled to ${m(cw.heightMm)} m.`);
    }
  }

  // Electrical and plumbing points from the layout when there is one; otherwise the per-room estimate above stands
  if (project.mep.length) {
    for (const pt of project.mep) {
      const code = MEP_RATE[pt.kind];
      if (code) t.add(code, 1, [pt.id, pt.room]);
    }
    const stacks = project.mep.filter((pt) => pt.kind === "stack");
    for (const st of stacks) {
      const room = project.rooms.find((r) => r.id === st.room);
      const lv = project.levels.find((l) => l.id === room?.level);
      if (lv) t.add("PB-06", m(lv.floorToFloor), [st.id]);
    }
  }

  // Chosen wall and ceiling finishes, priced extra over the standard emulsion and wall tile already counted
  const PAINT_BASE = rateFor("PT-01")!.rate;
  const DADO_BASE = rateFor("FL-03")!.rate;
  for (const room of project.rooms) {
    const lv = project.levels.find((l) => l.id === room.level);
    const wall = room.finishes.wall ? catalogueItem(room.finishes.wall) : undefined;
    const ceiling = room.finishes.ceiling ? catalogueItem(room.finishes.ceiling) : undefined;
    if (!lv || (!wall && !ceiling) || !boundaryToRect(room.boundary)) continue;
    const c = clearRect(deriveWalls(project, room.level), room);
    const perimeter = 2 * (m(rectWidth(c)) + m(rectDepth(c)));
    if (wall?.category === "paint" && mid(wall.priceInr) > PAINT_BASE)
      t.addProduct(wall.id, "Painting", `${wall.name}, extra over standard emulsion`, "m²", mid(wall.priceInr) - PAINT_BASE, perimeter * m(lv.floorToFloor - lv.slabThickness), [room.id]);
    if (wall?.category === "wall-tile") {
      // Toilets already carry a standard dado to 2.1 m; elsewhere it is a 600 mm splash band over the counter
      const dadoed = room.type === "toilet";
      const rate = dadoed ? mid(wall.priceInr) - DADO_BASE : mid(wall.priceInr);
      if (rate > 0) t.addProduct(wall.id, "Flooring", `${wall.name}${dadoed ? ", extra over standard wall tile" : ", splash band"}`, "m²", rate, perimeter * m(dadoed ? TOILET_DADO_MM : 600), [room.id]);
    }
    if (ceiling && ceiling.id !== "ceiling.paint-white@1")
      t.addProduct(ceiling.id, "Ceilings", ceiling.name, "m²", mid(ceiling.priceInr), m(rectWidth(c)) * m(rectDepth(c)), [room.id]);
  }

  // Services
  if (project.rooms.length) {
    t.add("EL-02", 1, []);
    t.add("PB-03", 1, []);
  }

  const lines = t.lines(project.prefs.rates ?? {});
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const margin = Math.round(subtotal * MARGIN);
  const contingency = Math.round(subtotal * CONTINGENCY);
  const total = subtotal + margin + contingency;

  const furniture: FurnitureLine[] = project.items.flatMap((it) => {
    const cat = catalogueItem(it.catalogue);
    if (!cat || cat.category === "sanitary" || cat.category === "vehicle") return [];
    return [{ id: it.id, name: cat.name, room: project.rooms.find((r) => r.id === it.room)?.name ?? it.room, amount: Math.round(mid(cat.priceInr)) }];
  });
  if (project.items.some((it) => catalogueItem(it.catalogue)?.category === "sanitary")) assumptions.push("Sanitaryware is priced inside the toilet plumbing sets.");

  return {
    lines,
    subtotal,
    margin,
    contingency,
    total,
    furniture,
    furnitureTotal: furniture.reduce((s, f) => s + f.amount, 0),
    builtUpSqm: builtUp,
    perSqft: builtUp ? Math.round(total / sqmToSqft(builtUp)) : 0,
    rateTable: RATE_TABLE_VERSION,
    assumptions,
  };
}

/**
 * Money the way Chennai talks about it: lakh and crore. `currency` is "₹"
 * on screen and "Rs" on PDF sheets, whose fonts have no rupee sign.
 */
export function formatInr(n: number, currency = "₹"): string {
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}${currency}${(a / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `${sign}${currency}${(a / 1e5).toFixed(1)} lakh`;
  return `${sign}${currency}${Math.round(a).toLocaleString("en-IN")}`;
}

export interface CostDelta {
  before: number;
  after: number;
  delta: number;
  /** Lines whose amount changed, largest change first. */
  lines: { code: string; description: string; delta: number }[];
}

/** What an edit did to the construction estimate, line by line. */
export function costDelta(before: Project, after: Project): CostDelta {
  const a = computeBoq(before);
  const b = computeBoq(after);
  const was = new Map(a.lines.map((l) => [l.code, l]));
  const now = new Map(b.lines.map((l) => [l.code, l]));
  const lines = [...new Set([...was.keys(), ...now.keys()])]
    .map((code) => ({ code, description: (now.get(code) ?? was.get(code))!.description, delta: (now.get(code)?.amount ?? 0) - (was.get(code)?.amount ?? 0) }))
    .filter((l) => l.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { before: a.total, after: b.total, delta: b.total - a.total, lines };
}

/** The estimate as a schedule table, grouped by trade, for the PDF and CSV. Amounts in rupees with Indian grouping. */
export function boqTable(project: Project, boq = computeBoq(project)): Table {
  const n = (v: number) => Math.round(v).toLocaleString("en-IN");
  const rows: string[][] = [];
  let trade = "";
  for (const l of boq.lines) {
    if (l.trade !== trade) rows.push(["", (trade = l.trade).toUpperCase(), "", "", "", ""]);
    rows.push([l.code.includes("@") ? "" : l.code, l.description, l.qty.toLocaleString("en-IN", { maximumFractionDigits: 2 }), l.unit === "m³" ? "cu m" : l.unit === "m²" ? "sq m" : l.unit, n(l.rate) + (l.overridden ? " *" : ""), n(l.amount)]);
  }
  rows.push(
    ["", "Subtotal", "", "", "", n(boq.subtotal)],
    ["", `Contractor's margin ${Math.round(MARGIN * 100)}%`, "", "", "", n(boq.margin)],
    ["", `Contingency ${Math.round(CONTINGENCY * 100)}%`, "", "", "", n(boq.contingency)],
    ["", `Construction total (${n(boq.perSqft)} per sq ft built-up)`, "", "", "", n(boq.total)],
  );
  if (boq.furnitureTotal) rows.push(["", "Furniture and appliances (owner's purchase, separate)", "", "", "", n(boq.furnitureTotal)]);
  return { title: `Cost estimate (INR, ${boq.rateTable})`, head: ["Code", "Item", "Qty", "Unit", "Rate", "Amount"], numeric: [2, 4, 5], rows };
}

/** A warning when the estimate passes the owner's budget. */
/** Construction cost per flat, shared by super built-up area. */
export function flatCostTable(project: Project, boq = computeBoq(project)): Table {
  const st = areaStatement(project);
  const costs = flatCosts(project, boq, st);
  return {
    title: "Cost per flat",
    head: ["Flat", "Super built-up", "Share of construction", "Per sq ft"],
    numeric: [1, 2, 3],
    rows: costs.map((c) => {
      const f = st.flats.find((x) => x.flat === c.flat)!;
      return [c.flat, `${Math.round(sqmToSqft(f.superBuiltUpSqm)).toLocaleString("en-IN")} sq ft`, formatInr(c.amount), formatInr(c.perSqftSuperBuiltUp)];
    }),
  };
}

export function costFindings(project: Project): Finding[] {
  const budget = project.prefs.budgetInr;
  if (!budget || !project.rooms.length) return [];
  const { total } = computeBoq(project);
  if (total <= budget) return [];
  return [{ severity: "warn", code: "cost.over_budget", message: `Estimated construction cost ${formatInr(total)} is over the ${formatInr(budget)} budget by ${formatInr(total - budget)}.`, elements: [], source: "cost" }];
}
