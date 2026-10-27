/**
 * A compact text view of the model for the LLM: every name it may need to
 * resolve ("the kitchen window", "Bed 2's east wall") is listed with its id,
 * plus sizes in the units the user talks in. The prompt carries this, never
 * the whole model JSON.
 */
import { bbox, boundaryToRect, rectDepth, rectWidth, sideSegment, SIDES } from "../model/geometry.js";
import type { Project, Room, Side } from "../model/schema.js";
import { formatFtIn } from "../model/units.js";
import { clearRect, deriveWalls, resolveOpening, wallsOnSide, type Wall } from "../model/walls.js";
import { marksById } from "../output/schedule.js";
import { rulePacksFor } from "../rules/registry.js";
import { catalogueItem } from "../catalogue/catalogue.js";
import { computeBoq, formatInr } from "../cost/boq.js";
import { vastuReport } from "../rules/vastu.js";
import { gridRef, stairLayout, structuralGrid } from "../model/structure.js";
import { validate } from "../engine.js";
import { revisionLabel } from "./report.js";
import { trueFacing } from "../model/zones.js";

export { trueFacing };

const COMPASS: Record<Side, string> = { north: "N", south: "S", east: "E", west: "W" };

export function modelSummary(project: Project): string {
  const lines: string[] = [];
  const plot = bbox(project.plot.boundary);
  const facing = trueFacing(project.plot.northAngle);
  lines.push(`Project "${project.name}", revision ${revisionLabel(project.version)} (v${project.version}).`);
  lines.push(
    `Plot ${formatFtIn(rectWidth(plot))} (x, west→east) × ${formatFtIn(rectDepth(plot))} (y, south→north) = ${rectWidth(plot)} × ${rectDepth(plot)} mm, origin at the SW corner.`,
  );
  lines.push(
    project.plot.northAngle === 0
      ? "Plot sides face true north/south/east/west."
      : `Plot north is rotated: the plot's north side faces true ${facing.north}, east side ${facing.east}, south side ${facing.south}, west side ${facing.west}.`,
  );
  lines.push(
    `Roads: ${project.plot.abuttingRoads.map((r) => `${r.side} side, ${r.widthM} m${r.name ? ` (${r.name})` : ""}`).join("; ") || "none set"}. Jurisdiction ${project.jurisdiction}, area class ${project.plot.areaClass}. Vastu: ${project.prefs.vastu}.`,
  );

  if (project.plot.setbacks.length)
    lines.push(`Owner's setbacks (the building must keep clear): ${project.plot.setbacks.map((s) => `${s.side} ${s.distanceMm} mm (${s.purpose}${s.note ? `, ${s.note}` : ""})`).join("; ")}.`);
  if (project.plot.compoundWall) lines.push(`Compound wall on ${project.plot.compoundWall.sides.join(", ")}, ${project.plot.compoundWall.heightMm} mm high.`);

  const env = rulePacksFor(project)[0]?.derive(project);
  if (env?.setbacks.length) {
    lines.push(
      `Setbacks required: ${env.setbacks.map((s) => `${s.side} (${s.role}) ${s.requiredMm === null ? "unknown" : `${s.requiredMm} mm${s.applies === "one_of_sides" ? " on at least one side" : ""}`}`).join(", ")}.`,
    );
  }

  lines.push("", "Levels (bottom up):");
  for (const l of project.levels) lines.push(`- ${l.id} "${l.name}" ${l.kind}, floor-to-floor ${l.floorToFloor} mm, at +${l.elevation} mm`);

  const marks = marksById(project);
  for (const level of project.levels) {
    const rooms = project.rooms.filter((r) => r.level === level.id);
    if (!rooms.length) continue;
    const walls = deriveWalls(project, level.id);
    lines.push("", `Rooms on ${level.name} (centreline rectangle in mm; clear size inside the walls in ft-in):`);
    for (const room of rooms) lines.push(roomLine(project, room, walls));
    const openings = project.openings.filter((o) => rooms.some((r) => r.id === o.host.room));
    if (openings.length) {
      lines.push(`Openings on ${level.name} (offset is from the west end of a north/south side, or the south end of an east/west side):`);
      for (const o of openings) {
        const host = rooms.find((r) => r.id === o.host.room)!;
        const res = resolveOpening(project, walls, o);
        const other = res?.otherRoom ? project.rooms.find((r) => r.id === res.otherRoom)?.name : res?.wall ? "outside" : "?";
        lines.push(
          `- ${o.id} ${marks.get(o.id) ?? ""} ${o.type} on ${host.name}'s ${o.host.side} side, offset ${o.offset}, width ${o.width} (${formatFtIn(o.width)}), height ${o.height}, sill ${o.sill}, to ${other}${o.swing ? `, hinge at ${o.swing.hinge}, swings into ${o.swing.into === "host" ? host.name : other}` : ""}`,
        );
      }
    }
  }

  if (project.items.length) {
    lines.push("", "Furniture and fixtures (centre in mm; facing = direction the front faces):");
    for (const it of project.items) {
      const cat = catalogueItem(it.catalogue);
      const room = project.rooms.find((r) => r.id === it.room)?.name ?? it.room;
      lines.push(`- ${it.id} ${cat?.name ?? it.catalogue} [${it.catalogue}] in ${room}, centre (${it.at[0]}, ${it.at[1]}), facing ${it.facing}${it.mirror ? ", mirrored" : ""}`);
    }
  }
  if (project.trees.length) {
    lines.push("", "Trees (trunk centre in mm; radii in mm):");
    for (const t of project.trees)
      lines.push(`- ${t.id} ${t.species} at (${t.at[0]}, ${t.at[1]}), canopy ${t.canopyRadius}, root zone ${t.rootRadius}, ${t.keep ? "keep" : "to remove"}`);
  }
  if (project.stairs.length) {
    lines.push("", "Stairs (well rectangle in mm):");
    for (const st of project.stairs) {
      const r = boundaryToRect(st.boundary);
      const lay = stairLayout(project, st);
      const where = r ? `x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}` : "not a rectangle";
      const name = (id: string) => project.levels.find((l) => l.id === id)?.name ?? id;
      lines.push(`- ${st.id} ${st.shape}${st.external ? " open/external" : ""} from ${name(st.fromLevel)} to ${name(st.toLevel)}, ${where}, starts going ${st.up}${st.shape === "dog-leg" ? `, turns ${st.turn}` : ""}${lay ? `, ${lay.risers} risers of ${Math.round(lay.riserHeight)} mm, ${st.tread} mm treads, flights ${Math.round(lay.flightWidth)} mm wide` : ""}`);
    }
  }
  if (project.cores.length) {
    lines.push("", "Lifts, shafts and ducts (outer rectangle in mm):");
    const name = (id: string) => project.levels.find((l) => l.id === id)?.name ?? id;
    for (const c of project.cores) {
      const r = boundaryToRect(c.boundary);
      lines.push(`- ${c.id} ${c.kind}${c.name ? ` "${c.name}"` : ""} ${r ? `x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}` : ""}, ${name(c.fromLevel)} to ${name(c.toLevel)}${c.doorSide ? `, doors ${c.doorSide}` : ""}${c.persons ? `, ${c.persons} persons` : ""}`);
    }
  }
  if (project.columns.length) {
    const grid = structuralGrid(project);
    lines.push("", `Columns: ${project.columns.length}, max beam span ${project.prefs.maxSpanMm} mm. Grid ${grid.x.map((g) => `${g.label}=${g.at}`).join(" ")} (x), ${grid.y.map((g) => `${g.label}=${g.at}`).join(" ")} (y).`);
    for (const c of project.columns) lines.push(`- ${c.id} ${gridRef(project, c, grid)} ${c.width}×${c.depth} at (${c.at[0]}, ${c.at[1]}), ${c.fromLevel}–${c.toLevel}`);
  }

  if (project.prefs.vastu !== "off") {
    const rep = vastuReport(project);
    lines.push("", `Vastu (${project.prefs.vastu}, advisory): score ${rep.score} of ${rep.max}.`);
    for (const it of rep.items) lines.push(`- ${it.name}: ${it.key === "entrance" ? "faces" : "in"} ${it.zone}, ${it.grade}`);
  }

  if (project.rooms.length) {
    const boq = computeBoq(project);
    const top = [...boq.lines].sort((a, b) => b.amount - a.amount).slice(0, 4);
    const overrides = Object.entries(project.prefs.rates);
    lines.push(
      "",
      `Cost estimate (${boq.rateTable}): construction ${formatInr(boq.total)} incl. margin and contingency, ${formatInr(boq.perSqft)}/sq ft on ${Math.round(boq.builtUpSqm * 10.7639)} sq ft built-up${project.prefs.budgetInr ? `; budget ${formatInr(project.prefs.budgetInr)}` : ""}. Furniture and appliances ${formatInr(boq.furnitureTotal)} extra. Largest lines: ${top.map((l) => `${l.code} ${l.description.split(",")[0]} ${formatInr(l.amount)}`).join("; ")}.${overrides.length ? ` Rate overrides: ${overrides.map(([c, r]) => `${c} ${formatInr(r)}`).join(", ")}.` : ""}`,
    );
  }

  const issues = validate(project).filter((f) => f.severity !== "info");
  if (issues.length) {
    lines.push("", "Open issues:");
    for (const f of issues) lines.push(`- [${f.severity}] ${f.message}`);
  }
  return lines.join("\n");
}

function roomLine(project: Project, room: Room, walls: Wall[]): string {
  const r = boundaryToRect(room.boundary);
  if (!r) return `- ${room.id} "${room.name}" (${room.type}): not a rectangle`;
  const c = clearRect(walls, room);
  const sides = SIDES.map((side) => {
    const ws = wallsOnSide(walls, room, side);
    const seg = sideSegment(r, side);
    const parts = ws.map((w) => {
      const others = w.sourceRooms.filter((id) => id !== room.id).map((id) => project.rooms.find((x) => x.id === id)?.name ?? id);
      return `${others.length ? others.join("/") : "outside"} ${w.thickness}mm`;
    });
    return `${COMPASS[side]} (${seg.at}): ${parts.join(", ") || "?"}`;
  });
  return `- ${room.id} "${room.name}" (${room.type})${room.flat ? ` flat ${room.flat}` : ""}, x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}; clear ${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))} (W×D); zone ${room.zoneTags.join(",")}; walls ${sides.join("; ")}`;
}
