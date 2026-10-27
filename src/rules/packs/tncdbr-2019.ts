/**
 * Tamil Nadu (TNCDBR 2019) rule pack for Non High Rise houses: road width,
 * height and storeys, setbacks, FSI and coverage. All numbers come from
 * ./tncdbr-2019.tables.ts.
 */
import { buildingExtent, builtUpArea, plotArea } from "../../model/areas.js";
import { bbox, contains, OPPOSITE, sideLength, type Rect } from "../../model/geometry.js";
import { stairLayout } from "../../model/structure.js";
import type { Finding, Project, Side } from "../../model/schema.js";
import { formatMetres } from "../../model/units.js";
import type { Cell, Check, Envelope, RulePack, SetbackRequirement } from "../types.js";
import { TNCDBR_2019 as T, type Band, type SideSetbackRow } from "./tncdbr-2019.tables.js";

const SOURCE = T.id;

export function pickBand<V>(bands: readonly Band<V>[], x: number): Cell<V> | null {
  for (const b of bands) {
    if (b.upToM === null) return b.cell;
    if (b.belowUpTo ? x < b.upToM : x <= b.upToM) return b.cell;
  }
  return null;
}

/** Height per r.2(57): ground to the roof of the topmost livable floor; terrace rooms excluded. */
export function buildingHeightMm(project: Project): number {
  return project.levels.filter((l) => l.kind !== "terrace").reduce((h, l) => h + l.floorToFloor, 0);
}

export function primaryRoad(project: Project) {
  return [...project.plot.abuttingRoads].sort((a, b) => b.widthM - a.widthM)[0] ?? null;
}

function missing<T>(cite: string, why: string): Cell<T> {
  return { value: null, cite, uncertain: why };
}

function setbackRoles(project: Project): Record<Side, "front" | "side" | "rear"> | null {
  const road = primaryRoad(project);
  if (!road) return null;
  const roadSides = new Set(project.plot.abuttingRoads.map((r) => r.side));
  const roles = {} as Record<Side, "front" | "side" | "rear">;
  for (const side of ["north", "south", "east", "west"] as Side[]) {
    roles[side] = roadSides.has(side) ? "front" : side === OPPOSITE[road.side] ? "rear" : "side";
  }
  return roles;
}

function sideSetbackRow(rows: readonly SideSetbackRow[], plotWidthM: number, heightM: number): SideSetbackRow | null {
  return (
    rows.find(
      (r) =>
        (r.plotWidthUpToM === null || plotWidthM <= r.plotWidthUpToM) && (r.heightUpToM === null || heightM <= r.heightUpToM),
    ) ?? null
  );
}

