/**
 * The specification's reference project: stilt + 3 floors on a 62'6" × 52'
 * plot with the road on the north, a 12 ft access passage, and a mango and a
 * neem to keep. Each upper floor is one 3-bedroom flat. Built in the steps the
 * chat would take, then written to ./out/reference.
 *
 *   npm run reference
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { areaStatementTable, boqTable, buildScene, Design, flatCostTable, renderDrawingSetPdf, renderFloorPlanSvg, renderViewer3dHtml, renderViewerHtml, sceneToGlb, tablesToCsv, computeBoq, type OpInput } from "../src/index.js";
import { REF_BUILDING, REF_PARKING, REF_SITE, REF_STRUCTURE, referenceFlats, referencePlot } from "../src/templates/reference-project.js";

const design = new Design("reference", "Stilt + 3, 62'6\" × 52' North", referencePlot());
const store = design.store;

function step(label: string, ops: OpInput[]) {
  const r = store.commit(ops, { label });
  console.log(`\n> ${label}\n  ${r.status.toUpperCase()}${r.error ? `: ${r.error.message}` : ""}`);
  for (const s of r.summary.slice(0, 6)) console.log(`  · ${s}`);
  if (r.status !== "committed") throw new Error(`${label}: ${r.status}`);
}

step("Plot 62'6\" × 52', 30 ft road on the north, 12 ft access passage, keep the mango and neem", REF_SITE);
step("Stilt + 3: stair, lobby and lift, and the client's 3-bedroom plan on each floor", REF_BUILDING);
step("One flat per floor; stair and lobby are common", referenceFlats(store.current));
step("Park three cars on the stilt", REF_PARKING);
step("Frame it", REF_STRUCTURE);
design.tag("Reference scheme");

const p = store.current;
const out = "out/reference";
mkdirSync(out, { recursive: true });
for (const level of p.levels) writeFileSync(`${out}/plan-${level.id}.svg`, renderFloorPlanSvg(p, level.id));
writeFileSync(`${out}/model.json`, JSON.stringify(p, null, 2));
writeFileSync(`${out}/drawings.pdf`, renderDrawingSetPdf(p));
writeFileSync(`${out}/viewer.html`, renderViewerHtml(p));
writeFileSync(`${out}/3d.html`, renderViewer3dHtml(p));
writeFileSync(`${out}/model.glb`, sceneToGlb(buildScene(p)));
const boq = computeBoq(p);
writeFileSync(`${out}/areas-and-cost.csv`, tablesToCsv([areaStatementTable(p), flatCostTable(p, boq), boqTable(p)]));

console.log("\nArea statement:");
for (const row of areaStatementTable(p).rows) console.log(`  ${row.join("  ")}`);
console.log("\nFindings:");
for (const f of store.commit([]).findings.filter((f) => f.severity !== "info")) console.log(`  [${f.severity}] ${f.message}`);
console.log(`\nWrote ${out}/drawings.pdf, viewer.html, 3d.html, model.glb, plan SVGs and areas-and-cost.csv`);
