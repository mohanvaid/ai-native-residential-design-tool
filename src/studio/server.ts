/**
 * The edit canvas: a small HTTP server that serves the plan, takes drags and
 * nudges as MoveRoom ops, and takes chat messages through the same agent, so
 * dragging and asking share one history and one undo. Everything goes through
 * the engine: the canvas never writes geometry, it only proposes ops.
 *
 *   npm run studio               # new design from the demo
 *   npm run studio -- <id>       # reopen a saved design
 *
 * A share link (/s/<token>) serves the read-only viewer with a preview image,
 * so a WhatsApp forward shows the plan before it is opened.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DesignAgent, type TurnResult } from "../agent/agent.js";
import { revisionLabel } from "../agent/report.js";
import { validate } from "../engine.js";
import { bbox, boundaryToRect } from "../model/geometry.js";
import { MARGIN } from "../output/frame.js";
import type { Finding, Project } from "../model/schema.js";
import { formatFtIn } from "../model/units.js";
import { floorPlanSheet } from "../output/floorplan.js";
import { sheetToPng } from "../output/raster.js";
import { escXml, sheetToSvg } from "../output/sheet.js";
import { renderViewerHtml } from "../output/viewer.js";
import type { OpInput } from "../ops/definitions.js";
import type { Design } from "../store/design.js";
import { STUDIO_HTML } from "./page.js";

export interface StudioOptions {
  port?: number;
  /** Member id the edits are made as, when the design has members. */
  as?: string;
  /** Base URL used in share links and the preview image tag. */
  baseUrl?: string;
  /** An agent for the chat box; without one the chat box says chat is off. */
  agent?: DesignAgent;
  /** Where to save after every change. */
  save?: (design: Design) => void;
}

interface PlanState {
  level: string;
  svg: string;
  revision: string;
  version: number;
  levels: { id: string; name: string }[];
  /** Room footprints in sheet coordinates, so the canvas can draw hit areas straight onto the SVG. */
  rooms: { id: string; name: string; x: number; y: number; width: number; depth: number }[];
  findings: { severity: Finding["severity"]; message: string; elements: string[] }[];
  canUndo: boolean;
  branch: string;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1e6) throw new Error("Request too large.");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function planState(design: Design, levelId?: string): PlanState {
  const project = design.store.current;
  const level = project.levels.find((l) => l.id === levelId) ?? project.levels[0]!;
  const sheet = design.stamped(() => floorPlanSheet(project, level.id));
  return {
    level: level.id,
    svg: sheetToSvg(sheet, { fluid: true, id: "plan" }),
    revision: revisionLabel(project.version),
    version: project.version,
    branch: design.current,
    levels: project.levels.map((l) => ({ id: l.id, name: l.name })),
    rooms: project.rooms
      .filter((r) => r.level === level.id)
      .flatMap((r) => {
        const rect = boundaryToRect(r.boundary);
        if (!rect) return [];
        // Sheet space: x from the plot's west edge less the margin, y pointing down from its north edge
        const plot = bbox(project.plot.boundary);
        return [{ id: r.id, name: r.name, x: rect.x0 - (plot.x0 - MARGIN), y: plot.y1 + MARGIN - rect.y1, width: rect.x1 - rect.x0, depth: rect.y1 - rect.y0 }];
      }),
    findings: validate(project)
      .filter((f) => f.severity !== "info")
      .slice(0, 40)
      .map((f) => ({ severity: f.severity, message: f.message, elements: f.elements })),
    canUndo: design.store.undoableVersions.length > 0,
  };
}

/** Rounds a dragged distance to 5 mm, as the agent's own edits are rounded. */
const snap = (mm: number) => Math.round(mm / 5) * 5;

