/**
 * Vastu, opt-in. Off by default (project.prefs.vastu). Each element is
 * scored by the true-north zone it falls in: preferred, acceptable or to
 * avoid. Advisory only: findings are info ("prefer") or warn ("strict") and
 * never block. The zone tables follow common Vastu practice; families and
 * consultants differ, so they are data a project could override later.
 */
import { outerRect } from "../model/areas.js";
import { boundaryToRect, rectArea } from "../model/geometry.js";
import type { Finding, Point, Project, Room } from "../model/schema.js";
import { deriveWalls, resolveOpening } from "../model/walls.js";
import { trueFacing, zoneOf, zoneOfPoint, type Zone } from "../model/zones.js";

interface Preference {
  label: string;
  best: Zone[];
  ok: Zone[];
  avoid: Zone[];
}

export const VASTU: Record<"entrance" | "kitchen" | "master" | "puja" | "toilet" | "stair", Preference> = {
  /** For the entrance, zones are the direction the main door faces. */
  entrance: { label: "Main entrance", best: ["N", "NE", "E"], ok: ["NW", "W"], avoid: ["S", "SW", "SE"] },
  kitchen: { label: "Kitchen", best: ["SE"], ok: ["NW", "E", "S"], avoid: ["NE", "SW", "C"] },
  master: { label: "Master bedroom", best: ["SW"], ok: ["S", "W"], avoid: ["NE", "SE", "C"] },
  puja: { label: "Pooja room", best: ["NE"], ok: ["N", "E"], avoid: ["S", "SW", "SE", "C"] },
  toilet: { label: "Toilet", best: ["NW", "W"], ok: ["S", "SE"], avoid: ["NE", "SW", "C"] },
  stair: { label: "Staircase", best: ["S", "SW", "W"], ok: ["SE", "NW"], avoid: ["NE", "C"] },
};

export interface VastuItem {
  key: keyof typeof VASTU;
  label: string;
  element: string;
  name: string;
  zone: Zone;
  grade: "best" | "ok" | "avoid" | "neutral";
  points: number;
}

export interface VastuReport {
  mode: "off" | "prefer" | "strict";
  items: VastuItem[];
  score: number;
  max: number;
  /** Rooms that block the open centre (brahmasthan). */
  centreBlocked: Room[];
}

const POINTS = { best: 2, ok: 1, neutral: 1, avoid: 0 } as const;

function grade(pref: Preference, zone: Zone): VastuItem["grade"] {
  return pref.best.includes(zone) ? "best" : pref.ok.includes(zone) ? "ok" : pref.avoid.includes(zone) ? "avoid" : "neutral";
}

/** The largest bedroom, or one named "master". */
function masterBedroom(project: Project): Room | undefined {
  const beds = project.rooms.filter((r) => r.type === "bedroom" && boundaryToRect(r.boundary));
  return beds.find((r) => /master/i.test(r.name)) ?? beds.sort((a, b) => rectArea(boundaryToRect(b.boundary)!) - rectArea(boundaryToRect(a.boundary)!))[0];
}

/** The main door: the widest door to the outside on the lowest level. */
function mainDoor(project: Project) {
  const lowest = project.levels[0];
  if (!lowest) return null;
  const walls = deriveWalls(project, lowest.id);
  return (
    project.openings
      .filter((o) => o.type === "door" && project.rooms.find((r) => r.id === o.host.room)?.level === lowest.id)
      .map((o) => resolveOpening(project, walls, o))
      .filter((r) => r && r.otherRoom === null)
      .sort((a, b) => b!.opening.width - a!.opening.width)[0] ?? null
  );
}

export function vastuReport(project: Project): VastuReport {
  const mode = project.prefs.vastu;
  const items: VastuItem[] = [];
  const add = (key: keyof typeof VASTU, element: string, name: string, zone: Zone) => {
    const g = grade(VASTU[key], zone);
    items.push({ key, label: VASTU[key].label, element, name, zone, grade: g, points: POINTS[g] });
  };

  const door = mainDoor(project);
  if (door) add("entrance", door.opening.id, `Main door (${door.opening.id})`, trueFacing(project.plot.northAngle)[door.opening.host.side] as Zone);
  const kitchen = project.rooms.find((r) => r.type === "kitchen");
  if (kitchen) add("kitchen", kitchen.id, kitchen.name, zoneOf(project, kitchen));
  const master = masterBedroom(project);
  if (master) add("master", master.id, master.name, zoneOf(project, master));
  for (const r of project.rooms.filter((r) => r.type === "puja")) add("puja", r.id, r.name, zoneOf(project, r));
  for (const r of project.rooms.filter((r) => r.type === "toilet")) add("toilet", r.id, r.name, zoneOf(project, r));
  for (const s of project.stairs) {
    const r = boundaryToRect(s.boundary);
    if (r) add("stair", s.id, "Staircase", zoneOfPoint(project, [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2] as Point));
  }

  const centreBlocked = project.rooms.filter((r) => (r.type === "toilet" || r.type === "kitchen" || r.type === "staircase") && zoneOf(project, r) === "C" && outerRect(r));
  const score = items.reduce((s, i) => s + i.points, 0);
  return { mode, items, score, max: items.length * 2, centreBlocked };
}

export function vastuFindings(project: Project): Finding[] {
  if (project.prefs.vastu === "off") return [];
  const sev: Finding["severity"] = project.prefs.vastu === "strict" ? "warn" : "info";
  const rep = vastuReport(project);
  const out: Finding[] = [];
  for (const it of rep.items) {
    if (it.grade !== "avoid") continue;
    const p = VASTU[it.key];
    const where = it.key === "entrance" ? `faces ${it.zone}` : `is in the ${it.zone}`;
    out.push({ severity: sev, code: `vastu.${it.key}`, message: `Vastu: ${it.name} ${where}; preferred ${p.best.join("/")}${p.ok.length ? `, acceptable ${p.ok.join("/")}` : ""}.`, elements: [it.element], source: "vastu" });
  }
  for (const r of rep.centreBlocked)
    out.push({ severity: sev, code: "vastu.centre", message: `Vastu: ${r.name} sits in the centre of the plot (brahmasthan), which is kept open.`, elements: [r.id], source: "vastu" });
  out.push({ severity: "info", code: "vastu.score", message: `Vastu score ${rep.score} of ${rep.max} (advisory).`, elements: [], source: "vastu" });
  return out;
}
