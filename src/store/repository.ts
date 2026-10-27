/**
 * Designs saved as one JSON file each in a folder. Writes go to a temporary
 * file first and are renamed into place, so a crash never leaves half a file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { revisionLabel } from "../agent/report.js";
import type { Project } from "../model/schema.js";
import { Design, slugify, type StoredDesign } from "./design.js";

export interface DesignListing {
  id: string;
  name: string;
  current: string;
  branches: string[];
  /** Latest revision of the current branch. */
  rev: string;
  updatedAt: string;
}

export class FileRepository {
  constructor(readonly dir: string) {}

  private path(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`"${id}" is not a design id.`);
    return join(this.dir, `${id}.json`);
  }

  exists(id: string): boolean {
    return existsSync(this.path(id));
  }

  /** Starts a new design, with an id made from its name that no saved design uses yet. */
  create(name: string, project: Project): Design {
    const base = slugify(name);
    let id = base;
    for (let n = 2; this.exists(id); n++) id = `${base}-${n}`;
    const design = new Design(id, name, project);
    this.save(design);
    return design;
  }

  save(design: Design): string {
    mkdirSync(this.dir, { recursive: true });
    const file = this.path(design.id);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(design.toJSON()));
    renameSync(tmp, file);
    return file;
  }

  load(id: string): Design {
    if (!this.exists(id)) throw new Error(`There is no saved design "${id}".`);
    return Design.fromJSON(JSON.parse(readFileSync(this.path(id), "utf8")) as StoredDesign);
  }

  list(): DesignListing[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          const d = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as StoredDesign;
          const head = d.branches[d.current]?.history.at(-1);
          return [{ id: d.id, name: d.name, current: d.current, branches: Object.keys(d.branches), rev: revisionLabel(head?.version ?? 0), updatedAt: d.updatedAt }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
