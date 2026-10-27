/**
 * The chat loop: one user message → Claude proposes typed ops through tools →
 * the engine dry-runs and checks them → the turn is committed as one revision
 * → the reply ends with a deterministic change summary.
 *
 * The LLM sits outside the trusted core: it only ever sees the model summary
 * and tool results, and it can only change the model through apply_edits.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { dryRun, validate, type ModelStore, type TransactionResult } from "../engine.js";
import { Design } from "../store/design.js";
import { compareProjects, comparisonText } from "../store/compare.js";
import { revisionLabel } from "./report.js";
import type { Finding, Project, Side } from "../model/schema.js";
import { catalogueItem } from "../catalogue/catalogue.js";
import { coreName } from "../model/core.js";
import { MEP_LABELS } from "../model/mep.js";
import { computeBoq, boqTable, formatInr } from "../cost/boq.js";
import { buildScene } from "../output/model3d.js";
import { detailSheets } from "../output/details.js";
import { drawingSet } from "../output/drawingset.js";
import { elevationSheet, sectionSheet } from "../output/elevation.js";
import { floorPlanSheet } from "../output/floorplan.js";
import { siteplanSheet } from "../output/siteplan.js";
import { areaStatementTable, doorWindowTable, electricalTable, finishesTable, flooringTable, plumbingTable, type Table } from "../output/schedules.js";
import { clearRect, deriveWalls, resolveOpening, roomRect } from "../model/walls.js";
import type { ChangeSet } from "../ops/changes.js";
import { Op, type OpInput } from "../ops/definitions.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { changeSummary } from "./report.js";
import { modelSummary } from "./summary.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** The slice of the SDK the agent uses, so tests can script the model. */
export interface MessagesApi {
  create(params: CreateParams): Promise<BetaMessage>;
}

export function anthropicMessages(client = new Anthropic()): MessagesApi {
  return { create: (params) => client.beta.messages.create(params) };
}

export const DEFAULT_MODEL = "claude-opus-5-5";

const ApplyEditsInput = z.object({
  ops: z.array(Op).min(1).describe("Typed operations, applied in order as one transaction."),
  assumptions: z.array(z.string()).describe("Each assumption made about direction, units, clear vs centreline, or which side stayed fixed."),
  accept_blocking: z
    .boolean()
    .optional()
    .describe("Only when the user explicitly said to go ahead despite a blocking issue already reported to them."),
});

const QueryModelInput = z.object({
  ids: z.array(z.string()).optional().describe("Room, opening, level, core or point ids. Omit for the full model summary."),
});

const ResolveReferenceInput = z.object({
  phrase: z.string().describe('What the user called it, e.g. "the kitchen window", "the master bedroom", "the toilet upstairs".'),
  kind: z.enum(["room", "opening", "item", "core", "level", "mep", "any"]).default("any"),
});

const RunChecksInput = z.object({
  only: z.array(z.string()).optional().describe('Finding code prefixes to keep, e.g. ["tn.", "vastu."]. Omit for everything.'),
  severity: z.enum(["block", "warn", "info"]).default("warn").describe("The least severe level to report."),
});

const GenerateInput = z.object({
  output: z.enum(["plan", "elevation", "section", "site", "3d", "schedules", "estimate", "drawings", "electrical", "plumbing", "details"]),
  scope: z.string().optional().describe("A level id for a plan or layout, a side for an elevation; otherwise leave out."),
});

const VersionInput = z.object({
  action: z.enum(["list_revisions", "tag", "branch", "switch", "compare"]),
  name: z.string().optional().describe("tag: the name; branch/switch: the branch name."),
  from: z.string().optional().describe('compare: the earlier reference, e.g. "main@C" or a tag name. Default the previous revision.'),
  to: z.string().optional().describe("compare: the later reference. Default the current design."),
});

function toolSchema(schema: z.ZodType): Anthropic.Beta.Messages.BetaTool.InputSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest as Anthropic.Beta.Messages.BetaTool.InputSchema;
}