export function createStudio(design: Design, opts: StudioOptions = {}): Server {
  const share = Math.random().toString(36).slice(2, 10);
  const save = opts.save ?? (() => {});

  const move = (roomId: string, dx: number, dy: number): { ok: boolean; message: string } => {
    const room = design.store.current.rooms.find((r) => r.id === roomId);
    if (!room) return { ok: false, message: `There is no room ${roomId}.` };
    const ops: OpInput[] = [{ op: "MoveRoom", target: roomId, args: { dx: snap(dx), dy: snap(dy) }, reason: `Dragged ${room.name} on the plan` }];
    const r = design.commitAs(opts.as, ops, { label: `Moved ${room.name}` });
    if (r.status === "rejected") return { ok: false, message: r.error!.message };
    if (r.status === "blocked") return { ok: false, message: ["Not moved:", ...r.findings.filter((f) => f.severity === "block").map((f) => f.message)].join(" ") };
    save(design);
    return { ok: true, message: `${room.name} moved ${describe(snap(dx), snap(dy))}.` };
  };

  return createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => json(res, 400, { error: e instanceof Error ? e.message : String(e) }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", opts.baseUrl ?? "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const html = STUDIO_HTML.replace("__TITLE__", escXml(design.name)).replace("__SHARE__", share);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // The read-only share link, with a preview image for the chat app that unfurls it
    if (req.method === "GET" && path === `/s/${share}`) {
      const project = design.store.current;
      const preview = `${opts.baseUrl ?? ""}/s/${share}/preview.png`;
      const head = [
        `<meta property="og:title" content="${escXml(design.name)} · Rev ${revisionLabel(project.version)}">`,
        `<meta property="og:description" content="${project.rooms.length} rooms, ${project.levels.length} levels. Advisory drawings, not for construction.">`,
        `<meta property="og:image" content="${escXml(preview)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
      ].join("");
      const html = design.stamped(() => renderViewerHtml(project)).replace("</head>", `${head}</head>`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && path === `/s/${share}/preview.png`) {
      const project = design.store.current;
      const png = design.stamped(() => sheetToPng(floorPlanSheet(project, project.levels[0]!.id), { width: 1200 }));
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" });
      res.end(Buffer.from(png));
      return;
    }

    if (req.method === "GET" && path === "/api/plan") {
      json(res, 200, planState(design, url.searchParams.get("level") ?? undefined));
      return;
    }

    if (req.method === "POST" && path === "/api/move") {
      const body = await readJson(req);
      const r = move(String(body.room ?? ""), Number(body.dx ?? 0), Number(body.dy ?? 0));
      json(res, r.ok ? 200 : 409, { ...r, plan: planState(design, String(body.level ?? "")) });
      return;
    }

    if (req.method === "POST" && path === "/api/undo") {
      const undone = design.store.undo();
      save(design);
      json(res, 200, { ok: !!undone, message: undone ? undone.summary.join("; ") : "There is nothing to undo.", plan: planState(design, String((await readJson(req)).level ?? "")) });
      return;
    }

    if (req.method === "POST" && path === "/api/chat") {
      const body = await readJson(req);
      if (!opts.agent) {
        json(res, 503, { error: "Chat is off: no API key was set when the studio started. Dragging and the buttons still work." });
        return;
      }
      design.require(opts.as, "edit");
      const turn: TurnResult = await opts.agent.send(String(body.text ?? ""));
      save(design);
      json(res, 200, { reply: turn.reply, outcome: turn.outcome, assumptions: turn.assumptions, plan: planState(design, String(body.level ?? "")) });
      return;
    }

    json(res, 404, { error: `No route ${path}.` });
  }
}

function describe(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dx) parts.push(`${formatFtIn(Math.abs(dx))} ${dx > 0 ? "east" : "west"}`);
  if (dy) parts.push(`${formatFtIn(Math.abs(dy))} ${dy > 0 ? "north" : "south"}`);
  return parts.join(" and ") || "nowhere";
}

/** Starts the studio and prints where it is. */
export function startStudio(design: Design, opts: StudioOptions = {}): Promise<{ server: Server; url: string }> {
  const server = createStudio(design, opts);
  const port = opts.port ?? 5173;
  return new Promise((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ server, url: `http://localhost:${actual}` });
    });
  });
}

export type { Project };
