/**
 * A 3D massing of the model as coloured boxes: walls cut around openings,
 * glazing and doors, slabs, parapets, stair steps, furniture blocks, trees,
 * the plot and the road. Coordinates are metres with z up. The same boxes go
 * to the offline 3D viewer and to a glTF (.glb) file for other tools.
 */
import { catalogueItem } from "../catalogue/catalogue.js";
import { itemRect } from "../model/furnishing.js";
import { bbox, boundaryToRect, type Rect } from "../model/geometry.js";
import type { Project } from "../model/schema.js";
import { stairLayout } from "../model/structure.js";
import { deriveWalls, resolveOpening, type Wall } from "../model/walls.js";
import { palette } from "./theme.js";

export type Material = "wall" | "accent" | "slab" | "glass" | "frame" | "door" | "floor" | "furniture" | "stair" | "trunk" | "leaves" | "ground" | "road";

export interface Box {
  /** min and max corners, metres, z up */
  min: [number, number, number];
  max: [number, number, number];
  material: Material;
  /** Level index the box belongs to, or -1 for the site. */
  level: number;
  /** Trees are drawn rounder by the viewer. */
  shape?: "box" | "cylinder" | "sphere";
}

export interface Scene {
  boxes: Box[];
  colours: Record<Material, string>;
  levels: string[];
  /** Plot centre and size in metres, for framing the camera. */
  centre: [number, number, number];
  radius: number;
}

const PARAPET = 900;
const m = (mm: number) => mm / 1000;

