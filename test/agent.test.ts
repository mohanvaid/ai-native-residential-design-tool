import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { DesignAgent, TOOLS, type MessagesApi } from "../src/agent/agent.js";
import { revisionLabel } from "../src/agent/report.js";
import { modelSummary, trueFacing } from "../src/agent/summary.js";
import { boundaryToRect, ftIn, ModelStore, type OpInput } from "../src/index.js";
import { DEMO_GROUND_FLOOR, DEMO_ROAD, demoPlot } from "../src/templates/demo-house.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** A scripted stand-in for Claude: returns the queued responses in order and records every request. */
class ScriptedModel implements MessagesApi {
  readonly requests: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  private n = 0;
  constructor(private readonly script: Block[][]) {}
  async create(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming) {
    this.requests.push(structuredClone(params));
    const blocks = this.script.shift();
    if (!blocks) throw new Error("script exhausted");
    const content = blocks.map((b) => (b.type === "tool_use" ? { ...b, id: `toolu_${++this.n}` } : { ...b, citations: null }));
    return {
      id: `msg_${this.n}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content,
      stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Beta.Messages.BetaMessage;
  }
  /** The tool results sent back in the most recent request. */
  lastToolResults(): { content: string; is_error?: boolean }[] {
    const last = this.requests[this.requests.length - 1]!.messages.at(-1)!;
    return (last.content as { type: string; content: string; is_error?: boolean }[]).filter((b) => b.type === "tool_result");
  }
}

function demoStore(): ModelStore {
  const store = new ModelStore(demoPlot());
  store.commit(DEMO_ROAD);
  store.commit(DEMO_GROUND_FLOOR);
  return store;
}

const apply = (ops: OpInput[], assumptions: string[] = []): Block => ({ type: "tool_use", name: "apply_edits", input: { ops, assumptions } });
const say = (text: string): Block => ({ type: "text", text });

describe("DesignAgent", () => {
  it("turns a request into one committed revision with a computed change summary", async () => {
    const store = demoStore();
    const v = store.current.version;
    const model = new ScriptedModel([
      [apply([{ op: "ResizeRoom", target: "rm_liv", args: { edge: "north", delta: ftIn(2), strategy: "shrink_neighbour" } }], ["Deeper means the north wall moves; space taken from the Dining"])],
      [say("Done: the living room is 2 ft deeper, taken from the dining room.")],
    ]);
    const agent = new DesignAgent(store, model);
    const turn = await agent.send("make the hall 2 ft deeper");

    expect(turn.outcome).toBe("committed");
    expect(store.current.version).toBe(v + 1);
    expect(turn.summaryLine).toMatch(/^Rev C: /);
    expect(turn.summaryLine).toContain(`Living now 13'3" × 15'3" (was 13'3" × 13'3")`);
    expect(turn.summaryLine).toContain("Dining now");
    expect(turn.reply.endsWith(turn.summaryLine)).toBe(true);
    expect(turn.assumptions).toEqual(["Deeper means the north wall moves; space taken from the Dining"]);
    expect(model.lastToolResults()[0]!.content).toMatch(/^APPLIED/);
  });

  it("sends the model summary with the user's message and keeps the system prompt and tools fixed", async () => {
    const model = new ScriptedModel([[say("Hello")], [say("Hi again")]]);
    const agent = new DesignAgent(demoStore(), model);
    await agent.send("hi");
    await agent.send("hi");
    const [a, b] = model.requests;
    expect(a!.messages[0]!.content).toContain("rm_liv \"Living\"");
    expect(a!.messages[0]!.content).toContain("hi");
    expect(JSON.stringify(a!.system)).toBe(JSON.stringify(b!.system));
    expect(JSON.stringify(a!.tools)).toBe(JSON.stringify(b!.tools));
    expect(a!.model).toBe("claude-opus-5-5");
    expect(a!.tool_choice).toEqual({ type: "auto" });
    expect(b!.messages).toHaveLength(3); // the first exchange is kept as history
  });

  it("does not apply a change that breaks a rule, and reports it to the model", async () => {
    const store = demoStore();
    const v = store.current.version;
    const model = new ScriptedModel([
      [apply([{ op: "MoveRoom", target: "rm_liv", args: { dx: 1000 } }])],
      [say("That would put the living room inside the 3 m front setback. I could make it deeper instead.")],
    ]);
    const turn = await new DesignAgent(store, model).send("move the living room 1 m towards the road");
    expect(turn.outcome).toBe("unchanged");
    expect(store.current.version).toBe(v);
    expect(model.lastToolResults()[0]!.content).toMatch(/^BLOCKED[\s\S]*front setback/i);
  });

