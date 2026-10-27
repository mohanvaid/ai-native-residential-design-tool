/**
 * Chat with the design in a terminal. Starts from the demo 1BHK on a 30×40 ft
 * east-facing plot, or reopens a saved design, and rewrites the drawings in
 * ./out after every change. Every change is saved to ./designs.
 *
 *   ANTHROPIC_API_KEY=... npm run chat               # new design from the demo
 *   ANTHROPIC_API_KEY=... npm run chat -- <id>       # reopen a saved design
 *
 * Commands: /help, /designs, /revs, /branches, /branch <name> [from],
 * /switch <name>, /tag <label>, /compare <ref> [ref], /revert <rev>,
 * /member <id> <role> [licence], /me <id>, /comment [on id,id] <text>,
 * /comments, /resolve <id>, /signoff [construction|approval|tender], quit.
 * A ref is a branch ("main"), a revision ("main@C", "@C") or a tag.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DesignAgent } from "../src/agent/agent.js";
import type { Role } from "../src/index.js";
import { boqTable, compareProjects, comparisonTables, comparisonText, FileRepository, renderDrawingSetPdf, renderFloorPlanSvg, renderViewer3dHtml, renderViewerHtml, revisionLabel, tablesToCsv, tableToCsv, type Design } from "../src/index.js";
import { DEMO_GROUND_FLOOR, DEMO_ROAD, demoPlot } from "../src/templates/demo-house.js";

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Set ANTHROPIC_API_KEY to chat with the design.");
  process.exit(1);
}

const repo = new FileRepository("designs");
const id = process.argv[2];
let design: Design;
if (id) design = repo.load(id);
else {
  const plot = demoPlot();
  design = repo.create(plot.name, plot);
  design.store.commit(DEMO_ROAD, { label: "Plot and road" });
  design.store.commit(DEMO_GROUND_FLOOR, { label: "Ground floor from the 1BHK template" });
  repo.save(design);
}
// The agent is given the whole design, so its version tool can list, tag, branch and compare
let agent = new DesignAgent(design);

/** Who is at the keyboard, once the design has members. */
let me: string | undefined;

function writePlans(): void {
  design.stamped(() => writeSheets());
}

function writeSheets(): void {
  const p = design.store.current;
  mkdirSync("out", { recursive: true });
  for (const level of p.levels) writeFileSync(`out/plan-${level.id}.svg`, renderFloorPlanSvg(p, level.id));
  writeFileSync("out/plans.pdf", renderDrawingSetPdf(p));
  writeFileSync("out/viewer.html", renderViewerHtml(p));
  writeFileSync("out/3d.html", renderViewer3dHtml(p));
  writeFileSync("out/cost-estimate.csv", tableToCsv(boqTable(p)));
  repo.save(design);
}

const where = () => `${design.name}, branch ${design.current}, Rev ${revisionLabel(design.store.current.version)}`;