function derive(project: Project): Envelope {
  const cls = project.plot.areaClass;
  const plot = bbox(project.plot.boundary);
  const road = primaryRoad(project);
  const heightM = buildingHeightMm(project) / 1000;
  const roles = setbackRoles(project);

  const setbacks: SetbackRequirement[] = [];
  if (roles && road) {
    const frontageM = sideLength(plot, road.side) / 1000;
    for (const side of ["north", "south", "east", "west"] as Side[]) {
      const role = roles[side];
      if (role === "front") {
        const roadHere = project.plot.abuttingRoads.find((r) => r.side === side)!;
        const cell = pickBand(T.frontSetback[cls], roadHere.widthM) ?? missing<number>(T.frontSetback.other[0]!.cell.cite, "No band for this road width.");
        const multi = project.plot.abuttingRoads.length > 1 && roadHere !== road;
        setbacks.push({
          side,
          role,
          requiredMm: cell.value === null ? null : cell.value * 1000,
          applies: "each",
          cite: multi ? { ...cell, uncertain: "Corner plot: secondary road treated as a front; confirm how CMDA applies setbacks to the second road." } : cell,
        });
      } else if (role === "rear") {
        const bands = cls === "CBA" ? T.rearSetback.CBA : T.rearSetback.other;
        const cell = pickBand(bands, heightM) ?? missing<number>("TNCDBR 2019 r.35(1)(a) E(iii)", `No rear setback row for a ${heightM} m building.`);
        setbacks.push({ side, role, requiredMm: cell.value === null ? null : cell.value * 1000, applies: "each", cite: cell });
      } else {
        const rows = cls === "CBA" ? T.sideSetback.CBA : T.sideSetback.other;
        const row = sideSetbackRow(rows, frontageM, heightM);
        const base = T.sideSetback.cite;
        const uncertain = !row
          ? T.sideSetback.widerThan12mUncertain
          : cls === "EWS"
            ? T.sideSetback.EWSUncertain
            : undefined;
        setbacks.push({
          side,
          role,
          requiredMm: row ? row.setbackM * 1000 : null,
          applies: row?.applies === "one_side" ? "one_of_sides" : "each",
          cite: { ...base, value: row?.setbackM ?? null, ...(uncertain ? { uncertain } : {}) },
        });
      }
    }
  }

  const inset = (side: Side) => setbacks.find((s) => s.side === side && s.applies === "each")?.requiredMm ?? 0;
  const buildable: Rect = {
    x0: plot.x0 + inset("west"),
    x1: plot.x1 - inset("east"),
    y0: plot.y0 + inset("south"),
    y1: plot.y1 - inset("north"),
  };

  const heightBand = road ? pickBand(T.height[cls], road.widthM) : null;
  return {
    setbacks,
    buildable,
    maxFsi: T.fsi,
    premiumFsiFraction: road ? (pickBand(T.premiumFsi, road.widthM) ?? missing("TNCDBR 2019 r.49", "No band.")) : missing("TNCDBR 2019 r.49", "No road set."),
    maxHeightMm: heightBand
      ? { ...heightBand, value: heightBand.value ? heightBand.value.maxHeightM * 1000 : null }
      : missing("TNCDBR 2019 r.35(1)(a) B", "No road set."),
    maxStoreys: heightBand
      ? { ...heightBand, value: heightBand.value?.storeys ?? null }
      : missing("TNCDBR 2019 r.35(1)(a) B", "No road set."),
    maxCoverage: T.coverage,
    minRoadWidthM: T.minRoadWidthM[cls],
  };
}

const f = (severity: Finding["severity"], code: string, message: string, elements: string[] = []): Finding => ({
  severity,
  code,
  message,
  elements,
  source: SOURCE,
});

/** An info finding for a value that was used but needs confirming against the Gazette. */
function confirm(code: string, what: string, cell: Cell<unknown>): Finding[] {
  return cell.uncertain ? [f("info", `${code}.confirm`, `${what}: ${cell.uncertain} (${cell.cite}${cell.line ? `, line ${cell.line}` : ""})`)] : [];
}

const roadCheck: Check = {
  id: "tn.road",
  title: "Abutting road width",
  run(project, env) {
    const road = primaryRoad(project);
    if (!road) return [f("warn", "tn.road.missing", "No abutting road is set, so setbacks, height and premium FSI cannot be worked out. Tell me which side the road is on and how wide it is.")];
    const min = env.minRoadWidthM;
    if (min.value === null) return confirm("tn.road", "Minimum road width", min);
    if (road.widthM < min.value)
      return [f("block", "tn.road.too_narrow", `The road is ${road.widthM} m wide; ${min.cite} needs at least ${min.value} m for this building.`)];
    return [];
  },
};

const heightCheck: Check = {
  id: "tn.height",
  title: "Building height and storeys",
  run(project, env) {
    const out: Finding[] = [];
    const h = buildingHeightMm(project);
    const floors = project.levels.filter((l) => l.kind === "floor");
    const max = env.maxHeightMm;
    if (max.value !== null && h > max.value)
      out.push(f("block", "tn.height.exceeded", `Building height is ${formatMetres(h)}; ${max.cite} allows ${formatMetres(max.value)} on this road.`, project.levels.map((l) => l.id)));
    const storeys = env.maxStoreys;
    if (storeys.value !== null && floors.length > storeys.value)
      out.push(f("block", "tn.storeys.exceeded", `${floors.length} floors above ground/stilt; ${storeys.cite} allows ${storeys.value} on this road.`, floors.map((l) => l.id)));
    out.push(...confirm("tn.height", "Height limit", max));
    return out;
  },
};