export const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "apply_edits",
    description:
      "Apply typed edit operations to the building model. They are dry-run and checked first; the result says whether they were applied, the new sizes, and any warnings or blocking issues. Blocked edits are not applied.",
    input_schema: toolSchema(ApplyEditsInput),
  },
  {
    name: "query_model",
    description: "Look up rooms, openings or levels by id: exact geometry, clear sizes, walls and what each opening leads to.",
    input_schema: toolSchema(QueryModelInput),
  },
  {
    name: "resolve_reference",
    description: "Turn what the user called something into model ids, with the candidates ranked and why each matched. Use it before editing when a name could mean more than one thing.",
    input_schema: toolSchema(ResolveReferenceInput),
  },
  {
    name: "run_checks",
    description: "Run the rule packs and design checks against the model as it stands in this turn, without editing. Use it to answer 'is this allowed?' or to check before proposing a change.",
    input_schema: toolSchema(RunChecksInput),
  },
  {
    name: "generate",
    description: "Regenerate an output (a plan, elevation, section, site plan, 3D, electrical or plumbing layout, detail elevations, schedules, estimate, or the whole drawing set) and report what it contains. The app shows the drawing; you describe it.",
    input_schema: toolSchema(GenerateInput),
  },
  {
    name: "version",
    description: "Work with revisions: list them, tag one, start or switch to a branch, or compare two. Only available when the chat is working on a saved design.",
    input_schema: toolSchema(VersionInput),
  },
  {
    name: "undo_last_request",
    description: "Undo the whole previous request (its revision). Use when the user asks to undo or go back one step.",
    input_schema: { type: "object", properties: {} },
  },
];

export interface TurnResult {
  /** Claude's reply followed by the change summary line. */
  reply: string;
  /** committed: a new revision; undone: the previous revision was undone; unchanged: nothing applied. */
  outcome: "committed" | "undone" | "unchanged";
  project: Project;
  changes: ChangeSet;
  findings: Finding[];
  summaryLine: string;
  assumptions: string[];
}

export interface AgentOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Upper bound on model calls per user message. */
  maxSteps?: number;
}

export class DesignAgent {
  private readonly history: BetaMessageParam[] = [];
  /** The saved design, when the chat is working on one; the version tool needs it. */
  readonly design: Design | null;
  private readonly only: ModelStore | null;

  constructor(
    store: ModelStore | Design,
    private readonly api: MessagesApi = anthropicMessages(),
    private readonly opts: AgentOptions = {},
  ) {
    this.design = store instanceof Design ? store : null;
    this.only = this.design ? null : (store as ModelStore);
  }

  /** The store of the branch being worked on. */
  get store(): ModelStore {
    return this.design ? this.design.store : this.only!;
  }

