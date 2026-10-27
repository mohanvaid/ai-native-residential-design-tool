import { afterAll, describe, expect, it } from "vitest";
import { createStudio, Design, dryRun, newProject, planState, type OpInput, type Project } from "../src/index.js";
import type { AddressInfo } from "node:net";

function started(): Project {
  const r = dryRun(newProject({ id: "s", name: "Studio house", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
    { op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 1000, y: 1000, width: 4500, depth: 4000 } },
    { op: "AddRoom", args: { id: "bed", name: "Bedroom", type: "bedroom", level: "lv_gf", x: 6000, y: 1000, width: 3600, depth: 4000 } },
    { op: "AddOpening", args: { type: "door", room: "liv", side: "south", offset: 600, width: 1050 } },
    { op: "AddOpening", args: { type: "window", room: "liv", side: "west", width: 1500 } },
    { op: "AddOpening", args: { type: "door", room: "bed", side: "south", offset: 600 } },
    { op: "AddOpening", args: { type: "window", room: "bed", side: "east", width: 1500 } },
  ] as OpInput[]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

const design = new Design("s", "Studio house", started());
const server = createStudio(design, { as: undefined });
await new Promise<void>((done) => server.listen(0, done));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(() => void server.close());

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

describe("studio", () => {
  it("serves the page and the plan with room footprints in sheet coordinates", async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain("Studio house · studio");
    expect(page).toContain("/api/move");
    const plan = (await (await fetch(`${base}/api/plan`)).json()) as ReturnType<typeof planState>;
    expect(plan.rooms.map((r) => r.id)).toEqual(["liv", "bed"]);
    // Sheet space: x grows east from the margin, y grows downward from the plot's north edge
    const liv = plan.rooms.find((r) => r.id === "liv")!;
    expect(liv.width).toBe(4500);
    expect(plan.rooms.find((r) => r.id === "bed")!.x).toBeGreaterThan(liv.x);
    expect(plan.svg).toContain("<svg");
    expect(plan.levels).toEqual([{ id: "lv_gf", name: "Ground" }]);
  });

  it("takes a drag as a MoveRoom in the same history as everything else, and undoes it", async () => {
    const before = design.store.current.version;
    const moved = await post("/api/move", { room: "bed", dx: 302, dy: -1 });
    expect(moved.status).toBe(200);
    expect(moved.body.message).toMatch(/Bedroom moved 1'0" east/);
    expect(design.store.current.rooms.find((r) => r.id === "bed")!.boundary[0]![0]).toBe(6300);
    expect(design.store.current.version).toBe(before + 1);
    expect(moved.body.plan.canUndo).toBe(true);

    const undone = await post("/api/undo", {});
    expect(undone.body.ok).toBe(true);
    expect(design.store.current.rooms.find((r) => r.id === "bed")!.boundary[0]![0]).toBe(6000);
  });

  it("refuses a drag that would break the model, and says why", async () => {
    const r = await post("/api/move", { room: "bed", dx: -2000, dy: 0 });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("overlap");
    expect(design.store.current.rooms.find((r) => r.id === "bed")!.boundary[0]![0]).toBe(6000);
    expect((await post("/api/move", { room: "nope", dx: 100, dy: 0 })).body.message).toContain("no room nope");
  });

  it("says chat is off when no key was set, and serves a share link with a preview image", async () => {
    const chat = await post("/api/chat", { text: "make the bedroom wider" });
    expect(chat.status).toBe(503);
    expect(chat.body.error).toContain("Chat is off");

    const page = await (await fetch(`${base}/`)).text();
    const token = /\/s\/([a-z0-9]+)/.exec(page)![1]!;
    const shared = await fetch(`${base}/s/${token}`);
    const html = await shared.text();
    expect(html).toContain('<meta property="og:image"');
    expect(html).toContain("Studio house");
    const png = await fetch(`${base}/s/${token}/preview.png`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await png.arrayBuffer()).slice(0, 4)]).toEqual([137, 80, 78, 71]);
  });

  it("keeps a reviewer from dragging", async () => {
    const d = new Design("r", "Reviewed", started());
    d.addMember({ id: "mohan", name: "Mohan", role: "owner" });
    d.addMember({ id: "ravi", name: "Ravi", role: "reviewer" }, "mohan");
    const s = createStudio(d, { as: "ravi" });
    await new Promise<void>((done) => s.listen(0, done));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const res = await fetch(`${at}/api/move`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: "bed", dx: 300, dy: 0 }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Ravi is a reviewer");
    s.close();
  });
});
