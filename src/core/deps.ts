/**
 * The dependency graph from model elements to outputs, so an edit regenerates
 * only the drawings, schedules and estimates it can change. Each change in a
 * transaction's ChangeSet is mapped to the levels it touches and from there to
 * output keys; OutputCache keeps the rendered outputs of the last version and
 * re-renders only the affected keys. Sheets that are not affected keep the
 * revision they were last drawn at, as a drawing register would.
 */
import { boqTable, computeBoq } from "../cost/boq.js";
import { catalogueItem } from "../catalogue/catalogue.js";
import { ELECTRICAL } from "../model/mep.js";
import type { Finding, Project, Side } from "../model/schema.js";
import { levelIndex } from "../model/structure.js";
import { validate } from "../engine.js";
import type { ChangeSet } from "../ops/changes.js";
import { elevationSheet, sectionSheet } from "../output/elevation.js";
import { floorPlanSheet } from "../output/floorplan.js";
import { buildScene } from "../output/model3d.js";
import { areaStatementTable, circuitTable, doorWindowTable, electricalTable, finishesTable, flooringTable, furnitureTable, plumbingTable, type Table } from "../output/schedules.js";
import type { Sheet } from "../output/sheet.js";
import { siteplanSheet } from "../output/siteplan.js";

const SIDES: Side[] = ["north", "east", "south", "west"];
const DRAWN_ELSEWHERE = ["site", ...SIDES.map((s) => `elevation:${s}`), "section", "model3d"] as const;
const SCHEDULES = ["schedule:doors", "schedule:flooring", "schedule:finishes", "schedule:furniture", "schedule:areas", "schedule:electrical", "schedule:circuits", "schedule:plumbing", "boq"] as const;

/** Every output key for a project: plans and layouts per level, site, elevations, section, schedules, BOQ, 3D and the checks. */
export function allOutputs(project: Project): string[] {
  return [...project.levels.flatMap((l) => [`plan:${l.id}`, `elec:${l.id}`, `plumb:${l.id}`]), ...DRAWN_ELSEWHERE, ...SCHEDULES, "checks"];
}

/** Output keys a transaction can change. */
export function affectedOutputs(before: Project, after: Project, changes: ChangeSet): Set<string> {
  const out = new Set<string>(["checks"]);
  const all = () => allOutputs(after).forEach((k) => out.add(k));
  const levelsOf = (p: Project, roomId: string | undefined) => {
    const r = roomId ? p.rooms.find((x) => x.id === roomId) : undefined;
    return r ? [r.level] : [];
  };
  const range = (p: Project, from: string, to: string) => {
    const a = levelIndex(p, from);
    const b = levelIndex(p, to);
    return a < 0 || b < 0 ? [] : p.levels.slice(a, b + 1).map((l) => l.id);
  };
  const plans = (levels: string[], layers: ("plan" | "elec" | "plumb")[] = ["plan", "elec", "plumb"]) => {
    for (const l of levels) for (const layer of layers) out.add(`${layer}:${l}`);
  };
  const add = (...keys: string[]) => keys.forEach((k) => out.add(k));
  const elevations = () => add(...SIDES.map((s) => `elevation:${s}`), "section");

  for (const c of changes) {
    switch (c.kind) {
      case "levels":
      case "plot":
      case "rules":
        all();
        break;
      case "prefs": {
        const changed = new Set(Object.keys({ ...c.before, ...c.after }).filter((k) => JSON.stringify((c.before as Record<string, unknown>)[k]) !== JSON.stringify((c.after as Record<string, unknown>)[k])));
        if (changed.has("theme")) add(...SIDES.map((s) => `elevation:${s}`), "model3d");
        if (changed.has("interiorTheme")) add("schedule:finishes");
        if (changed.has("rates") || changed.has("budgetInr")) add("boq");
        break;
      }
      case "room": {
        const levels = [...levelsOf(before, c.id), ...levelsOf(after, c.id)];
        plans(levels);
        add("schedule:areas", "schedule:flooring", "schedule:finishes", "boq");
        const geometry = JSON.stringify(c.before?.boundary) !== JSON.stringify(c.after?.boundary) || c.before?.level !== c.after?.level;
        if (geometry) add(...DRAWN_ELSEWHERE, "schedule:doors", "schedule:furniture", "schedule:electrical", "schedule:circuits", "schedule:plumbing");
        else if (c.before?.type !== c.after?.type) add("model3d", "site");
        break;
      }
      case "opening": {
        const levels = [...levelsOf(before, c.before?.host.room), ...levelsOf(after, c.after?.host.room)];
        plans(levels);
        elevations();
        add("model3d", "schedule:doors", "schedule:flooring", "boq");
        break;
      }
      case "item": {
        const levels = [...levelsOf(before, c.before?.room), ...levelsOf(after, c.after?.room)];
        const services = [c.before, c.after].some((it) => it && catalogueItem(it.catalogue)?.services?.length);
        plans(levels, services ? ["plan", "elec", "plumb"] : ["plan"]);
        add("model3d", "schedule:furniture", "boq", "site");
        break;
      }
      case "mep": {
        const pts = [c.before, c.after].filter((p) => p !== null);
        const levels = [...levelsOf(before, c.before?.room), ...levelsOf(after, c.after?.room)];
        plans(levels, pts.some((p) => ELECTRICAL.has(p.kind)) ? ["elec"] : ["plumb"]);
        add("schedule:electrical", "schedule:circuits", "schedule:plumbing", "boq");
        break;
      }
      case "tree":
        plans(after.levels.map((l) => l.id));
        add("site", ...SIDES.map((s) => `elevation:${s}`), "model3d");
        break;
      case "column": {
        const levels = [...(c.before ? range(before, c.before.fromLevel, c.before.toLevel) : []), ...(c.after ? range(after, c.after.fromLevel, c.after.toLevel) : [])];
        plans(levels);
        add("site", "model3d", "boq");
        break;
      }
      case "stair": {
        const levels = [c.before?.fromLevel, c.before?.toLevel, c.after?.fromLevel, c.after?.toLevel].filter((l): l is string => !!l);
        plans(levels);
        add("site", "section", "model3d", "boq", "schedule:areas");
        break;
      }
      case "core": {
        const levels = [...(c.before ? range(before, c.before.fromLevel, c.before.toLevel) : []), ...(c.after ? range(after, c.after.fromLevel, c.after.toLevel) : [])];
        plans(levels);
        add("site", "model3d", "boq", "schedule:areas", ...SIDES.map((s) => `elevation:${s}`));
        break;
      }
    }
  }
  return out;
}

