/**
 * A saved design: one project with named branches ("main", "kitchen-ne"),
 * each with its own revision history, and tags on revisions worth keeping
 * ("Sent to engineer"). A branch starts from a revision of another branch
 * and carries on its revision letters, so "kitchen-ne Rev E" follows on
 * from "main Rev D".
 *
 * On disk a branch is its first snapshot plus each version's change set,
 * replayed on load. A version whose change set does not reproduce it (a
 * revert, say) is stored as a full snapshot instead.
 */
import { revisionLabel } from "../agent/report.js";
import { ModelStore, validate, type VersionEntry } from "../engine.js";
import { ADVISORY_STAMP, withStamp } from "../output/frame.js";
import { can, liveComments, refusal, signOffBlockers, signOffStamp, type Action, type Comment, type Member, type SignOff } from "./collaboration.js";
import { applyChangeSet, type ChangeSet } from "../ops/changes.js";
import { Op } from "../ops/definitions.js";
import { Project } from "../model/schema.js";

export const DESIGN_FORMAT = 1;
const BRANCH_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface Branch {
  store: ModelStore;
  /** Where the branch started: the branch and version it was copied from. */
  from?: { branch: string; version: number };
  /** Names given to versions, by version number. */
  tags: Map<number, string>;
}

export interface Revision {
  rev: string;
  version: number;
  label: string;
  at: string;
  tag?: string;
  author?: string;
  assumptions?: string[];
}

interface StoredEntry {
  version: number;
  label: string;
  at: string;
  ops: unknown[];
  changes: ChangeSet;
  /** The id counter, which change sets do not carry. */
  seq: number;
  /** Present when the change set alone does not rebuild this version. */
  snapshot?: unknown;
  author?: string;
  assumptions?: string[];
}

export interface StoredBranch {
  from?: { branch: string; version: number };
  tags: Record<string, string>;
  undoable: number[];
  history: StoredEntry[];
}

export interface StoredDesign {
  members?: Member[];
  comments?: Comment[];
  signoffs?: SignOff[];
  format: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  current: string;
  branches: Record<string, StoredBranch>;
}

/** "Demo house, 30×40 East" → "demo-house-30x40-east". */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/×/g, "x")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "design"
  );
}

