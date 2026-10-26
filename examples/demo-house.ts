/**
 * A 30 × 40 ft east-facing plot on a 30 ft road in Chennai, built and then
 * edited the way the chat would: each step is one transaction of typed ops.
 * Writes plans and the model to ./out.
 *
 *   npm run demo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ftIn, ModelStore, openingSchedule, renderFloorPlanPdf, renderFloorPlanSvg, renderViewerHtml, type OpInput, type TransactionResult } from "../src/index.js";
import { DEMO_GROUND_FLOOR, DEMO_ROAD, demoPlot } from "../src/templates/demo-house.js";

const store = new ModelStore(demoPlot());

function step(label: string, ops: OpInput[], opts: { acceptBlocking?: boolean } = {}): TransactionResult {
  const r = store.commit(ops, { label, ...opts });
  console.log(`\n> ${label}\n  ${r.status.toUpperCase()}${r.error ? `: ${r.error.message}` : ""}`);
  for (const s of r.summary) console.log(`  · ${s}`);
  for (const f of r.findings.filter((f) => f.severity !== "info")) console.log(`  [${f.severity}] ${f.message}`);
  return r;
}

step("Plot is 30×40 ft, east-facing, 30 ft road", DEMO_ROAD);
step("Start from a 1BHK ground-floor template", DEMO_GROUND_FLOOR);

step("Make the living room 2 ft deeper, take it from the dining", [
  { op: "ResizeRoom", target: "rm_liv", args: { edge: "north", delta: ftIn(2), strategy: "shrink_neighbour" }, reason: "User asked: make the hall 2 ft deeper" },
]);

step("Push the living room 1 m towards the road (expected to be blocked by the front setback)", [
  { op: "MoveRoom", target: "rm_liv", args: { dx: 1000 } },
]);

step("Add a first floor with a bedroom and toilet", [
  { op: "AddLevel", args: { id: "lv_ff", name: "First" } },
  { op: "AddRoom", args: { id: "rm_bed2", name: "Bedroom 2", type: "bedroom", level: "lv_ff", x: 600, y: 1200, width: 4200, depth: 3600 } },
  { op: "AddRoom", args: { id: "rm_tlt2", name: "Toilet 2", type: "toilet", level: "lv_ff", x: 600, y: 4800, width: 1800, depth: 1800 } },
  { op: "AddOpening", args: { type: "window", room: "rm_bed2", side: "south", width: 1500 } },
  { op: "AddOpening", args: { type: "door", room: "rm_bed2", side: "east", offset: 2400 } },
  { op: "AddOpening", args: { type: "door", room: "rm_tlt2", side: "south", offset: 600, width: 750, swing: { hinge: "end", into: "host" } } },
  { op: "AddOpening", args: { type: "ventilator", room: "rm_tlt2", side: "west" } },
]);

const undone = store.undo();
console.log(`\n> Undo the last change\n  ${undone?.summary.join("; ")}`);
step("Redo it: add the first floor again", store.versions.find((v) => v.label.startsWith("Add a first floor"))!.ops);

const p = store.current;
mkdirSync("out", { recursive: true });
for (const level of p.levels) writeFileSync(`out/plan-${level.id}.svg`, renderFloorPlanSvg(p, level.id));
writeFileSync("out/model.json", JSON.stringify(p, null, 2));
writeFileSync("out/plans.pdf", renderFloorPlanPdf(p));
writeFileSync("out/viewer.html", renderViewerHtml(p));
console.log(`\nVersion ${p.version}. Door and window schedule:`);
for (const row of openingSchedule(p)) console.log(`  ${row.mark.padEnd(4)}${row.type.padEnd(11)}${row.width} × ${row.height}, sill ${row.sill}  × ${row.count}`);
console.log("\nRule findings:");
for (const f of store.commit([]).findings.filter((f) => f.source !== "core")) console.log(`  [${f.severity}] ${f.message}`);
console.log("\nWrote out/viewer.html (open on a phone), out/plans.pdf, out/plan-lv_gf.svg, out/plan-lv_ff.svg, out/model.json");