const setbackCheck: Check = {
  id: "tn.setbacks",
  title: "Front, side and rear setbacks",
  run(project, env) {
    const extent = buildingExtent(project);
    if (!extent) return [];
    const plot = bbox(project.plot.boundary);
    const provided: Record<Side, number> = {
      north: plot.y1 - extent.y1,
      south: extent.y0 - plot.y0,
      east: plot.x1 - extent.x1,
      west: extent.x0 - plot.x0,
    };
    const roomIds = project.rooms.map((r) => r.id);
    const out: Finding[] = [];
    for (const s of env.setbacks) {
      out.push(...confirm(`tn.setback.${s.role}`, `${cap(s.role)} setback (${s.side})`, s.cite));
      if (s.requiredMm === null) continue;
      if (s.applies === "each" && provided[s.side] < s.requiredMm) {
        out.push(f("block", `tn.setback.${s.role}`, `${cap(s.role)} setback on the ${s.side} is ${formatMetres(provided[s.side])}; ${s.cite.cite} needs ${formatMetres(s.requiredMm)}.`, roomIds));
      }
    }
    const sides = env.setbacks.filter((s) => s.applies === "one_of_sides" && s.requiredMm !== null);
    if (sides.length && !sides.some((s) => provided[s.side] >= s.requiredMm!)) {
      const need = sides[0]!.requiredMm!;
      out.push(f("block", "tn.setback.side", `Neither side setback reaches ${formatMetres(need)} (${sides.map((s) => `${s.side} ${formatMetres(provided[s.side])}`).join(", ")}); ${sides[0]!.cite.cite} needs it on at least one side.`, roomIds));
    }
    return out;
  },
};

/** Covered area that counts toward FSI per r.29: open stilt parking and terrace stair rooms / small WCs are left out. */
export function fsiArea(project: Project): number {
  let total = 0;
  for (const level of project.levels) {
    if (level.kind === "stilt") continue;
    const rooms = project.rooms.filter((r) => {
      if (r.level !== level.id) return false;
      if (level.kind !== "terrace") return true;
      if (r.type === "staircase") return false;
      return !(r.type === "toilet" && builtUpArea([r]) <= (T.exclusions.terraceWcMaxSqm.value ?? 0));
    });
    total += builtUpArea(rooms);
  }
  return total;
}

const fsiCheck: Check = {
  id: "tn.fsi",
  title: "Floor Space Index",
  run(project, env) {
    const plot = plotArea(project);
    const used = fsiArea(project) / plot;
    const max = env.maxFsi.value;
    if (max === null) return confirm("tn.fsi", "FSI", env.maxFsi);
    const premium = env.premiumFsiFraction.value ?? 0;
    const msg = `FSI used ${used.toFixed(2)} of ${max.toFixed(2)} (${env.maxFsi.cite})`;
    if (used > max * (1 + premium) + 1e-9)
      return [f("block", "tn.fsi.exceeded", `${msg}${premium ? `, beyond the ${Math.round(premium * 100)}% premium FSI this road allows` : ""}.`)];
    if (used > max + 1e-9)
      return [f("warn", "tn.fsi.premium", `${msg}: the excess needs premium FSI (r.49), charged at 50% of guideline value for Non High Rise buildings.`)];
    return [f("info", "tn.fsi.ok", `${msg}.`)];
  },
};

