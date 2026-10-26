/**
 * A shareable plan viewer: one self-contained HTML file with every drawing,
 * the schedules and the open issues inlined, so it opens offline from a
 * WhatsApp forward on a phone. Pan by dragging, pinch or use the buttons to
 * zoom. Nothing is fetched at view time.
 */
import { revisionLabel } from "../agent/report.js";
import { catalogueItem } from "../catalogue/catalogue.js";
import { vastuReport } from "../rules/vastu.js";
import { validate } from "../engine.js";
import { rectArea, rectDepth, rectWidth } from "../model/geometry.js";
import type { Finding, Project } from "../model/schema.js";
import { formatFtIn, sqmToSqft } from "../model/units.js";
import { clearRect, deriveWalls } from "../model/walls.js";
import { ADVISORY_STAMP, floorPlanSheet, renderFloorPlanPdf } from "./floorplan.js";
import { openingSchedule } from "./schedule.js";
import { escXml, sheetToSvg } from "./sheet.js";
import { siteplanSheet } from "./siteplan.js";

export interface ViewerOptions {
  /** Embed the plans PDF so the viewer can download it offline. Default true. */
  includePdf?: boolean;
  /** Findings to list; defaults to validating the project. */
  findings?: Finding[];
}

const SEVERITY_LABEL: Record<Finding["severity"], string> = { block: "Must fix", warn: "Check", info: "Note" };

function roomRows(project: Project): string {
  return project.levels
    .map((level) => {
      const walls = deriveWalls(project, level.id);
      return project.rooms
        .filter((r) => r.level === level.id)
        .map((room) => {
          const c = clearRect(walls, room);
          const sqft = sqmToSqft(rectArea(c) / 1e6);
          return `<tr><td>${escXml(level.name)}</td><td>${escXml(room.name)}</td><td>${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))}</td><td class="n">${Math.round(sqft)}</td></tr>`;
        })
        .join("");
    })
    .join("");
}

function openingRows(project: Project): string {
  return openingSchedule(project)
    .map((r) => `<tr><td>${r.mark}</td><td>${r.type}</td><td>${formatFtIn(r.width)} × ${formatFtIn(r.height)}</td><td class="n">${r.count}</td></tr>`)
    .join("");
}

function itemRows(project: Project): string {
  return project.items
    .map((it) => {
      const cat = catalogueItem(it.catalogue);
      const room = project.rooms.find((r) => r.id === it.room)?.name ?? it.room;
      if (!cat) return "";
      const price = cat.priceInr[1] ? `₹${(cat.priceInr[0] / 1000).toFixed(0)}k–${(cat.priceInr[1] / 1000).toFixed(0)}k` : "";
      return `<tr><td>${escXml(room)}</td><td>${escXml(cat.name)}</td><td>${formatFtIn(cat.width)} × ${formatFtIn(cat.depth)}</td><td class="n">${price}</td></tr>`;
    })
    .join("");
}

function vastuSection(project: Project): string {
  if (project.prefs.vastu === "off") return "";
  const rep = vastuReport(project);
  const mark = { best: "Preferred", ok: "Acceptable", neutral: "Neutral", avoid: "Avoid" } as const;
  return `<h2>Vastu (advisory) · ${rep.score} of ${rep.max}</h2>
    <table><thead><tr><th>Element</th><th>Zone</th><th>Rating</th></tr></thead><tbody>${rep.items
      .map((i) => `<tr><td>${escXml(i.name)}</td><td>${i.key === "entrance" ? "faces " : ""}${i.zone}</td><td>${mark[i.grade]}</td></tr>`)
      .join("")}</tbody></table>`;
}

function findingItems(findings: Finding[]): string {
  if (findings.length === 0) return `<p class="ok">All checks pass.</p>`;
  return `<ul class="issues">${findings
    .map((f) => `<li class="${f.severity}"><b>${SEVERITY_LABEL[f.severity]}</b> ${escXml(f.message)}</li>`)
    .join("")}</ul>`;
}

