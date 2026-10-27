# What the specification asks for, and what is built

This maps every section of the product specification to the code that serves it, and
says plainly what is still open. The scope is the specification's MVP: one
residential building type, an independent house or stilt + up to 3 floors, on a
rectilinear plot in Chennai.

Legend: **built** · **partial** (works, with the limit named) · **open**.

## Core workflow

| Specification | State | Where |
| --- | --- | --- |
| One loop per message: interpret, apply a typed edit, check, regenerate what changed, reply with effects | built | `src/agent/agent.ts`, `src/engine.ts`, `src/core/deps.ts` |
| Under 2 s for a small edit, excluding the model's own time | built | measured 65–100 ms to regenerate the affected outputs of a stilt + 3 design |
| User interrupted only for geometry-changing ambiguity or a failed check with a proposed fix | built | agent system prompt; `dryRun` returns blocking findings with the fix as one op |
| Direct manipulation produces the same typed operations as chat, sharing undo, validation and history | built | `src/studio/` — a drag becomes `MoveRoom` through the same commit path |

## Data model

| Entity | State | Notes |
| --- | --- | --- |
| Project: location, authority, north angle, display units, rule profile | built | `SetRuleProfile` switches the pack and Vastu |
| Plot: boundary, road edges, access edges, existing compound walls | built | access passages and compound walls draw on the site plan |
| Setback: per edge, distance, source (rule or user), purpose | built | owner setbacks draw dashed beside the rule setbacks |
| Tree / site feature: canopy and root radius, keep/remove | built | keep-out zones block footprint, parking and sumps |
| Level: stilt, L1–L3, terrace, floor-to-floor, slab | built | stilt is excluded from FSI by level kind |
| Grid and column: lines, size, level span | built | `PlaceColumns`, alignment and span checks |
| Wall: axis, thickness, type, material, finish per face | partial | walls are derived from room rectangles (230 mm external, 115 mm internal) rather than drawn as entities; there is no per-face finish or plumbing-wall type, and no `add/remove_wall` op |
| Opening: host wall, offset, width, height, sill, type, swing | built | includes sliding and ventilators |
| Room / space: name, type, flat ID, wet flag | built | `AssignFlat`; wet rooms drive the stack checks |
| Furniture / fixture: catalogue ID, position, rotation, mirror | built | chaise left/right as mirrored entries |
| MEP point: type, host, height, circuit / stack | built | `src/model/mep.ts`, auto-placed or placed one by one |
| Finish: surface, material catalogue ID, colour theme | partial | floor, wall and ceiling per room, with interior themes; not per wall face |
| Vertical core: stair, lift, shaft, duct, spanning levels | built | `src/model/core.ts`, continuity checked through every level |
| Version: revision ID, parent, operation log, author, label, tag | built | `src/store/design.ts`; each revision records its author and the assumptions stated |
| Derived data never stored as truth, cached with its version | built | `OutputCache` keys every artefact by version |
| Dependency graph: a wall move dirties only its rooms, openings, furniture, sheets, schedules and BOQ lines | partial | the graph is kept per output rather than per BOQ line, and validation still runs over the whole model, which is fast enough at this size (a few milliseconds) |

## Tools exposed to the agent

All nine tool families in the specification are present: `query_model`,
`resolve_reference`, move/resize/`AlignElements`, add/remove opening,
`MergeRooms` / `SplitRoom`, `PlaceItem`, `SetFinish` / `ApplyTheme`,
`SetRuleProfile` / `run_checks`, `generate`, and the version ops (commit, undo,
branch, save as, compare). `add/remove_wall` is the one gap, and follows from
walls being derived rather than drawn.

The assumptions the specification says the agent must always state — orientation
against the north arrow, explicit units, clear versus centre-to-centre, and which
side stayed fixed — are required by the system prompt and recorded on the
revision. Every reply ends with the computed change summary and the knock-on
effects, including the cost delta.

## Validation engine

Every check family in the specification is implemented, at the severity it asks
for: clearances, door swings (including into a corridor or lift lobby), car
parking and the turning path in from the access, setbacks and envelope with tree
keep-outs, structural grid sanity, stacked wet areas, vertical circulation
(rise, tread, headroom, core continuity), the Tamil Nadu rule pack with clause
references, and opt-in Vastu scored by zone and never blocking.