  async send(userText: string): Promise<TurnResult> {
    const base = this.store.current;
    const turn = { ops: [] as OpInput[], assumptions: [] as string[], undone: null as TransactionResult | null };

    this.history.push({
      role: "user",
      content: `<model>\n${modelSummary(base)}\n</model>\n\n${userText}`,
    });

    let text = "";
    const maxSteps = this.opts.maxSteps ?? 12;
    for (let step = 0; step < maxSteps; step++) {
      const response = await this.api.create({
        model: this.opts.model ?? DEFAULT_MODEL,
        max_tokens: 16000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        tool_choice: { type: "auto" },
        thinking: { type: "adaptive" },
        output_config: { effort: this.opts.effort ?? "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: this.history,
      });
      this.history.push({ role: "assistant", content: response.content });
      text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();

      if (response.stop_reason === "refusal") {
        text = "I can't help with that request.";
        break;
      }
      if (response.stop_reason !== "tool_use") break;

      const results: ToolResult[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        results.push({ type: "tool_result", tool_use_id: block.id, ...this.runTool(block.name, block.input, base, turn) });
      }
      this.history.push({ role: "user", content: results });
    }

    if (turn.undone) {
      const after = this.store.current;
      const summaryLine = changeSummary(base, after, turn.undone.changes, turn.undone.findings);
      return this.result(text, "undone", turn.undone.changes, turn.undone.findings, summaryLine, turn.assumptions);
    }
    if (!turn.ops.length) {
      return this.result(text, "unchanged", [], [], "", turn.assumptions);
    }
    const committed = this.store.commit(turn.ops, { label: userText, acceptBlocking: true, author: "claude", assumptions: turn.assumptions });
    const summaryLine = changeSummary(base, committed.project, committed.changes, committed.findings);
    return this.result(text, "committed", committed.changes, committed.findings, summaryLine, turn.assumptions);
  }

  private result(text: string, outcome: TurnResult["outcome"], changes: ChangeSet, findings: Finding[], summaryLine: string, assumptions: string[]): TurnResult {
    return {
      reply: summaryLine ? `${text}\n\n${summaryLine}` : text,
      outcome,
      project: this.store.current,
      changes,
      findings,
      summaryLine,
      assumptions,
    };
  }

  private runVersion(design: Design, a: z.infer<typeof VersionInput>): string {
    switch (a.action) {
      case "list_revisions": {
        const revs = design.revisions();
        return [
          `Branch ${design.current} of ${design.branches.size}: ${[...design.branches.keys()].join(", ")}.`,
          ...revs.map((r) => `Rev ${r.rev} (v${r.version}) ${r.at.slice(0, 10)}${r.author ? ` by ${r.author}` : ""}${r.tag ? ` · tagged "${r.tag}"` : ""}: ${r.label}${r.assumptions?.length ? ` [assumed: ${r.assumptions.join("; ")}]` : ""}`),
        ].join("\n");
      }
      case "tag": {
        if (!a.name) throw new Error("A tag needs a name.");
        design.tag(a.name);
        return `Tagged ${design.current} Rev ${revisionLabel(design.store.current.version)} as "${a.name}".`;
      }
      case "branch": {
        if (!a.name) throw new Error("A branch needs a name.");
        design.createBranch(a.name, a.from ? { branch: a.from.split("@")[0] || undefined, version: design.resolve(a.from).version } : {});
        return `Started branch ${a.name} and switched to it. Edits from here do not touch ${design.branches.get(a.name)!.from?.branch ?? "the other branches"}.`;
      }
      case "switch": {
        if (!a.name) throw new Error("Say which branch to switch to.");
        design.switchTo(a.name);
        return `On branch ${a.name}, Rev ${revisionLabel(design.store.current.version)}.\n${modelSummary(design.store.current)}`;
      }
      case "compare": {
        const versions = design.store.versions;
        const bRef = a.to ? design.resolve(a.to) : { branch: design.current, version: design.store.current.version, project: design.store.current };
        const aRef = a.from ? design.resolve(a.from) : { branch: design.current, version: versions[versions.length - 2]?.version ?? bRef.version, project: versions[versions.length - 2]?.project ?? bRef.project };
        const labels = { a: `${aRef.branch} Rev ${revisionLabel(aRef.version)}`, b: `${bRef.branch} Rev ${revisionLabel(bRef.version)}` };
        return comparisonText(compareProjects(aRef.project, bRef.project, labels));
      }
    }
  }

  private runTool(
    name: string,
    input: unknown,
    base: Project,
    turn: { ops: OpInput[]; assumptions: string[]; undone: TransactionResult | null },
  ): { content: string; is_error?: boolean } {
    switch (name) {
      case "apply_edits": {
        const parsed = ApplyEditsInput.safeParse(input);
        if (!parsed.success) return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, is_error: true };
        if (turn.undone) return { content: "The previous request was just undone in this turn; make further edits in the next message.", is_error: true };
        const candidate = [...turn.ops, ...parsed.data.ops];
        const result = dryRun(base, candidate);
        if (result.status === "rejected") {
          const e = result.error!;
          const idx = e.opIndex - turn.ops.length;
          return { content: `Rejected at op ${idx} (${e.code}): ${e.message} Nothing from this call was applied.`, is_error: true };
        }
        const issues = result.findings.filter((f) => f.severity !== "info");
        if (result.status === "blocked" && !parsed.data.accept_blocking) {
          return {
            content: [
              "BLOCKED: not applied. Blocking issues this change would introduce:",
              ...issues.filter((f) => f.severity === "block").map((f) => `- ${f.message}`),
              "Explain this to the user and offer alternatives.",
            ].join("\n"),
          };
        }
        turn.ops = candidate;
        turn.assumptions.push(...parsed.data.assumptions);
        return {
          content: [
            `APPLIED (pending until the end of this turn). ${changeSummary(base, result.project, result.changes, result.findings)}`,
            ...(issues.length ? ["Issues now:", ...issues.map((f) => `- [${f.severity}] ${f.message}`)] : []),
            "",
            "Updated model:",
            modelSummary(result.project),
          ].join("\n"),
        };
      }
      case "query_model": {
        const parsed = QueryModelInput.safeParse(input);
        const project = turn.ops.length ? dryRun(base, turn.ops).project : base;
        if (!parsed.success || !parsed.data.ids?.length) return { content: modelSummary(project) };
        return { content: JSON.stringify(parsed.data.ids.map((id) => describeElement(project, id)), null, 1) };
      }
      case "resolve_reference": {
        const parsed = ResolveReferenceInput.safeParse(input);
        if (!parsed.success) return { content: "Give a phrase to resolve.", is_error: true };
        const project = turn.ops.length ? dryRun(base, turn.ops).project : base;
        const hits = resolveReference(project, parsed.data.phrase, parsed.data.kind);
        if (!hits.length) return { content: `Nothing in the model matches "${parsed.data.phrase}". Ask the user which one they mean, or call query_model for the full list.` };
        return {
          content: [
            hits[0]!.score < 0.6 ? "Only weak matches; ask the user which they mean." : hits.length > 1 ? `${hits.length} candidates, best first. If the top two are close, ask the user.` : "One match.",
            ...hits.map((h: Reference) => `- ${h.id} (${h.kind}): ${h.label} — ${h.why}`),
          ].join("\n"),
        };
      }
      case "run_checks": {
        const parsed = RunChecksInput.safeParse(input);
        const project = turn.ops.length ? dryRun(base, turn.ops).project : base;
        const order = { block: 0, warn: 1, info: 2 } as const;
        const min = order[parsed.success ? parsed.data.severity : "warn"];
        const only = parsed.success ? parsed.data.only : undefined;
        const findings = validate(project).filter((f) => order[f.severity] <= min && (!only?.length || only.some((pre) => f.code.startsWith(pre))));
        if (!findings.length) return { content: "No findings at that level." };
        return { content: [`${findings.length} findings on the model as it stands in this turn:`, ...findings.map((f) => `- [${f.severity}] ${f.code}: ${f.message}`)].join("\n") };
      }
      case "generate": {
        const parsed = GenerateInput.safeParse(input);
        if (!parsed.success) return { content: "Say which output to generate.", is_error: true };
        const project = turn.ops.length ? dryRun(base, turn.ops).project : base;
        try {
          return { content: describeOutput(project, parsed.data.output, parsed.data.scope) };
        } catch (e) {
          return { content: (e as Error).message, is_error: true };
        }
      }
      case "version": {
        const parsed = VersionInput.safeParse(input);
        if (!parsed.success) return { content: "Say which version action to take.", is_error: true };
        if (!this.design) return { content: "This chat is not working on a saved design, so there are no branches or revisions.", is_error: true };
        if (turn.ops.length && parsed.data.action !== "list_revisions") return { content: "Edits are pending in this turn; version actions come before or after them, in another message.", is_error: true };
        try {
          return { content: this.runVersion(this.design, parsed.data) };
        } catch (e) {
          return { content: (e as Error).message, is_error: true };
        }
      }
      case "undo_last_request": {
        if (turn.ops.length) return { content: "Edits are pending in this turn; undo applies to the previous request only. Ask the user to confirm in the next message.", is_error: true };
        const undone = this.store.undo();
        if (!undone) return { content: "There is nothing to undo.", is_error: true };
        turn.undone = undone;
        return { content: `Undone: ${undone.summary.join("; ")}. Current model:\n${modelSummary(undone.project)}` };
      }
      default:
        return { content: `Unknown tool ${name}.`, is_error: true };
    }
  }
}