export function renderViewerHtml(project: Project, opts: ViewerOptions = {}): string {
  const rev = revisionLabel(project.version);
  const findings = opts.findings ?? validate(project);
  const plans = [
    { id: "site", name: "Site", sheet: siteplanSheet(project) },
    ...project.levels.map((l) => ({ id: l.id, name: l.name, sheet: floorPlanSheet(project, l.id) })),
  ].map((p, i) => ({ ...p, svg: sheetToSvg(p.sheet, { fluid: true, id: `sheet-${i}` }) }));
  const start = plans.length > 1 ? 1 : 0;
  const pdf = opts.includePdf === false ? "" : Buffer.from(renderFloorPlanPdf(project)).toString("base64");
  const fileBase = `${project.name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "")}-rev-${rev}`;
  const count = (sev: Finding["severity"]) => findings.filter((f) => f.severity === sev).length;
  const status = [
    count("block") ? `${count("block")} must fix` : "",
    count("warn") ? `${count("warn")} to check` : "",
    count("block") + count("warn") === 0 ? "all checks pass" : "",
    count("info") ? `${count("info")} note${count("info") === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(", ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escXml(project.name)} · Rev ${rev}</title>
<style>
:root { --ink:#1d1d1f; --muted:#5f6368; --line:#d9d9de; --bg:#f4f4f6; --card:#fff; --accent:#0b57d0; --block:#b3261e; --warn:#8a5a00; }
* { box-sizing:border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--ink); font:15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { display:flex; flex-direction:column; height:100dvh; }
header { padding:10px 16px 6px; background:var(--card); border-bottom:1px solid var(--line); }
h1 { font-size:17px; margin:0; }
.meta { color:var(--muted); font-size:13px; }
.stamp { display:inline-block; margin-top:4px; padding:1px 6px; border:1.5px solid var(--block); color:var(--block); font-size:11px; font-weight:700; letter-spacing:.02em; }
nav { display:flex; gap:6px; padding:8px 16px; overflow-x:auto; background:var(--card); border-bottom:1px solid var(--line); }
nav button, .tools button, .tools a { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:999px; padding:6px 14px; min-height:36px; cursor:pointer; white-space:nowrap; text-decoration:none; }
nav button[aria-selected="true"] { background:var(--ink); color:#fff; border-color:var(--ink); }
main { position:relative; flex:1; min-height:0; overflow:hidden; touch-action:none; background:#fff; }
.plan { position:absolute; inset:0; display:none; }
.plan.active { display:block; }
.plan svg { position:absolute; left:0; top:0; transform-origin:0 0; user-select:none; -webkit-user-select:none; }
.tools { position:absolute; right:12px; bottom:12px; display:flex; flex-direction:column; gap:6px; }
.tools button { width:44px; height:44px; padding:0; border-radius:50%; font-size:20px; box-shadow:0 1px 4px rgba(0,0,0,.15); }
.tools button.fit { font-size:12px; }
details { background:var(--card); border-top:1px solid var(--line); max-height:45dvh; overflow:auto; }
summary { padding:10px 16px; cursor:pointer; font-weight:600; }
summary .count { font-weight:400; color:var(--muted); }
.panel { padding:0 16px 16px; }
h2 { font-size:14px; margin:14px 0 6px; }
table { border-collapse:collapse; width:100%; font-size:13px; }
td, th { text-align:left; padding:4px 6px; border-bottom:1px solid var(--line); }
td.n, th.n { text-align:right; }
.issues { list-style:none; padding:0; margin:0; font-size:13px; }
.issues li { padding:4px 0; border-bottom:1px solid var(--line); }
.issues li.block b { color:var(--block); }
.issues li.warn b { color:var(--warn); }
.issues li.info b { color:var(--muted); }
.ok { color:#146c2e; font-size:13px; }
.download { display:inline-block; margin-top:12px; color:var(--accent); }
.note { color:var(--muted); font-size:12px; margin-top:12px; }
</style>
</head>
<body>
<header>
  <h1>${escXml(project.name)}</h1>
  <div class="meta">Rev ${rev} · version ${project.version} · Scale 1:100 on print</div>
  <div class="stamp">${escXml(ADVISORY_STAMP)}</div>
</header>
<nav role="tablist">
${plans.map((p, i) => `  <button role="tab" data-i="${i}" aria-selected="${i === start}">${escXml(p.name)}</button>`).join("\n")}
</nav>
<main id="stage">
${plans.map((p, i) => `<div class="plan${i === start ? " active" : ""}" data-level="${escXml(p.id)}">${p.svg}</div>`).join("\n")}
  <div class="tools">
    <button id="zin" aria-label="Zoom in">+</button>
    <button id="zout" aria-label="Zoom out">−</button>
    <button id="zfit" class="fit" aria-label="Fit to screen">Fit</button>
  </div>
</main>
<details>
  <summary>Schedules and checks <span class="count">· ${status}</span></summary>
  <div class="panel">
    <h2>Checks</h2>
    ${findingItems(findings)}
    ${vastuSection(project)}
    <h2>Rooms (clear sizes)</h2>
    <table><thead><tr><th>Floor</th><th>Room</th><th>Size</th><th class="n">sq ft</th></tr></thead><tbody>${roomRows(project)}</tbody></table>
    <h2>Doors and windows</h2>
    <table><thead><tr><th>Mark</th><th>Type</th><th>W × H</th><th class="n">No.</th></tr></thead><tbody>${openingRows(project)}</tbody></table>
    ${project.items.length ? `<h2>Furniture and fixtures</h2>
    <table><thead><tr><th>Room</th><th>Item</th><th>Size</th><th class="n">Price band</th></tr></thead><tbody>${itemRows(project)}</tbody></table>` : ""}
    ${pdf ? `<a class="download" id="pdf" href="#" download="${fileBase}.pdf">Download plans as PDF</a>` : ""}
    <p class="note">Room sizes are clear internal dimensions. Areas are carpet. Not for construction until checked and signed off by a registered professional.</p>
  </div>
</details>
<script>
(() => {
  const stage = document.getElementById("stage");
  const plans = [...document.querySelectorAll(".plan")];
  const tabs = [...document.querySelectorAll("nav button")];
  const views = plans.map(() => null);
  let cur = ${start};

  const svgOf = (i) => plans[i].querySelector("svg");
  const box = (svg) => svg.viewBox.baseVal;

  function fitView(i) {
    const vb = box(svgOf(i));
    const w = stage.clientWidth, h = stage.clientHeight;
    const s = Math.min(w / vb.width, h / vb.height);
    return { s, x: (w - vb.width * s) / 2, y: (h - vb.height * s) / 2 };
  }
  function draw() {
    const v = views[cur], svg = svgOf(cur), vb = box(svg);
    svg.setAttribute("width", vb.width);
    svg.setAttribute("height", vb.height);
    svg.style.transform = "translate(" + v.x + "px," + v.y + "px) scale(" + v.s + ")";
  }
  function fit() { views[cur] = fitView(cur); draw(); }
  function zoomAt(f, px, py) {
    const v = views[cur], min = fitView(cur).s / 2, max = fitView(cur).s * 40;
    const s = Math.min(max, Math.max(min, v.s * f));
    v.x = px - (px - v.x) * (s / v.s);
    v.y = py - (py - v.y) * (s / v.s);
    v.s = s;
    draw();
  }
  function show(i) {
    plans[cur].classList.remove("active");
    tabs[cur].setAttribute("aria-selected", "false");
    cur = i;
    plans[cur].classList.add("active");
    tabs[cur].setAttribute("aria-selected", "true");
    if (!views[cur]) views[cur] = fitView(cur);
    draw();
  }
  tabs.forEach((t, i) => t.addEventListener("click", () => show(i)));
  const centre = () => [stage.clientWidth / 2, stage.clientHeight / 2];
  document.getElementById("zin").addEventListener("click", () => zoomAt(1.5, ...centre()));
  document.getElementById("zout").addEventListener("click", () => zoomAt(1 / 1.5, ...centre()));
  document.getElementById("zfit").addEventListener("click", fit);

  const pts = new Map();
  let last = null;
  const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function gesture() {
    const p = [...pts.values()];
    if (p.length === 1) return { c: p[0], d: 0 };
    const [a, b] = p;
    return { c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  }
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tools")) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    last = gesture();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, local(e));
    const g = gesture(), v = views[cur];
    v.x += g.c[0] - last.c[0];
    v.y += g.c[1] - last.c[1];
    if (g.d && last.d) zoomAt(g.d / last.d, g.c[0], g.c[1]); else draw();
    last = g;
  });
  const end = (e) => { pts.delete(e.pointerId); last = pts.size ? gesture() : null; };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    zoomAt(Math.exp(-e.deltaY / 300), x, y);
  }, { passive: false });
  stage.addEventListener("dblclick", fit);
  new ResizeObserver(fit).observe(stage);

  const pdf = document.getElementById("pdf");
  if (pdf) {
    const b64 = "${pdf}";
    pdf.addEventListener("click", () => {
      if (pdf.dataset.ready) return;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      pdf.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      pdf.dataset.ready = "1";
    });
  }
  show(cur);
})();
</script>
</body>
</html>
`;
}
