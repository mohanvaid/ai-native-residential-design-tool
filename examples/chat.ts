/**
 * Chat with the design in a terminal. Starts from the demo 1BHK on a 30×40 ft
 * east-facing plot, or reopens a saved design, and rewrites the drawings in
 * ./out after every change. Every change is saved to ./designs.
 *
 *   ANTHROPIC_API_KEY=... npm run chat               # new design from the demo
 *   ANTHROPIC_API_KEY=... npm run chat -- <id>       # reopen a saved design
 *
 * Commands: /help, /designs, /revs, /branches, /branch <name> [from],
 * /switch <name>, /tag <label>, /compare <ref> [ref], /revert <rev>, quit.
 * A ref is a branch ("main"), a revision ("main@C", "@C") or a tag.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DesignAgent } from "../src/agent/agent.js";
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
let agent = new DesignAgent(design.store);

function writePlans(): void {
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
      agent = new DesignAgent(design.store);
      console.log(`Now on ${where()}.`);
      return true;
    }
    case "switch":
      design.switchTo(args[0] ?? "main");
      agent = new DesignAgent(design.store);
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
    case "revert": {
      const target = design.resolve(`@${args[0] ?? ""}`);
      design.store.revert(target.version);
      console.log(`Reverted to Rev ${revisionLabel(target.version)} as ${where()}.`);
      return true;
    }
    default:
      console.log("Commands: /designs, /revs, /branches, /branch <name> [from], /switch <name>, /tag <label>, /compare <ref> [ref], /revert <rev>, quit.");
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
    const turn = await agent.send(text);
    console.log(`\n${turn.reply}`);
    if (turn.outcome !== "unchanged") writePlans();
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
rl.close();
