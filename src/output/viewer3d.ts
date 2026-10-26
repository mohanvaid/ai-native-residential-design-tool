/**
 * Offline 3D viewer: one HTML file with three.js and the model inlined, so it
 * opens from a WhatsApp forward with no network. On-screen buttons for zoom,
 * turn, views and floors; drag to orbit and pinch to zoom are extras.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { revisionLabel } from "../agent/report.js";
import type { Project } from "../model/schema.js";
import { trueFacing } from "../model/zones.js";
import { ADVISORY_STAMP } from "./frame.js";
import { buildScene } from "./model3d.js";
import { escXml } from "./sheet.js";

let threeSource: string | null = null;

/** three.js as a classic script that sets window.THREE (its module build ends in one export list). */
function threeAsScript(): string {
  if (threeSource) return threeSource;
  const dir = dirname(createRequire(import.meta.url).resolve("three"));
  const src = readFileSync(join(dir, "three.module.min.js"), "utf8");
  const at = src.lastIndexOf("export{");
  const list = src.slice(at + 7, src.lastIndexOf("}"));
  const pairs = list.split(",").map((p) => {
    const [local, name] = p.split(" as ").map((s) => s.trim());
    return `${name ?? local}:${local}`;
  });
  threeSource = `(()=>{${src.slice(0, at)};window.THREE={${pairs.join(",")}};})();`;
  return threeSource;
}