/** JSON with object keys sorted, so two equal projects always print the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

function replay(prev: Project, e: StoredEntry): Project {
  return { ...applyChangeSet(prev, e.changes, "forward"), version: e.version, seq: e.seq };
}

export class Design {
  readonly branches = new Map<string, Branch>();
  current = "main";
  /** Who is on the design. Empty means nobody is signed in and nothing is restricted. */
  readonly members: Member[] = [];
  readonly comments: Comment[] = [];
  readonly signoffs: SignOff[] = [];
  private commentSeq = 0;

  constructor(
    readonly id: string,
    public name: string,
    project: Project,
    readonly createdAt = new Date().toISOString(),
  ) {
    this.branches.set("main", { store: new ModelStore(project), tags: new Map() });
  }

  member(id: string): Member | undefined {
    return this.members.find((m) => m.id === id);
  }

  addMember(m: Member, by?: string): Member {
    if (this.members.length && !can(this.member(by ?? ""), "manage_members")) throw new Error(refusal(this.member(by ?? ""), "manage_members"));
    if (this.member(m.id)) throw new Error(`${m.id} is already on this design.`);
    this.members.push(m);
    return m;
  }

  /** Throws unless the member may do this, with the reason in words. */
  require(memberId: string | undefined, action: Action, context = ""): void {
    if (!this.members.length) return; // single-user design
    const m = this.member(memberId ?? "");
    const ok = action === "edit" && this.current === "main" ? can(m, "edit") && can(m, "edit_main") : can(m, action);
    if (!ok) throw new Error(refusal(m, action === "edit" && this.current === "main" && can(m, "edit") ? "edit_main" : action, context));
  }

  /** Commits on behalf of a member, checking their role and freezing signed-off revisions. */
  commitAs(memberId: string | undefined, ops: Parameters<ModelStore["commit"]>[0], opts: Parameters<ModelStore["commit"]>[1] = {}) {
    this.require(memberId, "edit");
    if (this.signOffOf(this.current, this.store.current.version))
      throw new Error(`${this.current} Rev ${revisionLabel(this.store.current.version)} is signed off and frozen. Start a branch to carry on from it.`);
    return this.store.commit(ops, { ...opts, author: memberId ?? opts.author });
  }

  comment(author: string | undefined, text: string, elements: string[] = [], replyTo?: string): Comment {
    this.require(author, "comment");
    const c: Comment = { id: `c${++this.commentSeq}`, author: author ?? "claude", text, at: new Date().toISOString(), branch: this.current, version: this.store.current.version, elements, ...(replyTo ? { replyTo } : {}) };
    this.comments.push(c);
    return c;
  }

  resolveComment(id: string, by: string | undefined): Comment {
    const c = this.comments.find((x) => x.id === id);
    if (!c) throw new Error(`There is no comment ${id}.`);
    this.require(by, "comment");
    c.resolvedBy = by ?? "claude";
    c.resolvedAt = new Date().toISOString();
    return c;
  }

  /** Open comments on the current branch, pinned to things that still exist. */
  openComments(branch = this.current): Comment[] {
    const project = this.branch(branch).store.current;
    return liveComments(project, this.comments.filter((c) => c.branch === branch && !c.resolvedBy));
  }

  signOffOf(branch: string, version: number): SignOff | undefined {
    return this.signoffs.find((s) => s.branch === branch && s.version === version);
  }

  /** Signs off the current revision: it freezes, and its drawings carry the professional's stamp. */
  signOff(memberId: string, purpose: SignOff["purpose"] = "construction", note?: string): SignOff {
    const m = this.member(memberId);
    if (!can(m, "sign_off")) throw new Error(refusal(m, "sign_off"));
    const version = this.store.current.version;
    if (this.signOffOf(this.current, version)) throw new Error(`${this.current} Rev ${revisionLabel(version)} is already signed off.`);
    const blockers = signOffBlockers(validate(this.store.current));
    if (blockers.length) throw new Error([`${this.current} Rev ${revisionLabel(version)} cannot be signed off; ${blockers.length} blocking findings:`, ...blockers.map((f) => `- ${f.message}`)].join("\n"));
    const open = this.openComments().length;
    const s: SignOff = { branch: this.current, version, by: m!.id, name: m!.name, licence: m!.licence!, at: new Date().toISOString(), purpose, ...(note ? { note } : open ? { note: `${open} comments still open` } : {}) };
    this.signoffs.push(s);
    this.tag(`Signed off for ${purpose}`, version);
    return s;
  }

  /** Runs `fn` with the stamp this revision's drawings should carry. */
  stamped<T>(fn: () => T, branch = this.current, version = this.branch(branch).store.current.version): T {
    const s = this.signOffOf(branch, version);
    return withStamp(s ? signOffStamp(s) : ADVISORY_STAMP, fn);
  }

  /** The store of the branch being worked on. */
  get store(): ModelStore {
    return this.branch(this.current).store;
  }

  branch(name: string): Branch {
    const b = this.branches.get(name);
    if (!b) throw new Error(`There is no branch "${name}". Branches: ${[...this.branches.keys()].join(", ")}.`);
    return b;
  }

  /**
   * Starts a branch from a version of an existing branch (the current
   * branch's latest by default) and switches to it.
   */
  createBranch(name: string, from: { branch?: string; version?: number } = {}): ModelStore {
    if (!BRANCH_NAME.test(name)) throw new Error(`Branch names are lower-case letters, digits and hyphens, up to 40 characters: "${name}" is not one.`);
    if (this.branches.has(name)) throw new Error(`There is already a branch "${name}".`);
    const source = from.branch ?? this.current;
    const src = this.branch(source).store;
    const version = from.version ?? src.current.version;
    const project = src.at(version);
    if (!project) throw new Error(`${source} has no Rev ${revisionLabel(version)}.`);
    const store = new ModelStore(structuredClone(project), `Branched from ${source} Rev ${revisionLabel(version)}`);
    this.branches.set(name, { store, from: { branch: source, version }, tags: new Map() });
    this.current = name;
    return store;
  }

  switchTo(name: string): ModelStore {
    this.branch(name);
    this.current = name;
    return this.store;
  }

  /** Names a version of the current branch (its latest by default). */
  tag(label: string, version = this.store.current.version): void {
    const b = this.branch(this.current);
    if (!b.store.at(version)) throw new Error(`${this.current} has no Rev ${revisionLabel(version)}.`);
    b.tags.set(version, label);
  }

  revisions(branch = this.current): Revision[] {
    const b = this.branch(branch);
    return b.store.versions.map((h) => ({ rev: revisionLabel(h.version), version: h.version, label: h.label, at: h.at, tag: b.tags.get(h.version), author: h.author, assumptions: h.assumptions }));
  }

  /**
   * Finds a project by reference: "main", "kitchen-ne@C", "@B" (current
   * branch), or a tag name.
   */
  resolve(ref: string): { branch: string; version: number; project: Project } {
    for (const [branch, b] of this.branches)
      for (const [version, tag] of b.tags) if (tag.toLowerCase() === ref.toLowerCase()) return { branch, version, project: b.store.at(version)! };
    const [name, rev] = ref.includes("@") ? ref.split("@") : [ref, ""];
    const branch = name || this.current;
    const store = this.branch(branch).store;
    if (!rev) return { branch, version: store.current.version, project: store.current };
    const entry = store.versions.find((h) => revisionLabel(h.version) === rev.toUpperCase() || String(h.version) === rev);
    if (!entry) throw new Error(`${branch} has no Rev ${rev}.`);
    return { branch, version: entry.version, project: entry.project };
  }

  toJSON(): StoredDesign {
    const branches: Record<string, StoredBranch> = {};
    let updatedAt = this.createdAt;
    for (const [name, b] of this.branches) {
      const history: StoredEntry[] = [];
      let prev: Project | null = null;
      for (const h of b.store.versions) {
        const entry: StoredEntry = { version: h.version, label: h.label, at: h.at, ops: h.ops, changes: h.changes, seq: h.project.seq, ...(h.author ? { author: h.author } : {}), ...(h.assumptions?.length ? { assumptions: h.assumptions } : {}) };
        if (!prev || canonical(replay(prev, entry)) !== canonical(h.project)) entry.snapshot = h.project;
        history.push(entry);
        prev = h.project;
        if (h.at > updatedAt) updatedAt = h.at;
      }
      branches[name] = { ...(b.from ? { from: b.from } : {}), tags: Object.fromEntries([...b.tags].map(([v, t]) => [String(v), t])), undoable: b.store.undoableVersions, history };
    }
    return {
      format: DESIGN_FORMAT,
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt,
      current: this.current,
      branches,
      ...(this.members.length ? { members: this.members } : {}),
      ...(this.comments.length ? { comments: this.comments } : {}),
      ...(this.signoffs.length ? { signoffs: this.signoffs } : {}),
    };
  }

  static fromJSON(data: StoredDesign): Design {
    if (data.format !== DESIGN_FORMAT) throw new Error(`Design file format ${data.format} is not supported (expected ${DESIGN_FORMAT}).`);
    const names = Object.keys(data.branches);
    if (!names.length) throw new Error("The design file has no branches.");
    let design: Design | null = null;
    for (const name of names) {
      const sb = data.branches[name]!;
      const history: VersionEntry[] = [];
      let prev: Project | null = null;
      for (const e of sb.history) {
        const project: Project = e.snapshot !== undefined ? Project.parse(e.snapshot) : prev ? replay(prev, e) : null!;
        if (!project) throw new Error(`Branch ${name} does not start with a snapshot.`);
        history.push({ version: e.version, project, label: e.label, at: e.at, ops: e.ops.map((o) => Op.parse(o)), changes: e.changes, author: e.author, assumptions: e.assumptions });
        prev = project;
      }
      const store = ModelStore.fromHistory(history, sb.undoable);
      const branch: Branch = { store, from: sb.from, tags: new Map(Object.entries(sb.tags).map(([v, t]) => [Number(v), t])) };
      design ??= new Design(data.id, data.name, history[0]!.project, data.createdAt);
      design.branches.set(name, branch);
    }
    if (!data.branches.main) design!.branches.delete("main");
    design!.members.push(...(data.members ?? []));
    design!.comments.push(...(data.comments ?? []));
    design!.signoffs.push(...(data.signoffs ?? []));
    design!.commentSeq = design!.comments.reduce((n, c) => Math.max(n, Number(c.id.replace(/\D/g, "")) || 0), 0);
    design!.current = data.branches[data.current] ? data.current : names[0]!;
    return design!;
  }
}
