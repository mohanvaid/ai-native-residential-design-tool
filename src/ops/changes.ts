/**
 * Every op mutates a Draft. The Draft records the first "before" state of each
 * element it touches, so a transaction yields a ChangeSet: the diff for
 * "what did the AI change?" and, reversed, the undo.
 */
import { catalogueItem } from "../catalogue/catalogue.js";
import type { Column, Core, Level, MepPoint, Opening, PlacedItem, Plot, Project, Room, Stair, Tree } from "../model/schema.js";

/** Element collections on the project, by change kind. */
interface Elements {
  room: Room;
  opening: Opening;
  tree: Tree;
  column: Column;
  stair: Stair;
  item: PlacedItem;
  core: Core;
  mep: MepPoint;
}
export type ElementKind = keyof Elements;
const COLLECTION = { room: "rooms", opening: "openings", tree: "trees", column: "columns", stair: "stairs", item: "items", core: "cores", mep: "mep" } as const satisfies Record<ElementKind, keyof Project>;
const ELEMENT_KINDS = Object.keys(COLLECTION) as ElementKind[];

type ElementChange = { [K in ElementKind]: { kind: K; id: string; before: Elements[K] | null; after: Elements[K] | null } }[ElementKind];

export type Change =
  | ElementChange
  | { kind: "levels"; id: "levels"; before: Level[]; after: Level[] }
  | { kind: "plot"; id: "plot"; before: Plot; after: Plot }
  | { kind: "prefs"; id: "prefs"; before: Prefs; after: Prefs }
  | { kind: "rules"; id: "rules"; before: Rules; after: Rules };

type Prefs = Project["prefs"];
type Rules = { jurisdiction: Project["jurisdiction"]; ruleSets: string[] };

export type ChangeSet = Change[];

const clone = <T>(v: T): T => structuredClone(v);

export class OpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class Draft {
  readonly project: Project;
  private readonly before: { [K in ElementKind]: Map<string, Elements[K] | null> } = {
    room: new Map(),
    opening: new Map(),
    tree: new Map(),
    column: new Map(),
    stair: new Map(),
    item: new Map(),
    core: new Map(),
    mep: new Map(),
  };
  private levelsBefore: Level[] | null = null;
  private plotBefore: Plot | null = null;
  private prefsBefore: Prefs | null = null;
  private rulesBefore: Rules | null = null;

  constructor(
    base: Project,
    /** The version this transaction will commit as. */
    readonly version: number,
  ) {
    this.project = clone(base);
  }

  nextId(prefix: string): string {
    this.project.seq += 1;
    return `${prefix}_${this.project.seq}`;
  }

  // Elements (rooms, openings, trees, columns, stairs)

  private list<K extends ElementKind>(kind: K): Elements[K][] {
    return this.project[COLLECTION[kind]] as Elements[K][];
  }

  get<K extends ElementKind>(kind: K, id: string): Elements[K] | undefined {
    return this.list(kind).find((e) => e.id === id);
  }

  require<K extends ElementKind>(kind: K, id: string): Elements[K] {
    const e = this.get(kind, id);
    if (!e) throw new OpError(`No ${kind} with id "${id}".`, `${kind}.missing`);
    return e;
  }

  put<K extends ElementKind>(kind: K, el: Elements[K]): void {
    const list = this.list(kind);
    const before = this.before[kind] as Map<string, Elements[K] | null>;
    const i = list.findIndex((e) => e.id === el.id);
    if (!before.has(el.id)) before.set(el.id, i >= 0 ? clone(list[i]!) : null);
    const next = { ...clone(el), meta: { ...el.meta, lastChangedVersion: this.version } };
    if (i >= 0) list[i] = next;
    else list.push(next);
  }

  remove(kind: ElementKind, id: string): void {
    const list = this.list(kind);
    const i = list.findIndex((e) => e.id === id);
    if (i < 0) return;
    const before = this.before[kind] as Map<string, unknown>;
    if (!before.has(id)) before.set(id, clone(list[i]!));
    list.splice(i, 1);
  }

  room = (id: string) => this.get("room", id);
  requireRoom = (id: string) => this.require("room", id);
  putRoom = (room: Room) => this.put("room", room);
  removeRoom = (id: string) => this.remove("room", id);
  opening = (id: string) => this.get("opening", id);
  requireOpening = (id: string) => this.require("opening", id);
  putOpening = (opening: Opening) => this.put("opening", opening);
  removeOpening = (id: string) => this.remove("opening", id);

  // Levels (tracked as one ordered list, since order is the vertical stack)

  level(id: string): Level | undefined {
    return this.project.levels.find((l) => l.id === id);
  }

  requireLevel(id: string): Level {
    const l = this.level(id);
    if (!l) throw new OpError(`No level with id "${id}".`, "level.missing");
    return l;
  }

  setLevels(levels: Level[]): void {
    if (!this.levelsBefore) this.levelsBefore = clone(this.project.levels);
    this.project.levels = clone(levels);
  }

  // Plot

  setPlot(plot: Plot): void {
    if (!this.plotBefore) this.plotBefore = clone(this.project.plot);
    this.project.plot = clone(plot);
  }

  /** The jurisdiction and the rule packs run against it. */
  setRules(next: { jurisdiction?: Project["jurisdiction"]; ruleSets?: string[] }): void {
    if (!this.rulesBefore) this.rulesBefore = { jurisdiction: this.project.jurisdiction, ruleSets: clone(this.project.ruleSets) };
    if (next.jurisdiction) this.project.jurisdiction = next.jurisdiction;
    if (next.ruleSets) this.project.ruleSets = clone(next.ruleSets);
  }

