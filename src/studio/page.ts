/**
 * The studio page: the plan on the left to drag rooms on, the chat and the
 * open issues on the right. It holds no model of its own — every change is a
 * request to the engine and the plan comes back redrawn — so a drag and a
 * sentence land in the same history and the same undo.
 */
export const STUDIO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>__TITLE__ · studio</title>
<style>
  :root { --bg:#f4f4f2; --card:#fff; --line:#d9d7d2; --ink:#1c1c1a; --muted:#6b6a66; --accent:#1f5fa8; --warn:#b26a00; --block:#c0392b; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:var(--ink); background:var(--bg); height:100dvh; display:flex; flex-direction:column; }
  header { display:flex; gap:12px; align-items:baseline; padding:10px 16px; background:var(--card); border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; }
  header .rev { color:var(--muted); font-size:13px; }
  main { flex:1; display:flex; min-height:0; }
  #stage { flex:1; position:relative; overflow:hidden; background:var(--card); touch-action:none; user-select:none; -webkit-user-select:none; }
  #stage svg { width:100%; height:100%; }
  aside { width:min(380px, 42vw); border-left:1px solid var(--line); background:var(--card); display:flex; flex-direction:column; min-height:0; }
  .bar { display:flex; gap:8px; padding:8px 12px; border-bottom:1px solid var(--line); flex-wrap:wrap; align-items:center; }
  button, select { font:inherit; padding:6px 12px; border:1px solid var(--line); border-radius:8px; background:#fff; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button[disabled] { opacity:.45; cursor:default; }
  #log { flex:1; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .msg { padding:8px 10px; border-radius:10px; background:#f1f0ec; white-space:pre-wrap; }
  .msg.you { background:#e6eef7; align-self:flex-end; max-width:85%; }
  .msg.err { background:#fbe9e6; }
  form { display:flex; gap:8px; padding:10px 12px; border-top:1px solid var(--line); }
  form input { flex:1; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; }
  #issues { max-height:32dvh; overflow:auto; border-top:1px solid var(--line); padding:10px 12px; font-size:13px; }
  #issues h2 { font-size:13px; margin:0 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
  #issues li { margin-bottom:5px; }
  .block { color:var(--block); } .warn { color:var(--warn); }
  .ghost { fill:#1f5fa8; fill-opacity:.12; stroke:#1f5fa8; stroke-width:30; }
  .hit { fill:transparent; cursor:grab; }
  .hit:hover { fill:#1f5fa8; fill-opacity:.07; }
  .hit.picked { fill:#1f5fa8; fill-opacity:.08; stroke:#1f5fa8; stroke-width:40; stroke-dasharray:160 100; }
  footer { padding:6px 16px; font-size:12px; color:var(--muted); background:var(--card); border-top:1px solid var(--line); }
  @media (max-width: 760px) { main { flex-direction:column; } aside { width:auto; border-left:0; border-top:1px solid var(--line); max-height:52dvh; } }
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <span class="rev" id="rev"></span>
  <span class="rev" id="hint">Drag an edge to move a wall, or the middle to move a room.</span>
</header>
<main>
  <div id="stage"></div>
  <aside>
    <div class="bar">
      <select id="level"></select>
      <button id="undo">Undo</button>
      <button data-nudge="-305,0">←</button>
      <button data-nudge="305,0">→</button>
      <button data-nudge="0,305">↑</button>
      <button data-nudge="0,-305">↓</button>
      <a id="share" href="#" target="_blank">Share link</a>
    </div>
    <div id="log"></div>
    <form id="chat"><input id="text" placeholder="Ask for a change…" autocomplete="off"><button>Send</button></form>
    <div id="issues"></div>
  </aside>
</main>
<footer>Advisory drawings. Every change goes through the same engine and the same undo, whether you drag it or ask for it.</footer>
<script>
const stage = document.getElementById("stage");
const log = document.getElementById("log");
const levelSel = document.getElementById("level");
let plan = null;
let selected = null;

function say(text, cls) {
  const d = document.createElement("div");
  d.className = "msg" + (cls ? " " + cls : "");
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, level: plan ? plan.level : undefined }) } : {});
  const data = await res.json();
  if (data.plan) draw(data.plan);
  if (!res.ok) throw new Error(data.error || data.message || "That did not work.");
  return data;
}

function draw(state) {
  plan = state;
  const keep = levelSel.value;
  if (levelSel.options.length !== state.levels.length) {
    levelSel.innerHTML = state.levels.map((l) => '<option value="' + l.id + '">' + l.name + '</option>').join("");
  }
  levelSel.value = state.level || keep;
  document.getElementById("rev").textContent = state.branch + " · Rev " + state.revision;
  document.getElementById("undo").disabled = !state.canUndo;
  stage.innerHTML = state.svg;
  const svg = stage.querySelector("svg");
  const layer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(layer);
  for (const room of state.rooms) {
    // The server gives the footprints in sheet coordinates already
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(room.x));
    r.setAttribute("y", String(room.y));
    r.setAttribute("width", String(room.width));
    r.setAttribute("height", String(room.depth));
    // The room the arrow buttons will nudge stays marked across redraws
    r.setAttribute("class", room.id === selected ? "hit picked" : "hit");
    r.dataset.room = room.id;
    r.dataset.name = room.name;
    layer.appendChild(r);
  }
  issues(state.findings);
}

function issues(list) {
  const el = document.getElementById("issues");
  if (!list.length) { el.innerHTML = "<h2>Checks</h2><p>Nothing to fix.</p>"; return; }
  el.innerHTML = "<h2>Checks</h2><ul>" + list.map((f) => '<li class="' + f.severity + '">' + f.message.replace(/</g, "&lt;") + "</li>").join("") + "</ul>";
}

// Dragging. Grab a room's edge to move that wall (the neighbour gives way), or
// its middle to move the whole room. The sheet is in model millimetres with y
// pointing south, so a screen point maps straight into it.
let drag = null;
const EDGE_PX = 10;
const CURSOR = { east: "ew-resize", west: "ew-resize", north: "ns-resize", south: "ns-resize" };

function toSheet(svg, e) {
  const m = svg.getScreenCTM().inverse();
  return { x: m.a * e.clientX + m.c * e.clientY + m.e, y: m.b * e.clientX + m.d * e.clientY + m.f };
}

/** Which edge of the room the pointer is on, if any. */
function edgeAt(svg, hit, e) {
  const p = toSheet(svg, e);
  const tol = EDGE_PX * (svg.viewBox.baseVal.width / svg.getBoundingClientRect().width);
  const x = +hit.getAttribute("x"), y = +hit.getAttribute("y"), w = +hit.getAttribute("width"), h = +hit.getAttribute("height");
  const near = [["west", p.x - x], ["east", x + w - p.x], ["north", p.y - y], ["south", y + h - p.y]].filter(([, d]) => d < Math.min(tol, Math.min(w, h) / 4));
  near.sort((a, b) => a[1] - b[1]);
  return near.length ? near[0][0] : null;
}

/** Outward movement of an edge for a pointer moved by (dx, dy) in sheet space. */
function outward(edge, dx, dy) {
  return edge === "east" ? dx : edge === "west" ? -dx : edge === "south" ? dy : -dy;
}

stage.addEventListener("pointerdown", (e) => {
  const hit = e.target.closest ? e.target.closest(".hit") : null;
  if (!hit) return;
  // Without this the browser selects the plan's text and turns the gesture into a text drag
  e.preventDefault();
  const svg = stage.querySelector("svg");
  const at = toSheet(svg, e);
  const box = { x: +hit.getAttribute("x"), y: +hit.getAttribute("y"), w: +hit.getAttribute("width"), h: +hit.getAttribute("height") };
  drag = { room: hit.dataset.room, name: hit.dataset.name, at, svg, el: hit, edge: edgeAt(svg, hit, e), box };
  selected = hit.dataset.room;
  hit.setAttribute("class", "hit ghost");
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener("pointermove", (e) => {
  if (!drag) {
    const hit = e.target.closest ? e.target.closest(".hit") : null;
    if (hit) hit.style.cursor = CURSOR[edgeAt(stage.querySelector("svg"), hit, e)] || "grab";
    return;
  }
  const p = toSheet(drag.svg, e);
  const dx = p.x - drag.at.x, dy = p.y - drag.at.y;
  if (!drag.edge) { drag.el.setAttribute("transform", "translate(" + dx + "," + dy + ")"); return; }
  const b = drag.box, el = drag.el;
  // Stretch the outline to show where the wall will land
  if (drag.edge === "east") el.setAttribute("width", String(Math.max(1, b.w + dx)));
  if (drag.edge === "west") { el.setAttribute("x", String(b.x + dx)); el.setAttribute("width", String(Math.max(1, b.w - dx))); }
  if (drag.edge === "south") el.setAttribute("height", String(Math.max(1, b.h + dy)));
  if (drag.edge === "north") { el.setAttribute("y", String(b.y + dy)); el.setAttribute("height", String(Math.max(1, b.h - dy))); }
});
stage.addEventListener("pointerup", async (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  const p = toSheet(d.svg, e);
  const dx = p.x - d.at.x;
  const dy = p.y - d.at.y;
  if (Math.abs(dx) < 40 && Math.abs(dy) < 40) {
    // A tap picks the room for the arrow buttons
    d.el.removeAttribute("transform");
    for (const o of stage.querySelectorAll(".hit")) o.setAttribute("class", o === d.el ? "hit picked" : "hit");
    say("Picked " + d.name + ". Drag its middle to move it, an edge to move that wall, or use the arrows.");
    return;
  }
  try {
    const r = d.edge
      ? await api("/api/resize", { room: d.room, edge: d.edge, delta: outward(d.edge, dx, dy) })
      : await api("/api/move", { room: d.room, dx, dy: -dy }); // up on the screen is north
    say(r.message);
  } catch (err) {
    say(err.message, "err");
  }
});

stage.addEventListener("pointercancel", () => {
  if (!drag) return;
  drag.el.removeAttribute("transform");
  drag.el.setAttribute("class", "hit");
  drag = null;
});

document.getElementById("undo").addEventListener("click", async () => {
  try { say((await api("/api/undo", {})).message); } catch (e) { say(e.message, "err"); }
});
for (const b of document.querySelectorAll("[data-nudge]")) {
  b.addEventListener("click", async () => {
    if (!selected) { say("Pick a room on the plan first.", "err"); return; }
    const [dx, dy] = b.dataset.nudge.split(",").map(Number);
    try { say((await api("/api/move", { room: selected, dx, dy })).message); } catch (e) { say(e.message, "err"); }
  });
}
levelSel.addEventListener("change", async () => {
  const state = await (await fetch("/api/plan?level=" + levelSel.value)).json();
  draw(state);
});
document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("text");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  say(text, "you");
  try { say((await api("/api/chat", { text })).reply); } catch (err) { say(err.message, "err"); }
});
document.getElementById("share").addEventListener("click", (e) => { e.target.href = "/s/__SHARE__"; });

fetch("/api/plan").then((r) => r.json()).then(draw);
</script>
</body>
</html>`;