function describeElement(project: Project, id: string): unknown {
  const room = project.rooms.find((r) => r.id === id);
  if (room) {
    const walls = deriveWalls(project, room.level);
    return { ...room, centreline: roomRect(room), clear: clearRect(walls, room), walls: walls.filter((w) => w.sourceRooms.includes(id)) };
  }
  const opening = project.openings.find((o) => o.id === id);
  if (opening) {
    const host = project.rooms.find((r) => r.id === opening.host.room);
    const res = host ? resolveOpening(project, deriveWalls(project, host.level), opening) : null;
    return { ...opening, along: res && { from: res.from, to: res.to, line: `${res.orient === "h" ? "y" : "x"}=${res.at}` }, leadsTo: res?.otherRoom ?? (res?.wall ? "outside" : null) };
  }
  const level = project.levels.find((l) => l.id === id);
  if (level) return level;
  return { id, error: "not found" };
}

export interface Reference {
  id: string;
  kind: string;
  label: string;
  why: string;
  score: number;
}

const SYNONYMS: [RegExp, string][] = [
  [/\b(hall|drawing room|living room)\b/g, "living"],
  [/\b(master|mbr)\b/g, "master bedroom"],
  [/\b(bath|bathroom|wc|washroom|restroom)\b/g, "toilet"],
  [/\b(pooja|prayer)\b/g, "puja"],
  [/\b(car park|car parking|garage)\b/g, "parking"],
  [/\b(elevator)\b/g, "lift"],
  [/\b(stairs|staircase|steps)\b/g, "stair"],
  [/\b(upstairs|first floor|1st floor)\b/g, "first"],
  [/\b(downstairs|ground floor)\b/g, "ground"],
];

