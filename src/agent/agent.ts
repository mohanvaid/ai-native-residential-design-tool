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
import { dryRun, type ModelStore, type TransactionResult } from "../engine.js";
import type { Finding, Project } from "../model/schema.js";
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
  ids: z.array(z.string()).optional().describe("Room, opening or level ids. Omit for the full model summary."),
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

  constructor(
    readonly store: ModelStore,
    private readonly api: MessagesApi = anthropicMessages(),
    private readonly opts: AgentOptions = {},
  ) {}

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
    const committed = this.store.commit(turn.ops, { label: userText, acceptBlocking: true });
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
