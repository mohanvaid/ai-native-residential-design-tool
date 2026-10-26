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
import { validate } from "../engine.js";
import { revisionLabel } from "./report.js";

const COMPASS: Record<Side, string> = { north: "N", south: "S", east: "E", west: "W" };

/** Which true-compass direction each plot side faces, e.g. plot "north" → "NE" when northAngle is 45°. */
export function trueFacing(northAngle: number): Record<Side, string> {
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const base: Record<Side, number> = { north: 0, east: 90, south: 180, west: 270 };
  const out = {} as Record<Side, string>;
  for (const side of SIDES) out[side] = names[Math.round((((base[side] - northAngle) % 360) + 360) % 360 / 45) % 8]!;
  return out;
}

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
  return `- ${room.id} "${room.name}" (${room.type}), x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}; clear ${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))} (W×D); zone ${room.zoneTags.join(",")}; walls ${sides.join("; ")}`;
}