export function buildScene(project: Project): Scene {
  const pal = palette(project);
  const boxes: Box[] = [];
  const add = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: Material, level: number, shape: Box["shape"] = "box") => {
    if (x1 - x0 <= 0 || y1 - y0 <= 0 || z1 - z0 <= 0) return;
    boxes.push({ min: [m(x0), m(y0), m(z0)], max: [m(x1), m(y1), m(z1)], material, level, shape });
  };
  const plot = bbox(project.plot.boundary);

  // Site
  add(plot.x0, plot.y0, -60, plot.x1, plot.y1, 0, "ground", -1);
  for (const road of project.plot.abuttingRoads) {
    const d = road.widthM * 1000;
    const r: Rect =
      road.side === "north" ? { ...plot, y0: plot.y1, y1: plot.y1 + d } : road.side === "south" ? { ...plot, y0: plot.y0 - d, y1: plot.y0 } : road.side === "east" ? { ...plot, x0: plot.x1, x1: plot.x1 + d } : { ...plot, x0: plot.x0 - d, x1: plot.x0 };
    add(r.x0, r.y0, -80, r.x1, r.y1, -20, "road", -1);
  }
  for (const t of project.trees.filter((t) => t.keep)) {
    const crown = Math.min(t.canopyRadius * 0.7, 3500);
    add(t.at[0] - 150, t.at[1] - 150, 0, t.at[0] + 150, t.at[1] + 150, crown + 1500, "trunk", -1, "cylinder");
    add(t.at[0] - crown, t.at[1] - crown, 1500, t.at[0] + crown, t.at[1] + crown, 1500 + 2 * crown, "leaves", -1, "sphere");
  }

  project.levels.forEach((level, li) => {
    const z0 = level.elevation;
    const z1 = z0 + level.floorToFloor;
    const slab = level.slabThickness;
    const walls = deriveWalls(project, level.id);
    const rooms = project.rooms.filter((r) => r.level === level.id);
    const above = project.levels[li + 1];
    const upper = above ? project.rooms.filter((r) => r.level === above.id).map((r) => boundaryToRect(r.boundary)).filter((r): r is Rect => r !== null) : [];

    // Floor and, where nothing is above, roof slab
    for (const room of rooms) {
      const r = boundaryToRect(room.boundary);
      if (!r) continue;
      add(r.x0 - 115, r.y0 - 115, z0 - slab, r.x1 + 115, r.y1 + 115, z0, li === 0 ? "floor" : "slab", li);
      const covered = upper.some((u) => u.x0 <= r.x0 && u.x1 >= r.x1 && u.y0 <= r.y0 && u.y1 >= r.y1);
      if (!covered) add(r.x0 - 115, r.y0 - 115, z1 - slab, r.x1 + 115, r.y1 + 115, z1, "slab", li);
    }

    // Walls, split around openings
    const resolved = project.openings.map((o) => resolveOpening(project, walls, o)).filter((r) => r && rooms.some((q) => q.id === r.opening.host.room));
    for (const w of walls) {
      const top = z1 - slab;
      const ops = resolved.filter((r) => r!.wall?.id === w.id).sort((a, b) => a!.from - b!.from);
      let cursor = w.from - w.thickness / 2;
      const end = w.to + w.thickness / 2;
      const seg = (a: number, b: number, za: number, zb: number, mat: Material) => {
        const h = w.thickness / 2;
        if (w.orient === "h") add(a, w.at - h, za, b, w.at + h, zb, mat, li);
        else add(w.at - h, a, za, w.at + h, b, zb, mat, li);
      };
      for (const r of ops) {
        const o = r!.opening;
        seg(cursor, r!.from, z0, top, "wall");
        const sill = z0 + o.sill;
        const head = Math.min(top, sill + o.height);
        seg(r!.from, r!.to, head, top, "wall");
        if (o.sill > 0) seg(r!.from, r!.to, z0, sill, "wall");
        if (o.type === "window" || o.type === "ventilator") {
          const glass = (a: number, b: number) => {
            if (w.orient === "h") add(a, w.at - 15, sill, b, w.at + 15, head, "glass", li);
            else add(w.at - 15, a, sill, w.at + 15, b, head, "glass", li);
          };
          glass(r!.from, r!.to);
          seg(r!.from, r!.to, head, head + 80, "frame");
          // Sunshade on external windows
          if (w.isExternal) {
            const [sx0, sx1] = [r!.from - 150, r!.to + 150];
            const out = 600;
            const room = project.rooms.find((q) => q.id === o.host.room)!;
            const rr = boundaryToRect(room.boundary)!;
            const sign = w.orient === "h" ? (w.at >= rr.y1 ? 1 : -1) : w.at >= rr.x1 ? 1 : -1;
            const a = w.at + (sign * w.thickness) / 2;
            const b = a + sign * out;
            if (w.orient === "h") add(sx0, Math.min(a, b), head + 150, sx1, Math.max(a, b), head + 230, "accent", li);
            else add(Math.min(a, b), sx0, head + 150, Math.max(a, b), sx1, head + 230, "accent", li);
          }
        } else if (o.type === "door") {
          if (w.orient === "h") add(r!.from, w.at - 20, z0, r!.to, w.at + 20, head, "door", li);
          else add(w.at - 20, r!.from, z0, w.at + 20, r!.to, head, "door", li);
        }
        cursor = r!.to;
      }
      seg(cursor, end, z0, top, "wall");
      // Parapet and coping where the roof is open
      if (w.isExternal && !coveredWall(w, upper)) {
        seg(w.from - w.thickness / 2, w.to + w.thickness / 2, z1, z1 + PARAPET, "wall");
        seg(w.from - w.thickness / 2 - 30, w.to + w.thickness / 2 + 30, z1 + PARAPET, z1 + PARAPET + 80, "accent");
      }
    }

    // Stairs from this level: one box per step, the landing as a slab
    for (const s of project.stairs.filter((s) => s.fromLevel === level.id)) {
      const lay = stairLayout(project, s);
      if (!lay) continue;
      let rise = 0;
      for (const fl of lay.flights) {
        const steps = fl.nosings.length;
        for (let i = 0; i < steps; i++) {
          const [a, b] = fl.nosings[i]!;
          const along = fl.dir === "east" || fl.dir === "west";
          const sgn = fl.dir === "east" || fl.dir === "north" ? 1 : -1;
          const zTop = z0 + (rise + i + 1) * lay.riserHeight;
          if (along) add(Math.min(a[0], a[0] + sgn * s.tread), Math.min(a[1], b[1]), zTop - 150, Math.max(a[0], a[0] + sgn * s.tread), Math.max(a[1], b[1]), zTop, "stair", li);
          else add(Math.min(a[0], b[0]), Math.min(a[1], a[1] + sgn * s.tread), zTop - 150, Math.max(a[0], b[0]), Math.max(a[1], a[1] + sgn * s.tread), zTop, "stair", li);
        }
        rise += fl.risers;
        if (fl === lay.flights[0] && lay.landing) add(lay.landing.x0, lay.landing.y0, z0 + rise * lay.riserHeight - 150, lay.landing.x1, lay.landing.y1, z0 + rise * lay.riserHeight, "stair", li);
      }
    }

    // Furniture as blocks at catalogue height (flat items get a thin slab)
    for (const it of project.items) {
      const room = rooms.find((r) => r.id === it.room);
      const cat = catalogueItem(it.catalogue);
      if (!room || !cat) continue;
      const r = itemRect(it, cat);
      add(r.x0, r.y0, z0, r.x1, r.y1, z0 + Math.max(cat.height, 30), "furniture", li);
    }
  });

  const top = project.levels.reduce((h, l) => h + l.floorToFloor, 0);
  const colours: Record<Material, string> = {
    wall: pal.walls,
    accent: pal.accent,
    slab: pal.roof,
    glass: pal.glass,
    frame: pal.frame,
    door: pal.door,
    floor: pal.floor,
    furniture: "#c8b8a2",
    stair: "#b9b3a9",
    trunk: "#6b4f3a",
    leaves: "#6f9a5b",
    ground: pal.ground,
    road: "#9a9a9a",
  };
  return {
    boxes,
    colours,
    levels: project.levels.map((l) => l.name),
    centre: [m((plot.x0 + plot.x1) / 2), m((plot.y0 + plot.y1) / 2), m(top / 2)],
    radius: m(Math.hypot(plot.x1 - plot.x0, plot.y1 - plot.y0, top)) / 2,
  };
}

