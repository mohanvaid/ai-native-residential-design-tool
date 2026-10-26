/** Door and window marks (D1, W1, V1 ...): openings of the same type and size share a mark. */
import type { Opening, OpeningType, Project } from "../model/schema.js";

const PREFIX: Record<OpeningType, string> = { door: "D", window: "W", ventilator: "V", opening: "O" };

export interface ScheduleRow {
  mark: string;
  type: OpeningType;
  width: number;
  height: number;
  sill: number;
  count: number;
  openings: string[];
}

export function openingSchedule(project: Project): ScheduleRow[] {
  const groups = new Map<string, Opening[]>();
  for (const o of project.openings) {
    const key = `${o.type}|${o.width}|${o.height}|${o.sill}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const rows = [...groups.values()].sort((a, b) => {
    const x = a[0]!;
    const y = b[0]!;
    return x.type.localeCompare(y.type) || y.width - x.width || y.height - x.height || x.sill - y.sill;
  });
  const counters: Partial<Record<OpeningType, number>> = {};
  return rows.map((group) => {
    const o = group[0]!;
    counters[o.type] = (counters[o.type] ?? 0) + 1;
    return {
      mark: `${PREFIX[o.type]}${counters[o.type]}`,
      type: o.type,
      width: o.width,
      height: o.height,
      sill: o.sill,
      count: group.length,
      openings: group.map((g) => g.id),
    };
  });
}

export function marksById(project: Project): Map<string, string> {
  return new Map(openingSchedule(project).flatMap((row) => row.openings.map((id) => [id, row.mark] as const)));
}
