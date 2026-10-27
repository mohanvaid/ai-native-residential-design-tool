/**
 * Who may do what on a design, the comments they leave on it, and the sign-off
 * that freezes a revision.
 *
 * Roles follow the specification: an owner does anything, a collaborator edits
 * but only off the main branch, and a reviewer only reads and comments. A
 * registered professional signs off a revision, which freezes it and replaces
 * the advisory stamp on its drawings with their declaration. A revision with
 * blocking findings cannot be signed off.
 */
import type { Finding, Project } from "../model/schema.js";

export const ROLES = ["owner", "collaborator", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export interface Member {
  id: string;
  name: string;
  role: Role;
  /** A registered professional's licence, e.g. "TN/LE/12345"; needed to sign off. */
  licence?: string;
}

export interface Comment {
  id: string;
  /** Member id, or "claude". */
  author: string;
  text: string;
  at: string;
  /** Branch and version the comment was left on. */
  branch: string;
  version: number;
  /** Element ids the comment is pinned to: rooms, openings, items, cores, points. */
  elements: string[];
  /** Resolved by this member, if any. */
  resolvedBy?: string;
  resolvedAt?: string;
  /** Comment this one answers. */
  replyTo?: string;
}

export interface SignOff {
  branch: string;
  version: number;
  /** Member id of the professional who signed. */
  by: string;
  name: string;
  licence: string;
  at: string;
  /** What they signed off for: the stamp text follows from it. */
  purpose: "construction" | "approval" | "tender";
  note?: string;
}

export type Action = "read" | "comment" | "edit" | "edit_main" | "branch" | "tag" | "sign_off" | "manage_members";

const ALLOWED: Record<Role, ReadonlySet<Action>> = {
  owner: new Set<Action>(["read", "comment", "edit", "edit_main", "branch", "tag", "sign_off", "manage_members"]),
  collaborator: new Set<Action>(["read", "comment", "edit", "branch", "tag"]),
  reviewer: new Set<Action>(["read", "comment"]),
};

export function can(member: Member | undefined, action: Action): boolean {
  if (!member) return false;
  if (action === "sign_off") return ALLOWED[member.role].has("sign_off") && !!member.licence;
  return ALLOWED[member.role].has(action);
}

/** Why an action is refused, in words for the person who tried it. */
export function refusal(member: Member | undefined, action: Action, context = ""): string {
  if (!member) return "You are not a member of this design.";
  if (action === "sign_off" && ALLOWED[member.role].has("sign_off") && !member.licence)
    return `${member.name} has no licence number on record; only a registered professional can sign off a revision.`;
  const what: Record<Action, string> = {
    read: "read this design",
    comment: "comment on this design",
    edit: "edit this design",
    edit_main: "edit the main branch",
    branch: "start a branch",
    tag: "tag a revision",
    sign_off: "sign off a revision",
    manage_members: "change who is on this design",
  };
  const advice = action === "edit_main" && member.role === "collaborator" ? " Start a branch and the owner can merge it." : action === "edit" || action === "edit_main" ? " Ask the owner for edit access." : "";
  return `${member.name} is a ${member.role} on this design and cannot ${what[action]}${context ? ` (${context})` : ""}.${advice}`;
}

/** The stamp a signed-off revision carries instead of the advisory one. */
export function signOffStamp(s: SignOff): string {
  const purpose = { construction: "ISSUED FOR CONSTRUCTION", approval: "ISSUED FOR APPROVAL", tender: "ISSUED FOR TENDER" }[s.purpose];
  return `${purpose} · ${s.name.toUpperCase()}, ${s.licence} · ${s.at.slice(0, 10)}`;
}

/** Blocking findings stop a sign-off; the professional sees what to fix first. */
export function signOffBlockers(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "block");
}

/** Comments that still point at something in this version of the project. */
export function liveComments(project: Project, comments: Comment[]): Comment[] {
  const ids = new Set<string>([
    ...project.rooms.map((r) => r.id),
    ...project.openings.map((o) => o.id),
    ...project.items.map((i) => i.id),
    ...project.cores.map((c) => c.id),
    ...project.mep.map((p) => p.id),
    ...project.levels.map((l) => l.id),
    ...project.stairs.map((s) => s.id),
    ...project.trees.map((t) => t.id),
  ]);
  return comments.filter((c) => !c.elements.length || c.elements.some((e) => ids.has(e)));
}