  setPrefs(prefs: Prefs): void {
    if (!this.prefsBefore) this.prefsBefore = clone(this.project.prefs);
    this.project.prefs = clone(prefs);
  }

  /** Net changes; elements touched but left equal to their start state are dropped. */
  changes(): ChangeSet {
    const out: ChangeSet = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const kind of ELEMENT_KINDS) {
      for (const [id, before] of this.before[kind] as Map<string, { meta?: unknown } | null>) {
        const after = this.get(kind, id) ?? null;
        if (!same(stripMeta(before), stripMeta(after))) out.push({ kind, id, before, after: clone(after) } as ElementChange);
      }
    }
    if (this.levelsBefore && !same(this.levelsBefore.map(stripMeta), this.project.levels.map(stripMeta)))
      out.push({ kind: "levels", id: "levels", before: this.levelsBefore, after: clone(this.project.levels) });
    if (this.plotBefore && !same(this.plotBefore, this.project.plot))
      out.push({ kind: "plot", id: "plot", before: this.plotBefore, after: clone(this.project.plot) });
    if (this.prefsBefore && !same(this.prefsBefore, this.project.prefs))
      out.push({ kind: "prefs", id: "prefs", before: this.prefsBefore, after: clone(this.project.prefs) });
    const rulesNow: Rules = { jurisdiction: this.project.jurisdiction, ruleSets: clone(this.project.ruleSets) };
    if (this.rulesBefore && !same(this.rulesBefore, rulesNow)) out.push({ kind: "rules", id: "rules", before: this.rulesBefore, after: rulesNow });
    return out;
  }
}

function stripMeta<T extends { meta?: unknown } | null>(v: T): unknown {
  if (!v) return v;
  const { meta: _meta, ...rest } = v;
  return rest;
}

/** Applies a ChangeSet forwards (redo) or backwards (undo) to a copy of the project. */
export function applyChangeSet(project: Project, changes: ChangeSet, direction: "forward" | "backward"): Project {
  const p = clone(project);
  const list = direction === "forward" ? changes : [...changes].reverse();
  for (const c of list) {
    const target = direction === "forward" ? c.after : c.before;
    switch (c.kind) {
      case "levels":
        p.levels = clone(target as Level[]);
        break;
      case "plot":
        p.plot = clone(target as Plot);
        break;
      case "rules": {
        const r = target as Rules;
        p.jurisdiction = r.jurisdiction;
        p.ruleSets = clone(r.ruleSets);
        break;
      }
      case "prefs":
        p.prefs = clone(target as Prefs);
        break;
      default: {
        const key = COLLECTION[c.kind];
        (p as Record<string, unknown>)[key] = upsert(p[key] as { id: string }[], c.id, target as { id: string } | null);
      }
    }
  }
  return p;
}

/** Replaces an element in place, appends it if new, or removes it when target is null. */
function upsert<T extends { id: string }>(list: T[], id: string, target: T | null): T[] {
  if (!target) return list.filter((e) => e.id !== id);
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return [...list, clone(target)];
  const next = [...list];
  next[i] = clone(target);
  return next;
}

/** One-line descriptions of a ChangeSet, for the chat reply. Bulk column changes collapse to one line. */
export function describeChanges(changes: ChangeSet): string[] {
  const columns = changes.filter((c) => c.kind === "column");
  const bulk = columns.length > 3;
  const mep = changes.filter((c) => c.kind === "mep");
  const bulkMep = mep.length > 3;
  const lines = changes.filter((c) => !(bulk && c.kind === "column") && !(bulkMep && c.kind === "mep")).map((c) => {
    const name = (v: unknown) => {
      if (!v || typeof v !== "object") return c.id;
      if ("name" in v && v.name) return String(v.name);
      if ("host" in v && "type" in v) return `${v.type} (${c.id})`;
      if ("species" in v) return String(v.species);
      if ("catalogue" in v) return `${catalogueItem(String(v.catalogue))?.name.toLowerCase() ?? v.catalogue} (${c.id})`;
      if (c.kind === "core" && "kind" in v) return `${v.kind} (${c.id})`;
      if (c.kind === "mep" && "kind" in v) return `${v.kind} point (${c.id})`;
      return c.id;
    };
    if (c.kind === "levels") return "Levels updated";
    if (c.kind === "plot") return "Plot updated";
    if (c.kind === "prefs") return "Preferences updated";
    if (c.kind === "rules") return `Rules: ${c.after.jurisdiction}${c.after.ruleSets.length ? ` (${c.after.ruleSets.join(", ")})` : ""}`;
    if (!c.before) return `Added ${c.kind} ${name(c.after)}`;
    if (!c.after) return `Removed ${c.kind} ${name(c.before)}`;
    return `Changed ${c.kind} ${name(c.after)}`;
  });
  if (bulk) {
    const added = columns.filter((c) => !c.before).length;
    const removed = columns.filter((c) => !c.after).length;
    const changed = columns.length - added - removed;
    lines.push(`Columns: ${[added && `${added} added`, removed && `${removed} removed`, changed && `${changed} changed`].filter(Boolean).join(", ")}`);
  }
  if (bulkMep) {
    const added = mep.filter((c) => !c.before).length;
    const removed = mep.filter((c) => !c.after).length;
    const changed = mep.length - added - removed;
    lines.push(`Electrical and plumbing points: ${[added && `${added} added`, removed && `${removed} removed`, changed && `${changed} changed`].filter(Boolean).join(", ")}`);
  }
  return lines;
}