const coverageCheck: Check = {
  id: "tn.coverage",
  title: "Plot coverage",
  run(project, env) {
    const ground = project.levels.find((l) => l.kind !== "terrace");
    if (!ground) return [];
    const pct = (builtUpArea(project.rooms.filter((r) => r.level === ground.id)) / plotArea(project)) * 100;
    const max = env.maxCoverage.value;
    if (max === null)
      return [f("info", "tn.coverage.unlimited", `Plot coverage is ${pct.toFixed(0)}%. ${env.maxCoverage.cite}: coverage is limited by setbacks only.`)];
    return pct > max * 100 ? [f("block", "tn.coverage.exceeded", `Plot coverage is ${pct.toFixed(0)}%; ${env.maxCoverage.cite} allows ${max * 100}%.`)] : [];
  },
};

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const stairCheck: Check = {
  id: "tn.stairs",
  title: "Stairways",
  run(project, env) {
    const out: Finding[] = [];
    const S = T.stairs;
    const plot = bbox(project.plot.boundary);
    const roles = setbackRoles(project);
    for (const stair of project.stairs) {
      const lay = stairLayout(project, stair);
      if (!lay) continue;
      const name = `The stair from ${project.levels.find((l) => l.id === stair.fromLevel)?.name ?? stair.fromLevel}`;
      if (lay.flightWidth < S.minWidthM.value! * 1000)
        out.push(f("block", "tn.stair.width", `${name} has ${formatMetres(lay.flightWidth)} wide flights; ${S.minWidthM.cite} needs ${formatMetres(S.minWidthM.value! * 1000)}.`, [stair.id]));
      if (stair.tread < S.minTreadMm.value!)
        out.push(f("block", "tn.stair.tread", `${name} has ${stair.tread} mm treads; ${S.minTreadMm.cite} needs at least ${S.minTreadMm.value} mm.`, [stair.id]));
      if (lay.riserHeight > S.maxRiserMm.value! + 0.5)
        out.push(f("block", "tn.stair.riser", `${name} has ${Math.round(lay.riserHeight)} mm risers; ${S.maxRiserMm.cite} allows ${S.maxRiserMm.value} mm. Add risers.`, [stair.id]));
      const longest = Math.max(...lay.flights.map((fl) => fl.risers));
      if (longest > S.maxRisersPerFlight.value!)
        out.push(f("block", "tn.stair.flight", `${name} has ${longest} risers in one flight; ${S.maxRisersPerFlight.cite} allows ${S.maxRisersPerFlight.value}. Add a landing.`, [stair.id]));
      out.push(...confirm("tn.stair.width", "Stair width", S.minWidthM));

      // Open stairs in setbacks, rule 28(a)(iii)
      if (stair.external && roles) {
        const R = T.setbackStructures;
        // Within the buildable area every setback is met; the boundary gaps still matter where a side setback is needed on one side only.
        const inSetback = !contains(env.buildable, lay.well);
        const h = buildingHeightMm(project) / 1000;
        if (inSetback && h > R.openStairUpToBuildingHeightM.value!) {
          out.push(f("block", "tn.stair.setback_height", `${name} is an open stair in the setback, which ${R.openStairUpToBuildingHeightM.cite} allows only up to ${R.openStairUpToBuildingHeightM.value} m building height; this building is ${h.toFixed(1)} m.`, [stair.id]));
          continue;
        }
        const gaps: Record<Side, number> = { west: lay.well.x0 - plot.x0, east: plot.x1 - lay.well.x1, south: lay.well.y0 - plot.y0, north: plot.y1 - lay.well.y1 };
        for (const side of ["north", "south", "east", "west"] as Side[]) {
          const need = (roles[side] === "side" ? R.openStairMinFromSideM.value! : R.openStairMinFromFrontRearM.value!) * 1000;
          if (gaps[side] < need)
            out.push(f("block", "tn.stair.setback_gap", `${name} is ${formatMetres(Math.max(0, gaps[side]))} from the ${side} boundary; ${R.openStairMinFromSideM.cite} keeps open stairs ${formatMetres(need)} from a ${roles[side]} boundary.`, [stair.id]));
        }
      }
    }
    return out;
  },
};

export const tncdbr2019: RulePack = {
  id: T.id,
  version: T.version,
  appliesTo: (project) => project.jurisdiction === "IN-TN-CMDA" || project.jurisdiction === "IN-TN-DTCP",
  derive,
  checks: [roadCheck, heightCheck, setbackCheck, fsiCheck, coverageCheck, stairCheck],
};