/** Words that say nothing about which element is meant. */
const STOP = new Set(["the", "a", "an", "my", "our", "that", "this", "please", "of", "in", "on", "to", "for", "and"]);

const normalise = (s: string) =>
  SYNONYMS.reduce((t, [re, to]) => t.replace(re, to), s.toLowerCase().replace(/[^a-z0-9 ]+/g, " "))
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));

/**
 * What the user called something, ranked against the model: room and level
 * names, types, catalogue names and ids, with the reason each matched so the
 * agent can decide whether to ask.
 */
export function resolveReference(project: Project, phrase: string, kind: Reference["kind"] = "any"): Reference[] {
  const words = normalise(phrase);
  if (!words.length) return [];
  const levelName = (id: string) => project.levels.find((l) => l.id === id)?.name ?? id;
  const candidates: { id: string; kind: string; label: string; text: string }[] = [];
  for (const r of project.rooms) candidates.push({ id: r.id, kind: "room", label: `${r.name} on ${levelName(r.level)}`, text: `${r.name} ${r.type} ${levelName(r.level)} ${r.flat ?? ""} ${r.zoneTags.join(" ")}` });
  for (const l of project.levels) candidates.push({ id: l.id, kind: "level", label: l.name, text: `${l.name} ${l.kind} floor level` });
  for (const o of project.openings) {
    const host = project.rooms.find((r) => r.id === o.host.room);
    candidates.push({ id: o.id, kind: "opening", label: `${o.type} on the ${o.host.side} of ${host?.name ?? o.host.room}`, text: `${o.type} ${o.host.side} ${host?.name ?? ""} ${host?.type ?? ""}` });
  }
  for (const it of project.items) {
    const cat = catalogueItem(it.catalogue);
    const host = project.rooms.find((r) => r.id === it.room);
    candidates.push({ id: it.id, kind: "item", label: `${cat?.name ?? it.catalogue} in ${host?.name ?? it.room}`, text: `${cat?.name ?? ""} ${it.catalogue} ${host?.name ?? ""}` });
  }
  for (const c of project.cores) candidates.push({ id: c.id, kind: "core", label: coreName(c), text: `${coreName(c)} ${c.kind}` });
  for (const p of project.mep) {
    const host = project.rooms.find((r) => r.id === p.room);
    candidates.push({ id: p.id, kind: "mep", label: `${MEP_LABELS[p.kind]} in ${host?.name ?? p.room}`, text: `${MEP_LABELS[p.kind]} ${p.kind} ${host?.name ?? ""} ${p.circuit ?? ""}` });
  }

  const out: Reference[] = [];
  for (const c of candidates) {
    if (kind !== "any" && c.kind !== kind) continue;
    const text = normalise(c.text);
    // Exact words, or a longer word the candidate starts with ("bedroom" for "bedrooms"), never one-letter prefixes
    const hit = [...new Set(words.filter((w) => text.some((t) => t === w || (w.length >= 4 && t.length >= 4 && (t.startsWith(w) || w.startsWith(t))))))];
    if (!hit.length) continue;
    // Every word matching, and matching the whole name, beat a single word
    const exact = normalise(c.label).join(" ") === words.join(" ") ? 2 : 0;
    // A candidate whose own words are all accounted for beats one that only shares a word
    const covered = text.every((t) => t.length < 4 || hit.some((w) => t === w || t.startsWith(w))) ? 0.25 : 0;
    out.push({ id: c.id, kind: c.kind, label: c.label, why: `matched ${hit.join(", ")}`, score: hit.length / words.length + exact + covered });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 6);
}