  it("applies a blocked change only when the user accepted it", async () => {
    const store = demoStore();
    const model = new ScriptedModel([
      [{ type: "tool_use", name: "apply_edits", input: { ops: [{ op: "MoveRoom", target: "rm_liv", args: { dx: 1000 } }], assumptions: [], accept_blocking: true } }],
      [say("Moved, as you asked; it now breaks the front setback.")],
    ]);
    const turn = await new DesignAgent(store, model).send("yes, move it anyway");
    expect(turn.outcome).toBe("committed");
    expect(turn.summaryLine).toMatch(/blocking issue/);
  });

  it("groups several apply_edits calls in one message into one revision", async () => {
    const store = demoStore();
    const v = store.current.version;
    const model = new ScriptedModel([
      [apply([{ op: "RenameRoom", target: "rm_bed1", args: { name: "Master Bedroom" } }])],
      [apply([{ op: "AddOpening", args: { type: "window", room: "rm_bed1", side: "south", offset: 300, width: 600 } }])],
      [say("Renamed it and added a small window.")],
    ]);
    const turn = await new DesignAgent(store, model).send("call it master bedroom and add a 2 ft window on the south wall");
    expect(store.current.version).toBe(v + 1);
    expect(store.current.rooms.find((r) => r.id === "rm_bed1")!.name).toBe("Master Bedroom");
    expect(turn.summaryLine).toContain("Bedroom renamed Master Bedroom");
    expect(turn.summaryLine).toContain("1 opening(s) added");
  });

  it("returns invalid or failing ops to the model as errors without changing anything", async () => {
    const store = demoStore();
    const model = new ScriptedModel([
      [apply([{ op: "ResizeRoom", target: "rm_nope", args: { edge: "east", delta: 300 } }])],
      [{ type: "tool_use", name: "apply_edits", input: { ops: [{ op: "Teleport" }], assumptions: [] } }],
      [say("I couldn't find that room.")],
    ]);
    const turn = await new DesignAgent(store, model).send("make the study wider");
    expect(turn.outcome).toBe("unchanged");
    const results = model.lastToolResults();
    expect(results[0]!.is_error).toBe(true);
  });

  it("undoes the previous request as a new revision", async () => {
    const store = demoStore();
    const model = new ScriptedModel([
      [apply([{ op: "RemoveRoom", target: "rm_puja" }])],
      [say("Removed the puja room.")],
      [{ type: "tool_use", name: "undo_last_request", input: {} }],
      [say("Brought the puja room back.")],
    ]);
    const agent = new DesignAgent(store, model);
    await agent.send("remove the puja room");
    expect(store.current.rooms.some((r) => r.id === "rm_puja")).toBe(false);
    const turn = await agent.send("undo");
    expect(turn.outcome).toBe("undone");
    expect(store.current.rooms.some((r) => r.id === "rm_puja")).toBe(true);
    expect(turn.summaryLine).toContain("added Puja");
  });

  it("answers questions without creating a revision", async () => {
    const store = demoStore();
    const v = store.current.version;
    const model = new ScriptedModel([[{ type: "tool_use", name: "query_model", input: { ids: ["rm_tlt1"] } }], [say("The toilet is 5'4\" × 5'6\" clear.")]]);
    const turn = await new DesignAgent(store, model).send("how big is the toilet?");
    expect(turn.outcome).toBe("unchanged");
    expect(turn.summaryLine).toBe("");
    expect(store.current.version).toBe(v);
    expect(JSON.parse(model.lastToolResults()[0]!.content)[0].clear).toEqual({ x0: 715, x1: 2342.5, y0: 4857.5, y1: 6542.5 });
  });

  it("exposes tools with plain JSON Schemas", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["apply_edits", "query_model", "resolve_reference", "run_checks", "generate", "version", "undo_last_request"]);
    for (const t of TOOLS) expect(t.input_schema).not.toHaveProperty("$schema");
    expect(JSON.stringify(TOOLS[0]!.input_schema)).toContain("ResizeRoom");
  });
});

describe("model summary", () => {
  it("lists rooms with ids, clear sizes and neighbours, and openings with marks", () => {
    const s = modelSummary(demoStore().current);
    expect(s).toContain(`rm_kit "Kitchen" (kitchen), x 2400–4800, y 4800–8700; clear 7'6" × 12'3"`);
    expect(s).toMatch(/rm_tlt1 "Toilet".*S \(4800\): Bedroom 115mm/);
    expect(s).toContain("Roads: east side, 9.14 m");
    expect(s).toMatch(/door on Living's east side, offset 600, width 1050 .* to outside/);
  });

  it("names the true direction each plot side faces", () => {
    expect(trueFacing(0)).toEqual({ north: "N", east: "E", south: "S", west: "W" });
    expect(trueFacing(45)).toEqual({ north: "NW", east: "NE", south: "SE", west: "SW" });
  });

  it("labels revisions A, B ... Z, AA", () => {
    expect([1, 2, 26, 27, 28].map(revisionLabel)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });
});

it("keeps the template inside the plot", () => {
  const p = demoStore().current;
  expect(p.rooms.every((r) => boundaryToRect(r.boundary))).toBe(true);
});