export function renderViewer3dHtml(project: Project): string {
  const scene = buildScene(project);
  const rev = revisionLabel(project.version);
  const facing = trueFacing(project.plot.northAngle);
  const road = project.plot.abuttingRoads[0]?.side ?? "south";
  // Camera azimuths (degrees, model axes) to look at each plot side from outside
  const az = { south: -90, east: 0, north: 90, west: 180 } as const;
  const views = (["south", "east", "north", "west"] as const).map((s) => ({ label: `${facing[s]}${s === road ? " (road)" : ""}`, az: az[s] }));
  const data = JSON.stringify({
    boxes: scene.boxes.map((b) => [...b.min, ...b.max, Object.keys(scene.colours).indexOf(b.material), b.level, b.shape === "cylinder" ? 1 : b.shape === "sphere" ? 2 : 0].map((v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v))),
    materials: Object.keys(scene.colours),
    colours: Object.values(scene.colours),
    levels: scene.levels,
    centre: scene.centre,
    radius: scene.radius,
    views,
    start: az[road],
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escXml(project.name)} · 3D · Rev ${rev}</title>
<style>
:root { --ink:#1d1d1f; --muted:#5f6368; --line:#d9d9de; --card:#fff; --block:#b3261e; }
* { box-sizing:border-box; }
html, body { margin:0; height:100%; background:#eef1f4; color:var(--ink); font:15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
body { display:flex; flex-direction:column; height:100dvh; }
header { padding:10px 16px 6px; background:var(--card); border-bottom:1px solid var(--line); }
h1 { font-size:17px; margin:0; }
.meta { color:var(--muted); font-size:13px; }
.stamp { display:inline-block; margin-top:4px; padding:1px 6px; border:1.5px solid var(--block); color:var(--block); font-size:11px; font-weight:700; }
nav { display:flex; gap:6px; padding:8px 16px; overflow-x:auto; background:var(--card); border-bottom:1px solid var(--line); }
button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:999px; padding:6px 14px; min-height:36px; cursor:pointer; white-space:nowrap; }
button[aria-pressed="true"] { background:var(--ink); color:#fff; border-color:var(--ink); }
main { position:relative; flex:1; min-height:0; touch-action:none; }
canvas { display:block; width:100%; height:100%; }
.tools { position:absolute; right:12px; bottom:12px; display:flex; flex-direction:column; gap:6px; }
.tools button { width:44px; height:44px; padding:0; border-radius:50%; font-size:20px; box-shadow:0 1px 4px rgba(0,0,0,.15); }
.tools button.small { font-size:12px; }
.fail { position:absolute; inset:0; display:none; align-items:center; justify-content:center; padding:24px; text-align:center; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>${escXml(project.name)} · 3D</h1>
  <div class="meta">Rev ${rev} · drag to turn, pinch to zoom, or use the buttons</div>
  <div class="stamp">${escXml(ADVISORY_STAMP)}</div>
</header>
<nav id="views"></nav>
<nav id="floors"></nav>
<main id="stage">
  <div class="fail" id="fail">3D needs WebGL, which this browser has turned off. The PDF and plan viewer still work.</div>
  <div class="tools">
    <button id="zin" aria-label="Zoom in">+</button>
    <button id="zout" aria-label="Zoom out">−</button>
    <button id="left" aria-label="Turn left">⟲</button>
    <button id="right" aria-label="Turn right">⟳</button>
    <button id="fit" class="small" aria-label="Reset view">Fit</button>
  </div>
</main>
<script>${threeAsScript()}</script>
<script>
(() => {
  const D = ${data};
  const T = window.THREE;
  const stage = document.getElementById("stage");
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true });
  } catch (e) {
    document.getElementById("fail").style.display = "flex";
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.prepend(renderer.domElement);
  const scene = new T.Scene();
  scene.background = new T.Color("#eef1f4");
  scene.add(new T.HemisphereLight(0xffffff, 0xb8c2a8, 2.6));
  scene.add(new T.AmbientLight(0xffffff, 0.8));
  const sun = new T.DirectionalLight(0xffffff, 2.0);
  sun.position.set(-30, 50, 20);
  scene.add(sun);
  const camera = new T.PerspectiveCamera(40, 1, 0.1, 1000);

  const see = { glass: 0.45, leaves: 0.5 };
  const mats = D.colours.map((c, i) => new T.MeshLambertMaterial({ color: c, transparent: D.materials[i] in see, opacity: see[D.materials[i]] ?? 1, depthWrite: !(D.materials[i] in see) }));
  const unitBox = new T.BoxGeometry(1, 1, 1);
  const unitCyl = new T.CylinderGeometry(0.5, 0.5, 1, 12);
  const unitSphere = new T.SphereGeometry(0.5, 16, 12);
  const byLevel = new Map();
  for (const b of D.boxes) {
    const [x0, y0, z0, x1, y1, z1, mi, lv, shape] = b;
    const mesh = new T.Mesh(shape === 1 ? unitCyl : shape === 2 ? unitSphere : unitBox, mats[mi]);
    // Model z up → three y up
    mesh.scale.set(x1 - x0, z1 - z0, y1 - y0);
    mesh.position.set((x0 + x1) / 2, (z0 + z1) / 2, -(y0 + y1) / 2);
    scene.add(mesh);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(mesh);
  }

  const target = new T.Vector3(D.centre[0], D.centre[2] * 0.6, -D.centre[1]);
  const home = { az: D.start, el: 28, dist: D.radius * 2.6 };
  let view = { ...home };
  /** Distance at which the whole plot fits the narrower of the two fields of view. */
  const fitDist = () => {
    const v = (camera.fov * Math.PI) / 360;
    const h = Math.atan(Math.tan(v) * camera.aspect);
    return (D.radius * 1.15) / Math.sin(Math.min(v, h));
  };
  function place() {
    const a = (view.az * Math.PI) / 180, e = (view.el * Math.PI) / 180;
    camera.position.set(target.x + view.dist * Math.cos(e) * Math.cos(a), target.y + view.dist * Math.sin(e), target.z - view.dist * Math.cos(e) * Math.sin(a));
    camera.lookAt(target);
    renderer.render(scene, camera);
  }
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const fresh = view.dist === home.dist;
    home.dist = fitDist();
    if (fresh) view.dist = home.dist;
    place();
  }
  new ResizeObserver(resize).observe(stage);

  const zoom = (f) => { view.dist = Math.min(D.radius * 8, Math.max(D.radius * 0.4, view.dist * f)); place(); };
  document.getElementById("zin").onclick = () => zoom(1 / 1.3);
  document.getElementById("zout").onclick = () => zoom(1.3);
  document.getElementById("left").onclick = () => { view.az -= 30; place(); };
  document.getElementById("right").onclick = () => { view.az += 30; place(); };
  document.getElementById("fit").onclick = () => { view = { ...home }; place(); };

  const vnav = document.getElementById("views");
  for (const v of [...D.views, { label: "Top", az: null }]) {
    const b = document.createElement("button");
    b.textContent = v.label;
    b.onclick = () => { if (v.az === null) { view.el = 89; } else { view.az = v.az; view.el = 12; } place(); };
    vnav.append(b);
  }
  const fnav = document.getElementById("floors");
  const chips = [];
  const showUpTo = (k) => {
    for (const [lv, meshes] of byLevel) for (const m of meshes) m.visible = lv < 0 || lv <= k;
    chips.forEach((c, i) => c.setAttribute("aria-pressed", String(i === k)));
    place();
  };
  D.levels.forEach((name, i) => {
    const b = document.createElement("button");
    b.textContent = i === D.levels.length - 1 ? "All floors" : "Up to " + name;
    b.onclick = () => showUpTo(i);
    chips.push(b);
    fnav.append(b);
  });
  chips[chips.length - 1].setAttribute("aria-pressed", "true");

  const pts = new Map();
  let last = null;
  const gesture = () => {
    const p = [...pts.values()];
    if (p.length === 1) return { x: p[0][0], y: p[0][1], d: 0 };
    return { x: (p[0][0] + p[1][0]) / 2, y: (p[0][1] + p[1][1]) / 2, d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) };
  };
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tools")) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    last = gesture();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    const g = gesture();
    if (g.d && last.d) zoom(last.d / g.d);
    else if (!g.d) {
      view.az -= (g.x - last.x) * 0.4;
      view.el = Math.max(2, Math.min(89, view.el + (g.y - last.y) * 0.3));
      place();
    }
    last = g;
  });
  const end = (e) => { pts.delete(e.pointerId); last = pts.size ? gesture() : null; };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY / 400)); }, { passive: false });
  resize();
})();
</script>
</body>
</html>
`;
}
