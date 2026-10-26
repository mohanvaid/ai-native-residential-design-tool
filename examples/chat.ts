/**
 * Chat with the design in a terminal. Starts from the demo 1BHK on a 30×40 ft
 * east-facing plot and rewrites out/plan-<level>.svg after every change.
 *
 *   ANTHROPIC_API_KEY=... npm run chat
 *
 * Type "quit" to leave.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DesignAgent } from "../src/agent/agent.js";
import { boqTable, ModelStore, renderDrawingSetPdf, renderFloorPlanSvg, renderViewer3dHtml, renderViewerHtml, tableToCsv } from "../src/index.js";
import { DEMO_GROUND_FLOOR, DEMO_ROAD, demoPlot } from "../src/templates/demo-house.js";

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error("Set ANTHROPIC_API_KEY to chat with the design.");
  process.exit(1);
}

const store = new ModelStore(demoPlot());
store.commit(DEMO_ROAD);
store.commit(DEMO_GROUND_FLOOR);
const agent = new DesignAgent(store);

function writePlans(): void {
  mkdirSync("out", { recursive: true });
  for (const level of store.current.levels) writeFileSync(`out/plan-${level.id}.svg`, renderFloorPlanSvg(store.current, level.id));
  writeFileSync("out/plans.pdf", renderDrawingSetPdf(store.current));
  writeFileSync("out/viewer.html", renderViewerHtml(store.current));
  writeFileSync("out/3d.html", renderViewer3dHtml(store.current));
  writeFileSync("out/cost-estimate.csv", tableToCsv(boqTable(store.current)));
}

writePlans();
console.log("Demo house loaded (30×40 ft, east road). Plans are in ./out (open out/viewer.html on a phone). Ask for a change, e.g. \"make the bedroom 2 ft wider\".");
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const text = (await rl.question("\nyou> ")).trim();
  if (!text) continue;
  if (text === "quit" || text === "exit") break;
  try {
    const turn = await agent.send(text);
    console.log(`\n${turn.reply}`);
    if (turn.outcome !== "unchanged") writePlans();
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
rl.close();
