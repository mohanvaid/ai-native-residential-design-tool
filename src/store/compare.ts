/**
 * Side-by-side comparison of two designs (two branches, or two revisions of
 * one): headline numbers, then room by room. Rooms are matched by id, which
 * branches share, and then by name and floor.
 */
import { catalogueItem, defaultFloorFinish } from "../catalogue/catalogue.js";
import { computeBoq, formatInr } from "../cost/boq.js";
import { validate } from "../engine.js";
import { builtUpArea, plotArea } from "../model/areas.js";
import { boundaryToRect, rectArea, rectDepth, rectWidth } from "../model/geometry.js";
import type { Project, Room } from "../model/schema.js";
import { formatFtIn, sqmToSqft } from "../model/units.js";
import { clearRect, deriveWalls } from "../model/walls.js";
import type { Table } from "../output/schedules.js";
import { fsiArea } from "../rules/packs/tncdbr-2019.js";
import { vastuReport } from "../rules/vastu.js";

export interface Metric {
  name: string;
  a: string;
  b: string;
  /** b − a as text, or "" when the same. */
  change: string;
}

export interface RoomDiff {
  level: string;
  room: string;
  a: string | null;
  b: string | null;
  change: "added" | "removed" | "resized" | "moved" | "renamed" | "refinished" | "same";
  /** Floor finish in each, when it changed. */
  floor?: [string, string];
}

export interface Comparison {
  a: string;
  b: string;
  metrics: Metric[];
  rooms: RoomDiff[];
}

interface Facts {
  builtUp: number;
  carpet: number;
  fsi: number;
  coverage: number;
  bedrooms: number;
  toilets: number;
  openings: number;
  cost: number;
  perSqft: number;
  furniture: number;
  blocks: number;
  warns: number;
  vastu: string;
}

function facts(p: Project): Facts {
  let carpet = 0;
  for (const level of p.levels) {
    const walls = deriveWalls(p, level.id);
    for (const r of p.rooms.filter((r) => r.level === level.id && boundaryToRect(r.boundary))) carpet += rectArea(clearRect(walls, r)) / 1e6;
  }
  const boq = computeBoq(p);
  const findings = validate(p);
  const ground = p.levels[0];
  const vastu = p.prefs.vastu === "off" ? null : vastuReport(p);
  return {
    builtUp: p.levels.reduce((s, l) => s + builtUpArea(p.rooms.filter((r) => r.level === l.id)), 0),
    carpet,
    fsi: fsiArea(p) / plotArea(p),
    coverage: ground ? builtUpArea(p.rooms.filter((r) => r.level === ground.id)) / plotArea(p) : 0,
    bedrooms: p.rooms.filter((r) => r.type === "bedroom").length,
    toilets: p.rooms.filter((r) => r.type === "toilet").length,
    openings: p.openings.length,
    cost: boq.total,
    perSqft: boq.perSqft,
    furniture: boq.furnitureTotal,
    blocks: findings.filter((f) => f.severity === "block").length,
    warns: findings.filter((f) => f.severity === "warn").length,
    vastu: vastu ? `${vastu.score} of ${vastu.max}` : "off",
  };
}

function roomSize(p: Project, room: Room): string {
  if (!boundaryToRect(room.boundary)) return "?";
  const c = clearRect(deriveWalls(p, room.level), room);
  return `${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))} (${Math.round(sqmToSqft(rectArea(c) / 1e6))} sq ft)`;
}

const floorFinish = (room: Room) => catalogueItem(room.finishes.floor ?? defaultFloorFinish(room.type))?.name ?? "?";

const signed = (n: number, fmt: (v: number) => string) => (n === 0 ? "" : `${n > 0 ? "+" : "−"}${fmt(Math.abs(n))}`);