export type Output = Sheet | Table | ReturnType<typeof buildScene> | Finding[];

/** How each output key is rendered. */
export function renderOutput(project: Project, key: string): Output {
  const [kind, arg] = key.split(":") as [string, string | undefined];
  switch (kind) {
    case "plan":
      return floorPlanSheet(project, arg!);
    case "elec":
      return floorPlanSheet(project, arg!, { layer: "electrical" });
    case "plumb":
      return floorPlanSheet(project, arg!, { layer: "plumbing" });
    case "site":
      return siteplanSheet(project);
    case "elevation":
      return elevationSheet(project, arg as Side);
    case "section":
      return sectionSheet(project);
    case "model3d":
      return buildScene(project);
    case "checks":
      return validate(project);
    case "boq":
      return boqTable(project, computeBoq(project));
  }
  const schedules: Record<string, (p: Project) => Table> = {
    doors: doorWindowTable,
    flooring: flooringTable,
    finishes: finishesTable,
    furniture: furnitureTable,
    areas: areaStatementTable,
    electrical: electricalTable,
    circuits: circuitTable,
    plumbing: plumbingTable,
  };
  const fn = schedules[arg ?? ""];
  if (kind === "schedule" && fn) return fn(project);
  throw new Error(`Unknown output ${key}`);
}

export interface Regeneration {
  version: number;
  regenerated: string[];
  reused: number;
  ms: number;
}

/** Rendered outputs for the latest version, kept up to date edit by edit. */
export class OutputCache {
  private readonly outputs = new Map<string, Output>();
  private project: Project;

  constructor(project: Project) {
    this.project = project;
    for (const key of allOutputs(project)) this.outputs.set(key, renderOutput(project, key));
  }

  get(key: string): Output | undefined {
    return this.outputs.get(key);
  }

  keys(): string[] {
    return [...this.outputs.keys()];
  }

  /** Brings the cache to `after`, re-rendering only what `changes` can affect. */
  update(after: Project, changes: ChangeSet): Regeneration {
    const t0 = performance.now();
    const affected = affectedOutputs(this.project, after, changes);
    const keys = new Set(allOutputs(after));
    for (const k of [...this.outputs.keys()]) if (!keys.has(k)) this.outputs.delete(k);
    const regenerated: string[] = [];
    for (const key of keys) {
      if (this.outputs.has(key) && !affected.has(key)) continue;
      this.outputs.set(key, renderOutput(after, key));
      regenerated.push(key);
    }
    this.project = after;
    return { version: after.version, regenerated, reused: keys.size - regenerated.length, ms: performance.now() - t0 };
  }
}