/** Regenerates one output and says what it holds, for the agent to describe. */
export function describeOutput(project: Project, output: string, scope?: string): string {
  const level = (id?: string) => {
    const l = id ? (project.levels.find((x) => x.id === id) ?? project.levels.find((x) => x.name.toLowerCase() === id.toLowerCase())) : project.levels[0];
    if (!l) throw new Error(`There is no level "${id}". Levels: ${project.levels.map((x) => `${x.id} (${x.name})`).join(", ")}.`);
    return l;
  };
  const tableText = (t: Table) => [t.title, t.head.join(" | "), ...t.rows.slice(0, 20).map((r) => r.join(" | "))].join("\n");
  switch (output) {
    case "plan":
    case "electrical":
    case "plumbing": {
      const l = level(scope);
      const layer = output === "plan" ? undefined : (output as "electrical" | "plumbing");
      const sheet = floorPlanSheet(project, l.id, layer ? { layer } : {});
      const rooms = project.rooms.filter((r) => r.level === l.id);
      const points = project.mep.filter((p) => rooms.some((r) => r.id === p.room));
      return [
        `Regenerated: ${sheet.title}.`,
        `${rooms.length} rooms, ${project.openings.filter((o) => rooms.some((r) => r.id === o.host.room)).length} openings${layer ? `, ${points.length} points on this floor` : ""}.`,
        ...rooms.slice(0, 20).map((r) => `- ${r.name}`),
      ].join("\n");
    }
    case "elevation": {
      const side = (scope ?? "north") as Side;
      return `Regenerated: ${elevationSheet(project, side).title}.`;
    }
    case "section":
      return `Regenerated: ${sectionSheet(project).title}.`;
    case "site":
      return `Regenerated: ${siteplanSheet(project).title}.`;
    case "3d": {
      const scene = buildScene(project);
      return `Regenerated the 3D model: ${scene.boxes.length} solids over ${project.levels.length} levels. The app shows it; it is not an image you can see.`;
    }
    case "details": {
      const sheets = detailSheets(project);
      return sheets.length ? [`Regenerated ${sheets.length} detail elevations at 1:25:`, ...sheets.map((s) => `- ${s.title}`)].join("\n") : "There is nothing to detail yet: detail elevations come from kitchen counters, wardrobes and TV units.";
    }
    case "schedules":
      return [doorWindowTable(project), flooringTable(project), finishesTable(project), areaStatementTable(project), ...(project.mep.length ? [electricalTable(project), plumbingTable(project)] : [])].map(tableText).join("\n\n");
    case "estimate": {
      const boq = computeBoq(project);
      return [`Construction estimate ${formatInr(boq.total)} (${formatInr(boq.perSqft)} per sq ft built-up).`, tableText(boqTable(project, boq))].join("\n");
    }
    case "drawings": {
      const set = drawingSet(project);
      return [`Regenerated the drawing set, ${set.length} sheets:`, ...set.map((d) => `- ${d.tab}: ${d.sheet.title}`)].join("\n");
    }
    default:
      throw new Error(`There is no output "${output}".`);
  }
}
