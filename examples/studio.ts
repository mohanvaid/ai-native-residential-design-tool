/**
 * The edit canvas and chat in one page.
 *
 *   npm run studio                      # new design from the demo
 *   npm run studio -- <id>              # reopen a saved design
 *   ANTHROPIC_API_KEY=... npm run studio    # with the chat box live
 */
import { FileRepository, startStudio, DesignAgent, type Design } from "../src/index.js";
import { DEMO_GROUND_FLOOR, DEMO_ROAD, demoPlot } from "../src/templates/demo-house.js";

const id = process.argv[2];
const repo = new FileRepository("designs");
let design: Design;
if (id) design = repo.load(id);
else {
  const plot = demoPlot();
  design = repo.create(plot.name, plot);
  design.store.commit(DEMO_ROAD, { label: "Plot and road" });
  design.store.commit(DEMO_GROUND_FLOOR, { label: "Ground floor from the 1BHK template" });
  repo.save(design);
}

const chat = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
const { url } = await startStudio(design, {
  port: Number(process.env.PORT ?? 5173),
  baseUrl: process.env.STUDIO_URL,
  agent: chat ? new DesignAgent(design) : undefined,
  save: (d) => repo.save(d),
});
console.log(`${design.name} is at ${url} (saved as designs/${design.id}.json).`);
console.log(chat ? "Drag rooms on the plan or ask for a change in the box." : "Drag rooms on the plan. Set ANTHROPIC_API_KEY to turn the chat box on.");