Open: fire and egress checks beyond core continuity, and rules are data in a
versioned pack but the checks that read them are code, so a new authority needs
a new pack module rather than only a new table.

## Output generators

| Output | Formats asked for | State |
| --- | --- | --- |
| 2D sheets: site plan, floor plans, furniture plans, working plans, area statement | SVG, PDF, DXF | built |
| Elevations and sections | SVG, PDF | built |
| Web 3D: walk-around, per-floor toggles, finish materials | one self-contained HTML | built, about 0.7 MB |
| Detail elevations: kitchen, wardrobes, TV unit, utility | SVG, PDF | built at 1:25 |
| Door / window schedule | PDF, XLSX | built |
| Flooring and finish schedule | PDF, XLSX | built |
| Electrical schedule with circuits and DB location | PDF, XLSX, layout sheet | built |
| Plumbing schedule with stacks and shafts | PDF, XLSX, layout sheet | built |
| BOQ and cost, totals per flat and per sq ft | XLSX, PDF | built |
| Compare: overlay plans with changes highlighted, delta table | — | built |

Every output is a pure function of the model version and the output spec, carries
the revision label, north arrow, scale bar and units, and can be regenerated for
any past revision.

## Mobile and WhatsApp first

All five design rules are met: on-screen +, −, fit and reset buttons with pinch
as a bonus; single-file viewers with every asset inlined, working offline; a
100dvh layout with no fixed desktop widths; a PDF offered alongside every link;
and share links that carry a preview image so the chat itself shows the plan.

## Catalogue layer

Generic Indian-standard sizes are curated in-house across all five categories —
cars and two-wheelers, appliances, sanitaryware, tiles and finishes, furniture —
each with a footprint, required clearances, service needs, a price band in INR
and a versioned id, so a saved design does not change when an entry is updated.
Brand catalogues and SKUs are open, as the specification intends for a partner
phase.

## Versioning and sharing

Revisions, named designs pinned to a revision, branches forked from any revision,
compare as both a delta table and an overlay drawing, view-only share links with
offline packages, comments pinned to an entity rather than to pixels, and the
three roles — owner, collaborator who edits only off the main branch, reviewer who
reads and comments. A signed-off revision is frozen and a further edit must be
signed off again.

## Professional boundary

Every sheet carries the advisory stamp until a registered professional signs off
that revision, which records their name, registration number and the exact
revision and replaces the stamp with their declaration. Structural output stays
at sanity-check level. Rule-pack findings cite the clause and the pack version
and say that the local authority's interpretation prevails, and cells still to be
checked against the printed Gazette report themselves.

## System architecture

The kernel is TypeScript, shared by browser and server, and the model sits outside
it: it only proposes typed operations, which the kernel applies, checks and
versions. Outputs are regenerated with no model calls.

Open, and deliberately so at this stage: Postgres with an op-log table and object
storage (designs are JSON files today), a Python worker for heavy checks, signed
share links with accounts behind them, and a hosted deployment. The studio is a
local HTTP server, not a multi-tenant service.

## Performance targets

| Target | Measured |
| --- | --- |
| Apply, validate and regenerate the visible sheet under 500 ms | 65–100 ms for a small edit on a stilt + 3 design |
| Full output set for a stilt + 3 building under 30 s | 130 ms over 32 outputs |
| Offline 3D HTML under 5 MB | about 0.7 MB |

## Success test

`npm run reference` rebuilds the reference project — stilt + 3 floors on a
62'6" × 52' plot with the road to the north, one flat per floor sharing a stair
and lift core — as a single script of typed operations, and writes every output
from it. The remaining findings on it are genuine observations about that plan
rather than engine gaps: an interior living room with no external window, two
tight passages, and a powder room that wants a shaft.

## Beyond the MVP, not built

These belong to later phases of the specification's own roadmap: feasibility from
the plot alone ("best 3BHK layouts for this plot"), interior quotation export as
a separate document, rule packs for other states, conversation in Tamil or Hindi,
a professional marketplace, and site-progress tracking against the model.
