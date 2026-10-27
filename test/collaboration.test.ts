import { describe, expect, it } from "vitest";
import { ADVISORY_STAMP, Design, dryRun, newProject, renderFloorPlanSvg, type OpInput, type Project } from "../src/index.js";

function started(): Project {
  const r = dryRun(newProject({ id: "c", name: "C house", plotWidthMm: 12000, plotDepthMm: 15000, jurisdiction: "NONE" }), [
    { op: "AddRoom", args: { id: "liv", name: "Living", type: "living", level: "lv_gf", x: 1000, y: 1000, width: 4500, depth: 4000 } },
    { op: "AddOpening", args: { id: "d1", type: "door", room: "liv", side: "south", offset: 600, width: 1050 } },
    { op: "AddOpening", args: { id: "w1", type: "window", room: "liv", side: "west", width: 1500 } },
  ]);
  if (r.status === "rejected") throw new Error(r.error!.message);
  return r.project;
}

function design(): Design {
  const d = new Design("d", "C house", started());
  d.addMember({ id: "mohan", name: "Mohan", role: "owner" });
  d.addMember({ id: "priya", name: "Priya", role: "collaborator" }, "mohan");
  d.addMember({ id: "ravi", name: "Ravi", role: "reviewer" }, "mohan");
  d.addMember({ id: "arch", name: "S. Kumar", role: "owner", licence: "TN/LE/12345" }, "mohan");
  return d;
}

const rename: OpInput[] = [{ op: "RenameRoom", target: "liv", args: { name: "Hall" } }];

describe("roles", () => {
  it("lets an owner edit main, keeps a collaborator to branches, and a reviewer out", () => {
    const d = design();
    expect(d.commitAs("mohan", rename).status).toBe("committed");
    expect(() => d.commitAs("priya", rename)).toThrow(/cannot edit the main branch.*Start a branch/s);
    d.createBranch("priya-option");
    expect(d.commitAs("priya", [{ op: "RenameRoom", target: "liv", args: { name: "Living room" } }]).status).toBe("committed");
    expect(() => d.commitAs("ravi", rename)).toThrow(/Ravi is a reviewer/);
    expect(() => d.comment("ravi", "The hall feels narrow", ["liv"])).not.toThrow();
  });

  it("restricts nothing when the design has no members", () => {
    const d = new Design("s", "Solo", started());
    expect(d.commitAs(undefined, rename).status).toBe("committed");
  });
});

describe("comments", () => {
  it("pins comments to elements, keeps replies, and drops ones whose element is gone", () => {
    const d = design();
    const c = d.comment("ravi", "Move this window to the south", ["w1"]);
    d.comment("mohan", "Agreed", ["w1"], c.id);
    d.comment("ravi", "Nothing in particular");
    expect(d.openComments()).toHaveLength(3);
    d.resolveComment(c.id, "mohan");
    expect(d.openComments().map((x) => x.id)).not.toContain(c.id);
    d.commitAs("mohan", [{ op: "RemoveOpening", target: "w1" }]);
    expect(d.openComments().map((x) => x.text)).toEqual(["Nothing in particular"]);
  });
});

describe("sign-off", () => {
  it("needs a licence, refuses on blocking findings, then freezes the revision and changes the stamp", () => {
    const d = design();
    expect(() => d.signOff("mohan")).toThrow(/no licence/);
    expect(() => d.signOff("ravi")).toThrow(/Ravi is a reviewer/);

    // A blocking problem must be fixed first
    d.commitAs("mohan", [{ op: "AddRoom", args: { id: "bad", name: "Store", type: "store", level: "lv_gf", x: 2000, y: 2000, width: 2000, depth: 2000 } }], { acceptBlocking: true });
    expect(() => d.signOff("arch")).toThrow(/blocking findings/);
    d.commitAs("mohan", [{ op: "RemoveRoom", target: "bad" }]);

    const s = d.signOff("arch", "approval");
    expect(s).toMatchObject({ by: "arch", licence: "TN/LE/12345", purpose: "approval" });
    expect(d.revisions().at(-1)!.tag).toBe("Signed off for approval");
    expect(() => d.commitAs("mohan", rename)).toThrow(/signed off and frozen/);

    const plain = renderFloorPlanSvg(d.store.current, "lv_gf");
    expect(plain).toContain(ADVISORY_STAMP);
    const stamped = d.stamped(() => renderFloorPlanSvg(d.store.current, "lv_gf"));
    expect(stamped).toContain("ISSUED FOR APPROVAL");
    expect(stamped).toContain("S. KUMAR, TN/LE/12345");
    expect(stamped).not.toContain(ADVISORY_STAMP);
    // A branch from the frozen revision carries on, and its drawings are advisory again
    d.createBranch("after-approval");
    expect(d.commitAs("mohan", rename).status).toBe("committed");
    expect(d.stamped(() => renderFloorPlanSvg(d.store.current, "lv_gf"))).toContain(ADVISORY_STAMP);
  });

  it("saves and reloads members, comments and sign-offs", () => {
    const d = design();
    d.comment("ravi", "Check the window", ["w1"]);
    d.signOff("arch");
    const back = Design.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
    expect(back.members.map((m) => m.id)).toEqual(["mohan", "priya", "ravi", "arch"]);
    expect(back.openComments()).toHaveLength(1);
    expect(back.signOffOf("main", back.store.current.version)).toMatchObject({ licence: "TN/LE/12345" });
    expect(() => back.commitAs("mohan", rename)).toThrow(/frozen/);
    expect(back.comment("ravi", "another").id).toBe("c2");
  });
});