function coveredWall(w: Wall, upper: Rect[]): boolean {
  return upper.some((r) => (w.orient === "h" ? r.y0 <= w.at && r.y1 >= w.at && r.x0 <= w.from && r.x1 >= w.to : r.x0 <= w.at && r.x1 >= w.at && r.y0 <= w.from && r.y1 >= w.to));
}

/**
 * The scene as a binary glTF 2.0 file: one mesh per material, y up as glTF
 * expects, metres. Opens in Blender, SketchUp (via importer) and web viewers.
 */
export function sceneToGlb(scene: Scene): Uint8Array {
  const byMat = new Map<Material, Box[]>();
  for (const b of scene.boxes) byMat.set(b.material, [...(byMat.get(b.material) ?? []), b]);
  const mats = [...byMat.keys()];
  const chunks: { pos: Float32Array; nrm: Float32Array; idx: Uint32Array; min: number[]; max: number[] }[] = [];
  for (const mat of mats) {
    const list = byMat.get(mat)!;
    const pos = new Float32Array(list.length * 24 * 3);
    const nrm = new Float32Array(list.length * 24 * 3);
    const idx = new Uint32Array(list.length * 36);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    list.forEach((b, bi) => {
      // glTF is y up: (x, y, z) model → (x, z, -y)
      const [x0, y0, z0] = b.min;
      const [x1, y1, z1] = b.max;
      const faces: [number[], number[][]][] = [
        [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
        [[-1, 0, 0], [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]]],
        [[0, 1, 0], [[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]]],
        [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
        [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
        [[0, 0, -1], [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]]],
      ];
      faces.forEach(([n, quad], fi) => {
        quad.forEach((p, vi) => {
          const o = (bi * 24 + fi * 4 + vi) * 3;
          const g = [p[0]!, p[2]!, -p[1]!];
          pos.set(g, o);
          nrm.set([n[0]!, n[2]!, -n[1]!], o);
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k]!, g[k]!);
            max[k] = Math.max(max[k]!, g[k]!);
          }
        });
        const v = bi * 24 + fi * 4;
        idx.set([v, v + 1, v + 2, v, v + 2, v + 3], bi * 36 + fi * 6);
      });
    });
    chunks.push({ pos, nrm, idx, min, max });
  }

  const views: { byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: unknown[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (arr: Float32Array | Uint32Array, target: number) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    views.push({ byteOffset: offset, byteLength: bytes.byteLength, target });
    parts.push(bytes);
    offset += bytes.byteLength;
    return views.length - 1;
  };
  const meshes = chunks.map((c, i) => {
    const pv = push(c.pos, 34962);
    const nv = push(c.nrm, 34962);
    const iv = push(c.idx, 34963);
    accessors.push({ bufferView: pv, componentType: 5126, count: c.pos.length / 3, type: "VEC3", min: c.min, max: c.max });
    accessors.push({ bufferView: nv, componentType: 5126, count: c.nrm.length / 3, type: "VEC3" });
    accessors.push({ bufferView: iv, componentType: 5125, count: c.idx.length, type: "SCALAR" });
    return { name: mats[i], primitives: [{ attributes: { POSITION: accessors.length - 3, NORMAL: accessors.length - 2 }, indices: accessors.length - 1, material: i }] };
  });
  const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1, 7), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((c) => Math.pow(c, 2.2));
  };
  const gltf = {
    asset: { version: "2.0", generator: "ai-native-rdt" },
    scene: 0,
    scenes: [{ nodes: meshes.map((_, i) => i) }],
    nodes: meshes.map((_, i) => ({ mesh: i, name: mats[i] })),
    meshes,
    materials: mats.map((mat) => ({
      name: mat,
      pbrMetallicRoughness: { baseColorFactor: [...rgb(scene.colours[mat]), mat === "glass" ? 0.5 : 1], metallicFactor: 0, roughnessFactor: 0.9 },
      ...(mat === "glass" ? { alphaMode: "BLEND" } : {}),
    })),
    accessors,
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    buffers: [{ byteLength: offset }],
  };
  const pad = (n: number) => (4 - (n % 4)) % 4;
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = pad(json.length);
  const jsonChunk = new Uint8Array(json.length + jsonPad).fill(0x20);
  jsonChunk.set(json);
  const binPad = pad(offset);
  const total = 12 + 8 + jsonChunk.length + 8 + offset + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunk.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  let p = 20 + jsonChunk.length;
  dv.setUint32(p, offset + binPad, true);
  dv.setUint32(p + 4, 0x004e4942, true);
  p += 8;
  for (const part of parts) {
    out.set(part, p);
    p += part.byteLength;
  }
  json = new Uint8Array();
  return out;
}
