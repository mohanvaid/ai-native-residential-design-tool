/**
 * Every op mutates a Draft. The Draft records the first "before" state of each
 * element it touches, so a transaction yields a ChangeSet: the diff for
 * "what did the AI change?" and, reversed, the undo.
 */
import type { Level, Opening, Plot, Project, Room } from "../model/schema.js";

export type Change =
  | { kind: "room"; id: string; before: Room | null; after: Room | null }
  | { kind: "opening"; id: string; before: Opening | null; after: Opening | null }
  | { kind: "levels"; id: "levels"; before: Level[]; after: Level[] }
  | { kind: "plot"; id: "plot"; before: Plot; after: Plot };

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
  private readonly roomsBefore = new Map<string, Room | null>();
  private readonly openingsBefore = new Map<string, Opening | null>();
  private levelsBefore: Level[] | null = null;
  private plotBefore: Plot | null = null;

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

  // Rooms

  room(id: string): Room | undefined {
    return this.project.rooms.find((r) => r.id === id);
  }

  requireRoom(id: string): Room {
    const r = this.room(id);
    if (!r) throw new OpError(`No room with id "${id}".`, "room.missing");
    return r;
  }

  putRoom(room: Room): void {
    const i = this.project.rooms.findIndex((r) => r.id === room.id);
    if (!this.roomsBefore.has(room.id)) this.roomsBefore.set(room.id, i >= 0 ? clone(this.project.rooms[i]!) : null);
    const next = { ...clone(room), meta: { ...room.meta, lastChangedVersion: this.version } };
    if (i >= 0) this.project.rooms[i] = next;
    else this.project.rooms.push(next);
  }

  removeRoom(id: string): void {
    const i = this.project.rooms.findIndex((r) => r.id === id);
    if (i < 0) return;
    if (!this.roomsBefore.has(id)) this.roomsBefore.set(id, clone(this.project.rooms[i]!));
    this.project.rooms.splice(i, 1);
  }

  // Openings

  opening(id: string): Opening | undefined {
    return this.project.openings.find((o) => o.id === id);
  }

  requireOpening(id: string): Opening {
    const o = this.opening(id);
    if (!o) throw new OpError(`No opening with id "${id}".`, "opening.missing");
    return o;
  }

  putOpening(opening: Opening): void {
    const i = this.project.openings.findIndex((o) => o.id === opening.id);
    if (!this.openingsBefore.has(opening.id))
      this.openingsBefore.set(opening.id, i >= 0 ? clone(this.project.openings[i]!) : null);
    const next = { ...clone(opening), meta: { ...opening.meta, lastChangedVersion: this.version } };
    if (i >= 0) this.project.openings[i] = next;
    else this.project.openings.push(next);
  }

  removeOpening(id: string): void {
    const i = this.project.openings.findIndex((o) => o.id === id);
    if (i < 0) return;
    if (!this.openingsBefore.has(id)) this.openingsBefore.set(id, clone(this.project.openings[i]!));
    this.project.openings.splice(i, 1);
  }

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

  /** Net changes; elements touched but left equal to their start state are dropped. */
  changes(): ChangeSet {
    const out: ChangeSet = [];
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const [id, before] of this.roomsBefore) {
      const after = this.room(id) ?? null;
      if (!same(stripMeta(before), stripMeta(after))) out.push({ kind: "room", id, before, after: clone(after) });
    }
    for (const [id, before] of this.openingsBefore) {
      const after = this.opening(id) ?? null;
      if (!same(stripMeta(before), stripMeta(after))) out.push({ kind: "opening", id, before, after: clone(after) });
    }
    if (this.levelsBefore && !same(this.levelsBefore.map(stripMeta), this.project.levels.map(stripMeta)))
      out.push({ kind: "levels", id: "levels", before: this.levelsBefore, after: clone(this.project.levels) });
    if (this.plotBefore && !same(this.plotBefore, this.project.plot))
      out.push({ kind: "plot", id: "plot", before: this.plotBefore, after: clone(this.project.plot) });
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
      case "room":
        p.rooms = upsert(p.rooms, c.id, target as Room | null);
        break;
      case "opening":
        p.openings = upsert(p.openings, c.id, target as Opening | null);
        break;
      case "levels":
        p.levels = clone(target as Level[]);
        break;
      case "plot":
        p.plot = clone(target as Plot);
        break;
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

/** One-line descriptions of a ChangeSet, for the chat reply. */
export function describeChanges(changes: ChangeSet): string[] {
  return changes.map((c) => {
    const name = (v: unknown) => (v && typeof v === "object" && "name" in v ? String(v.name) : c.id);
    if (c.kind === "levels") return "Levels updated";
    if (c.kind === "plot") return "Plot updated";
    if (!c.before) return `Added ${c.kind} ${name(c.after)}`;
    if (!c.after) return `Removed ${c.kind} ${name(c.before)}`;
    return `Changed ${c.kind} ${name(c.after)}`;
  });
}
