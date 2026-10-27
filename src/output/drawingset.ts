/** The full drawing set, in sheet order: site plan, floor plans, elevations, section, schedules. */
import { boqTable, flatCostTable } from "../cost/boq.js";
import type { Project } from "../model/schema.js";
import { elevationSheets, sectionSheet } from "./elevation.js";
import { floorPlanSheet, type FloorPlanOptions } from "./floorplan.js";
import { sheetsToPdf, type Paper } from "./pdf.js";
import { areaStatementTable, doorWindowTable, flooringTable, furnitureTable, scheduleSheets } from "./schedules.js";
import type { Sheet } from "./sheet.js";
import { siteplanSheet } from "./siteplan.js";

export interface DrawingSheet {
  /** Short name for a tab, e.g. "Ground" or "East elev.". */
  tab: string;
  sheet: Sheet;
}

export function drawingSet(project: Project, opts: FloorPlanOptions = {}): DrawingSheet[] {
  const elevations = elevationSheets(project).map((sheet) => ({ tab: sheet.title.split(" · ")[1]!.replace(" elevation", " elev.").replace(" (road side)", ""), sheet }));
  return [
    { tab: "Site", sheet: siteplanSheet(project) },
    ...project.levels.map((l) => ({ tab: l.name, sheet: floorPlanSheet(project, l.id, opts) })),
    ...elevations,
    { tab: "Section", sheet: sectionSheet(project) },
    ...scheduleSheets(project, [areaStatementTable(project), doorWindowTable(project), flooringTable(project), furnitureTable(project), boqTable(project), ...(project.rooms.some((r) => r.flat) ? [flatCostTable(project)] : [])]).map((sheet, i, all) => ({ tab: all.length > 1 ? `Schedules ${i + 1}` : "Schedules", sheet })),
  ];
}

/** The whole drawing set as one PDF. */
export function renderDrawingSetPdf(project: Project, opts: FloorPlanOptions & { paper?: Paper } = {}): Uint8Array {
  return sheetsToPdf(drawingSet(project, opts).map((d) => d.sheet), { paper: opts.paper });
}
