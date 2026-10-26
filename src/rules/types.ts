import type { Rect } from "../model/geometry.js";
import type { Finding, Project, Side } from "../model/schema.js";

/**
 * One table value transcribed from a rule book. Values stay data so that an
 * amendment changes a table, not code.
 */
export interface Cell<T> {
  /** null when the rule book has no value for this case, or it is not transcribed yet. */
  value: T | null;
  /** Rule reference, e.g. "TNCDBR 2019 r.35(1)(a) E(i)". */
  cite: string;
  /** Line in the extracted rules text the value was read from. */
  line?: number;
  /** Set when the source text is garbled or the table layout is ambiguous; says what to confirm. */
  uncertain?: string;
}

export type SetbackRole = "front" | "side" | "rear";

export interface SetbackRequirement {
  side: Side;
  role: SetbackRole;
  /** Required clear distance in mm from the plot edge, or null when unknown. */
  requiredMm: number | null;
  /**
   * "each": this side must provide it. "one_of_sides": at least one of the
   * two side setbacks must provide it (TN "1 m on one side").
   */
  applies: "each" | "one_of_sides";
  cite: Cell<unknown>;
}

/** What a rule pack allows on this plot: derived, never typed by hand. */
export interface Envelope {
  setbacks: SetbackRequirement[];
  /** The plot inset by every "each" setback that is known. */
  buildable: Rect;
  maxFsi: Cell<number>;
  /** Premium FSI as a fraction of the normal FSI (0.3 = +30%), when the road qualifies. */
  premiumFsiFraction: Cell<number>;
  maxHeightMm: Cell<number>;
  /** Livable storeys allowed above a ground floor or stilt (GF+2 → 3 storeys). */
  maxStoreys: Cell<number>;
  maxCoverage: Cell<number>;
  minRoadWidthM: Cell<number>;
}

export interface Check {
  id: string;
  title: string;
  run(project: Project, envelope: Envelope): Finding[];
}

export interface RulePack {
  id: string;
  /** Rule book version or amendment the tables were transcribed from. */
  version: string;
  appliesTo(project: Project): boolean;
  derive(project: Project): Envelope;
  checks: Check[];
}
