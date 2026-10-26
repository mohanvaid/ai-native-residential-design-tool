/**
 * The edit loop: ops → dry-run apply on a copy → validate → commit or report.
 * A request is one transaction: every op applies or none do.
 */
import { costFindings } from "./cost/boq.js";
import { validateModel } from "./model/validate.js";
import type { Finding, Project } from "./model/schema.js";
import { applyOp, normalize } from "./ops/apply.js";
import { applyChangeSet, describeChanges, Draft, OpError, type ChangeSet } from "./ops/changes.js";
import { Op, type OpInput } from "./ops/definitions.js";
import { runRulePacks } from "./rules/registry.js";
import { vastuFindings } from "./rules/vastu.js";

export interface TransactionResult {
  /**
   * committed: applied. blocked: applied cleanly but validation found
   * blocking problems, so it was not committed. rejected: an op was invalid
   * or its preconditions failed.
   */
  status: "committed" | "blocked" | "rejected";
  /** The new version when committed, the dry-run preview when blocked, the base when rejected. */
  project: Project;
  changes: ChangeSet;
  summary: string[];
  findings: Finding[];
  error?: { opIndex: number; code: string; message: string };
}

export function validate(project: Project): Finding[] {
  const order = { block: 0, warn: 1, info: 2 } as const;
  return [...validateModel(project), ...runRulePacks(project).findings, ...vastuFindings(project), ...costFindings(project)].sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Applies ops to a copy of the project and validates the result. Never mutates `project`. */
export function dryRun(project: Project, ops: OpInput[]): TransactionResult {
  const draft = new Draft(project, project.version + 1);
  for (let i = 0; i < ops.length; i++) {
    const parsed = Op.safeParse(ops[i]);
    if (!parsed.success) {
      const message = parsed.error.issues.map((e) => `${e.path.join(".") || "op"}: ${e.message}`).join("; ");
      return reject(project, i, "op.invalid", message);
    }
    try {
      applyOp(draft, parsed.data, i);
    } catch (e) {
      if (e instanceof OpError) return reject(project, i, e.code, e.message);
      throw e;
    }
  }
  normalize(draft);
  const next = { ...draft.project, version: project.version + 1 };
  const changes = draft.changes();
  const findings = validate(next);
  // Only problems this transaction introduces block it; existing ones are reported but do not freeze the model.
  const before = new Set(validate(project).filter((x) => x.severity === "block").map(findingKey));
  const blocked = findings.some((x) => x.severity === "block" && !before.has(findingKey(x)));
  return { status: blocked ? "blocked" : "committed", project: next, changes, summary: describeChanges(changes), findings };
}

const findingKey = (f: Finding) => `${f.code}|${[...f.elements].sort().join(",")}`;

function reject(project: Project, opIndex: number, code: string, message: string): TransactionResult {
  return { status: "rejected", project, changes: [], summary: [], findings: [], error: { opIndex, code, message } };
}

export interface VersionEntry {
  version: number;
  project: Project;
  label: string;
  ops: Op[];
  changes: ChangeSet;
  /** ISO time the version was made. */
  at: string;
}

/** In-memory version history for one project, with undo from the op log. */
export class ModelStore {
  private readonly history: VersionEntry[];
  /** Versions created by commit() that have not been undone, newest last. */
  private readonly undoable: VersionEntry[] = [];

  constructor(initial: Project, label = "Created") {
    this.history = [{ version: initial.version, project: initial, label, ops: [], changes: [], at: new Date().toISOString() }];
  }

  /** Rebuilds a store from saved history; `undoable` lists the versions undo can still reverse, oldest first. */
  static fromHistory(history: VersionEntry[], undoable: number[]): ModelStore {
    if (!history.length) throw new Error("A design history needs at least one version.");
    const store = new ModelStore(history[0]!.project);
    store.history.splice(0, 1, ...history);
    store.undoable.push(...undoable.map((v) => history.find((h) => h.version === v)).filter((h): h is VersionEntry => !!h));
    return store;
  }

  /** Versions undo can still reverse, oldest first. */
  get undoableVersions(): number[] {
    return this.undoable.map((h) => h.version);
  }

  /** The project as it was at an earlier version. */
  at(version: number): Project | undefined {
    return this.history.find((h) => h.version === version)?.project;
  }

  get current(): Project {
    return this.history[this.history.length - 1]!.project;
  }

  get versions(): readonly VersionEntry[] {
    return this.history;
  }

  /**
   * Commits when there are no blocking findings, or when the user has seen
   * them and confirmed (`acceptBlocking`).
   */
  commit(ops: OpInput[], opts: { label?: string; acceptBlocking?: boolean } = {}): TransactionResult {
    const result = dryRun(this.current, ops);
    if (result.status === "rejected") return result;
    if (result.status === "blocked" && !opts.acceptBlocking) return result;
    if (!result.changes.length) return { ...result, project: this.current, status: "committed" };
    const entry: VersionEntry = {
      version: result.project.version,
      project: result.project,
      label: opts.label ?? ops.map((o) => o.reason ?? o.op).join("; "),
      ops: ops.map((o) => Op.parse(o)),
      changes: result.changes,
      at: new Date().toISOString(),
    };
    this.history.push(entry);
    this.undoable.push(entry);
    return { ...result, status: "committed" };
  }

  /** Reverses the most recent commit that has not been undone, as a new version. */
  undo(): TransactionResult | null {
    const last = this.undoable.pop();
    if (!last) return null;
    return this.pushRestore(applyChangeSet(this.current, last.changes, "backward"), `Undo: ${last.label}`, last.changes);
  }

  /** Makes an earlier version current again, as a new version. */
  revert(version: number): TransactionResult | null {
    const target = this.history.find((h) => h.version === version);
    if (!target) return null;
    this.undoable.length = 0;
    return this.pushRestore(target.project, `Revert to v${version}`, []);
  }

  private pushRestore(restored: Project, label: string, reversed: ChangeSet): TransactionResult {
    const project = { ...structuredClone(restored), version: this.current.version + 1 };
    const changes: ChangeSet = reversed.map((c) => ({ ...c, before: c.after, after: c.before }) as ChangeSet[number]).reverse();
    this.history.push({ version: project.version, project, label, ops: [], changes, at: new Date().toISOString() });
    return { status: "committed", project, changes, summary: [label], findings: validate(project) };
  }
}