export function compareProjects(a: Project, b: Project, labels: { a: string; b: string }): Comparison {
  const fa = facts(a);
  const fb = facts(b);
  const sqft = (v: number) => `${Math.round(sqmToSqft(v))} sq ft`;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const num = (v: number) => String(v);
  const metric = (name: string, x: number, y: number, fmt: (v: number) => string, diff = fmt): Metric => ({ name, a: fmt(x), b: fmt(y), change: Math.round((y - x) * 1000) === 0 ? "" : signed(y - x, diff) });
  const metrics: Metric[] = [
    metric("Built-up area", fa.builtUp, fb.builtUp, sqft),
    metric("Carpet area", fa.carpet, fb.carpet, sqft),
    metric("FSI used", fa.fsi, fb.fsi, (v) => v.toFixed(2)),
    metric("Ground coverage", fa.coverage, fb.coverage, pct),
    metric("Bedrooms", fa.bedrooms, fb.bedrooms, num),
    metric("Toilets", fa.toilets, fb.toilets, num),
    metric("Doors and windows", fa.openings, fb.openings, num),
    metric("Construction cost", fa.cost, fb.cost, (v) => formatInr(v)),
    metric("Cost per sq ft", fa.perSqft, fb.perSqft, (v) => formatInr(v)),
    metric("Furniture", fa.furniture, fb.furniture, (v) => formatInr(v)),
    metric("Must-fix issues", fa.blocks, fb.blocks, num),
    metric("Warnings", fa.warns, fb.warns, num),
  ];
  if (fa.vastu !== "off" || fb.vastu !== "off") metrics.push({ name: "Vastu score", a: fa.vastu, b: fb.vastu, change: fa.vastu === fb.vastu ? "" : "changed" });

  const levelName = (p: Project, id: string) => p.levels.find((l) => l.id === id)?.name ?? id;
  const rooms: RoomDiff[] = [];
  const matched = new Set<string>();
  for (const ra of a.rooms) {
    const rb = b.rooms.find((r) => r.id === ra.id) ?? b.rooms.find((r) => !matched.has(r.id) && r.name === ra.name && levelName(b, r.level) === levelName(a, ra.level));
    if (!rb) {
      rooms.push({ level: levelName(a, ra.level), room: ra.name, a: roomSize(a, ra), b: null, change: "removed" });
      continue;
    }
    matched.add(rb.id);
    const sa = roomSize(a, ra);
    const sb = roomSize(b, rb);
    const fa = floorFinish(ra);
    const fb = floorFinish(rb);
    const change = sa !== sb ? "resized" : JSON.stringify(ra.boundary) !== JSON.stringify(rb.boundary) || ra.level !== rb.level ? "moved" : ra.name !== rb.name ? "renamed" : fa !== fb ? "refinished" : "same";
    rooms.push({ level: levelName(b, rb.level), room: rb.name === ra.name ? rb.name : `${ra.name} → ${rb.name}`, a: sa, b: sb, change, ...(fa !== fb ? { floor: [fa, fb] as [string, string] } : {}) });
  }
  for (const rb of b.rooms.filter((r) => !matched.has(r.id))) rooms.push({ level: levelName(b, rb.level), room: rb.name, a: null, b: roomSize(b, rb), change: "added" });
  const order = new Map([...b.levels, ...a.levels].map((l, i) => [l.name, i]));
  rooms.sort((x, y) => (order.get(x.level) ?? 0) - (order.get(y.level) ?? 0));
  return { a: labels.a, b: labels.b, metrics, rooms };
}

/** The comparison as two tables, for CSV and printable sheets. */
export function comparisonTables(c: Comparison): Table[] {
  return [
    { title: `Compare ${c.a} with ${c.b}`, head: ["", c.a, c.b, "Change"], numeric: [], rows: c.metrics.map((m) => [m.name, m.a, m.b, m.change]) },
    { title: "Rooms", head: ["Floor", "Room", c.a, c.b, "Change"], numeric: [], rows: c.rooms.map((r) => [r.level, r.room, r.a ?? "—", r.b ?? "—", r.floor ? `floor ${r.floor[0]} → ${r.floor[1]}` : r.change === "same" ? "" : r.change]) },
  ];
}

/** A short text version for the chat: what differs, skipping what does not. */
export function comparisonText(c: Comparison): string {
  const lines = [`${c.b} compared with ${c.a}:`];
  const changed = c.metrics.filter((m) => m.change);
  if (!changed.length && c.rooms.every((r) => r.change === "same")) return `${c.b} and ${c.a} are the same design.`;
  for (const m of changed) lines.push(`- ${m.name}: ${m.a} → ${m.b} (${m.change})`);
  for (const r of c.rooms.filter((r) => r.change !== "same")) {
    if (r.change === "added") lines.push(`- Added ${r.room} on ${r.level}, ${r.b}`);
    else if (r.change === "removed") lines.push(`- Removed ${r.room} from ${r.level}`);
    else if (r.change === "resized") lines.push(`- ${r.room} (${r.level}): ${r.a} → ${r.b}`);
    else if (r.floor) lines.push(`- ${r.room} (${r.level}) floor: ${r.floor[0]} → ${r.floor[1]}`);
    else lines.push(`- ${r.room} (${r.level}) ${r.change}`);
  }
  return lines.join("\n");
}
