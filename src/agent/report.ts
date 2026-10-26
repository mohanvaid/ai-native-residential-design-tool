/**
 * The one-line change summary that ends every reply: what changed in the
 * user's units and what it knocked on, computed from the change set rather
 * than written by the LLM.
 */
import { catalogueItem } from "../catalogue/catalogue.js";
import { costDelta, formatInr } from "../cost/boq.js";
import { boundaryToRect, rectDepth, rectWidth } from "../model/geometry.js";
import type { Finding, Project, Room } from "../model/schema.js";
import { formatFtIn } from "../model/units.js";
import { clearRect, deriveWalls } from "../model/walls.js";
import type { ChangeSet } from "../ops/changes.js";

/** 1 → A, 26 → Z, 27 → AA: revision labels as drawings carry them. */
export function revisionLabel(version: number): string {
  let n = version;
  let s = "";
  while (n > 0) {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s || "0";
}

function clearSize(project: Project, room: Room): string {
  if (!boundaryToRect(room.boundary)) return "?";
  const c = clearRect(deriveWalls(project, room.level), room);
  return `${formatFtIn(rectWidth(c))} × ${formatFtIn(rectDepth(c))}`;
}

export function changeSummary(before: Project, after: Project, changes: ChangeSet, findings: Finding[]): string {
  const parts: string[] = [];
  let openings = { added: 0, removed: 0, changed: 0 };
  // Rooms whose clear size changed because a neighbour moved a shared wall also count as knock-ons.
  const roomIds = new Set(changes.filter((c) => c.kind === "room").map((c) => c.id));
  for (const id of roomIds) {
    const was = before.rooms.find((r) => r.id === id);
    const now = after.rooms.find((r) => r.id === id);
    if (!was && now) parts.push(`added ${now.name} ${clearSize(after, now)}`);
    else if (was && !now) parts.push(`removed ${was.name}`);
    else if (was && now) {
      const a = clearSize(before, was);
      const b = clearSize(after, now);
      if (was.name !== now.name) parts.push(`${was.name} renamed ${now.name}`);
      if (a !== b) parts.push(`${now.name} now ${b} (was ${a})`);
      else if (JSON.stringify(was.boundary) !== JSON.stringify(now.boundary)) parts.push(`${now.name} moved`);
      else if (was.type !== now.type) parts.push(`${now.name} is now a ${now.type}`);
      else if (was.finishes.floor !== now.finishes.floor) parts.push(`${now.name} floor now ${catalogueItem(now.finishes.floor ?? "")?.name.toLowerCase() ?? "default"}`);
    }
  }
  for (const c of changes) {
    if (c.kind !== "opening") continue;
    if (!c.before) openings.added++;
    else if (!c.after) openings.removed++;
    else openings.changed++;
  }
  const o = [
    openings.added && `${openings.added} opening(s) added`,
    openings.removed && `${openings.removed} removed`,
    openings.changed && `${openings.changed} adjusted`,
  ].filter(Boolean);
  if (o.length) parts.push(o.join(", "));
  for (const c of changes) {
    if (c.kind !== "item") continue;
    const it = c.after ?? c.before!;
    const cat = catalogueItem(it.catalogue)?.name.toLowerCase() ?? it.catalogue;
    const roomName = (p: Project) => p.rooms.find((r) => r.id === it.room)?.name ?? it.room;
    if (!c.before) parts.push(`added ${cat} in ${roomName(after)}`);
    else if (!c.after) parts.push(`removed ${cat} from ${roomName(before)}`);
    else if (c.before.catalogue !== c.after.catalogue) parts.push(`${catalogueItem(c.before.catalogue)?.name.toLowerCase() ?? c.before.catalogue} swapped for ${cat}`);
    else parts.push(`${cat} moved`);
  }
  for (const kind of ["tree", "column", "stair"] as const) {
    const cs = changes.filter((c) => c.kind === kind);
    const n = { added: cs.filter((c) => !c.before).length, removed: cs.filter((c) => !c.after).length, changed: cs.filter((c) => c.before && c.after).length };
    const word = (k: number) => `${k} ${kind}${k === 1 ? "" : "s"}`;
    const bits = [n.added && `${word(n.added)} added`, n.removed && `${word(n.removed)} removed`, n.changed && `${word(n.changed)} adjusted`].filter(Boolean);
    if (bits.length) parts.push(bits.join(", "));
  }
  if (changes.some((c) => c.kind === "levels")) parts.push(`levels: ${after.levels.map((l) => l.name).join(", ")}`);
  if (changes.some((c) => c.kind === "plot")) parts.push("plot updated");
  if (changes.some((c) => c.kind === "prefs")) parts.push("preferences updated");
  if (after.rooms.length) {
    const cost = costDelta(before, after);
    // Under ₹5,000 is noise at this level of estimate
    if (!before.rooms.length) parts.push(`estimate ${formatInr(cost.after)}`);
    else if (Math.abs(cost.delta) >= 5000) parts.push(`cost ${cost.delta > 0 ? "+" : ""}${formatInr(cost.delta)} to ${formatInr(cost.after)}`);
  }

  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  const checks = blocks ? `${blocks} blocking issue(s)` : warns ? `${warns} warning(s)` : "all checks pass";
  return `Rev ${revisionLabel(after.version)}: ${parts.join("; ") || "no change"} · ${checks}`;
}
