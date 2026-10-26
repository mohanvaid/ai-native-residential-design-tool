import type { Finding, Project } from "../model/schema.js";
import { tncdbr2019 } from "./packs/tncdbr-2019.js";
import type { Envelope, RulePack } from "./types.js";

export const RULE_PACKS: RulePack[] = [tncdbr2019];

/** Packs named in project.ruleSets, or else every pack that applies to the jurisdiction. */
export function rulePacksFor(project: Project): RulePack[] {
  if (project.ruleSets.length) return RULE_PACKS.filter((p) => project.ruleSets.includes(p.id));
  return RULE_PACKS.filter((p) => p.appliesTo(project));
}

export function runRulePacks(project: Project): { envelopes: Map<string, Envelope>; findings: Finding[] } {
  const envelopes = new Map<string, Envelope>();
  const findings: Finding[] = [];
  for (const pack of rulePacksFor(project)) {
    const env = pack.derive(project);
    envelopes.set(pack.id, env);
    for (const check of pack.checks) findings.push(...check.run(project, env));
  }
  return { envelopes, findings };
}