/** Runs a slash command; returns true when the design changed. */
function command(line: string): boolean {
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case "designs":
      for (const d of repo.list()) console.log(`${d.id}  ${d.name}  (${d.branches.join(", ")}; ${d.current} Rev ${d.rev})`);
      return false;
    case "revs":
      for (const r of design.revisions()) console.log(`Rev ${r.rev.padEnd(3)} ${r.at.slice(0, 16).replace("T", " ")}  ${r.label}${r.tag ? `  [${r.tag}]` : ""}`);
      return false;
    case "branches":
      for (const [name, b] of design.branches) console.log(`${name === design.current ? "*" : " "} ${name}  Rev ${revisionLabel(b.store.current.version)}${b.from ? `  (from ${b.from.branch} Rev ${revisionLabel(b.from.version)})` : ""}`);
      return false;
    case "branch": {
      if (!args[0]) throw new Error("Usage: /branch <name> [from-ref]");
      const from = args[1] ? design.resolve(args[1]) : undefined;
      design.createBranch(args[0], from && { branch: from.branch, version: from.version });
      console.log(`Now on ${where()}.`);
      return true;
    }
    case "switch":
      design.switchTo(args[0] ?? "main");
      console.log(`Now on ${where()}.`);
      return true;
    case "tag":
      design.tag(args.join(" ") || "Saved");
      console.log(`Tagged ${where()} as "${args.join(" ") || "Saved"}".`);
      repo.save(design);
      return false;
    case "compare": {
      if (!args[0]) throw new Error("Usage: /compare <ref> [ref]");
      const a = design.resolve(args[0]);
      const b = design.resolve(args[1] ?? design.current);
      const c = compareProjects(a.project, b.project, { a: `${a.branch} Rev ${revisionLabel(a.version)}`, b: `${b.branch} Rev ${revisionLabel(b.version)}` });
      console.log(comparisonText(c));
      mkdirSync("out", { recursive: true });
      writeFileSync("out/compare.csv", tablesToCsv(comparisonTables(c)));
      console.log("(Full comparison in out/compare.csv.)");
      return false;
    }
    case "member": {
      const [id, role, licence] = args;
      if (!id || !role) throw new Error("Usage: /member <id> <owner|collaborator|reviewer> [licence]");
      design.addMember({ id, name: id[0]!.toUpperCase() + id.slice(1), role: role as Role, ...(licence ? { licence } : {}) }, me);
      me ??= id;
      console.log(`${id} is a ${role} on this design${licence ? ` (licence ${licence})` : ""}.${me === id ? ` You are ${id}.` : ""}`);
      return false;
    }
    case "me":
      if (!args[0]) throw new Error("Usage: /me <member id>");
      design.require(args[0], "read");
      me = args[0];
      console.log(`You are ${design.member(me)?.name ?? me}, ${design.member(me)?.role ?? "not a member"}.`);
      return false;
    case "comment": {
      const on = args[0] === "on" ? (args[1] ?? "").split(",").filter(Boolean) : [];
      const text = (on.length ? args.slice(2) : args).join(" ");
      if (!text) throw new Error("Usage: /comment [on id,id] <text>");
      const c = design.comment(me, text, on);
      console.log(`${c.id}: noted${on.length ? ` on ${on.join(", ")}` : ""}.`);
      return false;
    }
    case "comments": {
      const open = design.openComments();
      if (!open.length) console.log("No open comments.");
      for (const c of open) console.log(`${c.id}  ${design.member(c.author)?.name ?? c.author}${c.elements.length ? ` on ${c.elements.join(", ")}` : ""}: ${c.text}`);
      return false;
    }
    case "resolve":
      if (!args[0]) throw new Error("Usage: /resolve <comment id>");
      design.resolveComment(args[0], me);
      console.log(`${args[0]} resolved.`);
      return false;
    case "signoff": {
      const s = design.signOff(me ?? "", (args[0] as "construction" | "approval" | "tender") ?? "construction");
      console.log(`${s.name} signed off ${s.branch} Rev ${revisionLabel(s.version)} for ${s.purpose}. It is frozen; the drawings now carry the declaration instead of the advisory stamp.`);
      return true;
    }
    case "revert": {
      const target = design.resolve(`@${args[0] ?? ""}`);
      design.store.revert(target.version);
      console.log(`Reverted to Rev ${revisionLabel(target.version)} as ${where()}.`);
      return true;
    }
    default:
      console.log("Commands: /designs, /revs, /branches, /branch <name> [from], /switch <name>, /tag <label>, /compare <ref> [ref], /revert <rev>, /member <id> <role> [licence], /me <id>, /comment [on id,id] <text>, /comments, /resolve <id>, /signoff [construction|approval|tender], quit.");
      return false;
  }
}

writePlans();
console.log(`${where()} (saved as designs/${design.id}.json). Plans are in ./out (open out/viewer.html on a phone). Ask for a change, e.g. "make the bedroom 2 ft wider", or type /help.`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const text = (await rl.question("\nyou> ")).trim();
  if (!text) continue;
  if (text === "quit" || text === "exit") break;
  try {
    if (text.startsWith("/")) {
      if (command(text)) writePlans();
      continue;
    }
    design.require(me, "edit");
    const turn = await agent.send(text);
    console.log(`\n${turn.reply}`);
    if (turn.outcome !== "unchanged") writePlans();
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
rl.close();
