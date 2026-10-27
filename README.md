# AI-Native Residential Design Tool

A conversational design tool for independent houses and stilt + 3 apartment buildings in Chennai and Tamil Nadu. Every chat request becomes a small list of typed edit operations on one parametric building model, and every drawing, schedule and check is regenerated from that model.

This repository holds the engine (the model, edit operations, validation, the Tamil Nadu rule pack and the drawing, schedule and cost output), the chat agent that drives it, an edit canvas where dragging a room goes through the same operations as asking for it, and a shareable offline plan viewer.

[docs/SPEC_COVERAGE.md](docs/SPEC_COVERAGE.md) maps each section of the product specification to the code that serves it, and says what is still open.

## Quick start

```sh
npm install
npm test          # unit tests
npm run demo      # builds a 30×40 ft east-facing house and writes plans to ./out
npm run reference # rebuilds the reference project: stilt + 3 on 62'6" × 52', one flat per floor
npm run studio    # the edit canvas at http://localhost:5173 — drag a room, or ask for the change
ANTHROPIC_API_KEY=... npm run chat   # chat with that house in the terminal; saved to ./designs
ANTHROPIC_API_KEY=... npm run chat -- demo-house-30x40-east   # reopen a saved design
```

`npm run reference` is the specification's success test: the whole building as one
script of typed operations, with every output written from it, including the DXF,
the XLSX schedules, the electrical and plumbing layouts, the joinery details and
the share preview image.

`npm run studio` serves the plan with a hit area over each room. Drag one, or
nudge it with the arrow buttons, and the move goes through the same ops, the same
checks and the same undo as a sentence in the chat box beside it; a move the rules
refuse comes back as the reason rather than as a moved room. Set
`ANTHROPIC_API_KEY` to turn that chat box on.

`npm run demo` prints each edit as a transaction (committed, blocked or rejected) with its findings, then writes:

- `out/viewer.html`: one self-contained file for sharing (for example over WhatsApp). It opens offline on a phone, with tabs for the site plan and each floor, drag and pinch to pan and zoom, +/−/Fit buttons, the room, door/window and furniture schedules, the cost estimate by trade, the open checks, and a button to download the PDF.
- `out/3d.html`: an offline 3D view (three.js inlined, about 0.7 MB) with buttons to zoom, turn, jump to each side or the top, and cut away upper floors.
- `out/plans.pdf`: the whole drawing set: site plan, floor plans, four elevations and a section at 1:100 on A4 or A3, then the schedules and the bill of quantities.
- `out/model.glb`: the 3D model as binary glTF for Blender, SketchUp or any web viewer.
- `out/*.csv`: door and window, flooring and furniture schedules and the cost estimate, for Excel or Google Sheets.
- `out/compare.csv`: the demo's "option B" branch compared with the main design.
- `out/designs/demo-house.json`: the saved design, with both branches and every revision.
- `out/plan-<level>.svg` and `out/model.json`.

`npm run chat` rewrites the same files after every change and saves the design. In the chat, `/revs` lists revisions, `/tag <label>` names the current one ("Sent to engineer"), `/branch <name> [from]` tries an option on its own branch, `/switch <name>` moves between branches, `/compare <ref> [ref]` compares two designs (a ref is a branch, `branch@C`, `@C` or a tag) and writes `out/compare.csv`, `/revert <rev>` brings back an earlier revision, and `/designs` lists saved designs.

## How it fits together

| Path | What it is |
| --- | --- |
| `src/model/schema.ts` | The Building Model (zod schemas): project, plot and roads, levels, rooms, openings. Millimetres, origin at the plot's south-west corner. |
| `src/model/walls.ts` | Walls derived from room boundaries: shared stretches become 115 mm internal walls, the rest 230 mm external walls. |
| `src/ops/definitions.ts` | The op vocabulary, with JSON Schema tool definitions for the LLM (`opToolDefinitions()`). |
| `src/ops/apply.ts` | What each op does, including ripple strategies (`fail`, `shrink_neighbour`, `push_neighbours`). |
| `src/engine.ts` | Transactions (`dryRun`), validation, and `ModelStore` with version history and undo. |
| `src/model/validate.ts` | Core invariants: overlaps, plot bounds, openings fitting their walls, windows and doors per room. |
| `src/model/structure.ts` | Trees, columns, the structural grid and stairs: geometry (stair flights and landings, auto-placed column frames) and checks (tree root and canopy zones, floating columns, beam spans, walls with no support below, stair fit and continuity). Advisory sanity checks for the engineer, not structural design. |
| `src/rules/` | Rule packs. `packs/tncdbr-2019.tables.ts` holds the TNCDBR 2019 numbers as data, `packs/tncdbr-2019.ts` the checks. |
| `src/agent/` | The chat agent: Claude turns each message into typed ops through tools (`apply_edits`, `query_model`, `undo_last_request`); the engine checks them; each message becomes one revision, and the reply ends with a computed change summary (`Rev C: Living now 13'3" × 15'3" (was …) · all checks pass`). |
| `src/output/floorplan.ts` | Floor plan sheet at 1:100: hatched walls, door swings, window symbols, D/W/V marks, room tags in ft-in and sq ft, dimension chains, setback lines, north arrow, scale bar, revision label and an advisory stamp. |
| `src/catalogue/catalogue.ts` | Starter catalogue in generic Indian sizes: beds, wardrobes, sofas (chaise left/right), dining 4/6/8, oonjal, pooja unit, WCs, basins, appliances, cars and scooters, doors and windows. Each entry has a footprint, the clear space it needs, services and a price band, and a versioned id (`bed.queen@1`) so saved designs never change under you. |
| `src/model/furnishing.ts` | Placed items: automatic placement clear of walls, door swings, doorways, stairs and other furniture; checks for overlaps, clearances, blocked door swings and doorways, doors that swing into each other, and narrow passages. |
| `src/model/wetstack.ts` | Wet stacking: toilets, kitchens and utilities over wet rooms below, never a toilet over a bedroom, kitchen, pooja or dining room, and an outside wall for pipes. |
| `src/rules/vastu.ts` | Opt-in Vastu (`SetPreferences { vastu: "prefer" | "strict" }`): entrance, kitchen, master bedroom, pooja, toilets and stair scored by true-north zone, and the open centre. Advisory only, never blocking; the site plan shows the nine zones when it is on. |
| `src/output/siteplan.ts` | Site plan at 1:100: trees with canopy and root zones, ground footprint, upper-floor outlines, stairs, column grid and an area statement. |
| `src/output/elevation.ts` | Four elevations named by the true direction each side faces, in the project's colour theme, and a section cut through the stair. |
| `src/output/schedules.ts` | Door and window schedule (count per floor), flooring schedule (tile, wastage, tile count, skirting) and furniture schedule, as tables, CSV and printable sheets. |
| `src/cost/` | Cost estimate. `rates.ts` is the Chennai rate table (material and labour per unit, with the labour share); `boq.ts` takes quantities off the model (excavation, footings, columns, beams, lintels, slabs, stairs, steel by kg/m³, brickwork net of openings, plaster, paint, waterproofing, floor and wall tiles, skirting, doors, windows, railings, electrical points, plumbing sets), prices them with a 10% margin and 3% contingency, and reports cost per sq ft. Each line lists the element ids it was measured from. `costDelta` gives the change per edit, which ends every change summary (`cost +₹1.2 lakh to ₹29.6 lakh`), and `SetRate` overrides a rate for the project. Furniture is totalled separately. |
| `src/store/` | Saved designs. `design.ts` holds a design's branches, each with its own revision history and tags; a branch starts from any revision of another and carries on its revision letters. On disk each branch is its first snapshot plus each revision's change set, replayed on load. `repository.ts` keeps one JSON file per design, written atomically. `compare.ts` compares two designs: areas, FSI, coverage, room counts, cost, open issues and Vastu, then room by room (added, removed, resized, moved, refinished). |
| `src/output/model3d.ts`, `src/output/viewer3d.ts` | 3D massing (walls cut around openings, glazing, sunshades, slabs, parapets, stair steps, furniture blocks, trees), a glTF writer and the offline 3D viewer. |
| `src/output/drawingset.ts` | The drawing set in sheet order, for the PDF and the viewer tabs. |
| `src/output/sheet.ts`, `src/output/pdf.ts` | A sheet is a display list, so one drawing renders to SVG and to a dependency-free vector PDF. |
| `src/output/viewer.ts` | The shareable single-file HTML viewer. |
| `src/model/core.ts` | Vertical cores: stair, lift, shaft and duct, spanning levels. Lift shafts are sized against IS 14665, and every core is checked for continuity through each level it passes. |
| `src/model/flats.ts` | Flats: rooms carry a flat id, and the area statement gives carpet, built-up and saleable area per flat and for the common area, with the cost split per flat. |
| `src/model/mep.ts` | MEP points: lights, switches, sockets, AC points, water inlets, drains and floor traps, placed automatically per room type or one by one. Circuits follow IS 732 (ten lighting points to a circuit), stacks follow NBC 2016 Part 9, and the checks catch a switch behind a door, a socket in the wet zone, an overloaded circuit, a drain with no stack and a design with no distribution board. |
| `src/model/parking.ts` | Car bays: whether each car fits, whether it can be driven in from the gate straight or round one corner clear of columns, trees and the other cars, and whether there are as many bays as dwellings. |
| `src/model/themes.ts` | Interior themes (classic white, warm contemporary, Chettinad earth): floor, wall and ceiling finishes per room type, applied with `ApplyTheme`. |
| `src/core/deps.ts` | The dependency graph. Each output records what it reads; a change set says which outputs are dirty, and `OutputCache` regenerates only those. A rename redraws 8 of 32 outputs, a resize 20. |
| `src/output/dxf.ts`, `src/output/xlsx.ts`, `src/output/raster.ts` | DXF for the draughtsman (layered, with ACI colours), XLSX for the schedules and the BOQ, and PNG for the share preview — all written without a dependency. |
| `src/output/details.ts` | Joinery elevations at 1:25: kitchen counters and wall units, wardrobes, the TV unit and the utility cupboard, with their dado and loft heights. |
| `src/output/overlay.ts` | Compare as a drawing: added rooms green, removed red, moved or resized amber over a dashed outline of the old position. |
| `src/store/collaboration.ts` | Roles (owner, collaborator, reviewer), comments pinned to an element, and sign-off: a registered professional's name, licence and revision replace the advisory stamp with their declaration, and freeze that revision. |
| `src/studio/` | The edit canvas: an HTTP server that serves the plan, takes drags and nudges as ops, and shares one history with the chat box; plus a read-only share link with a preview image. |
| `src/templates/reference-project.ts` | The reference project as one script of typed ops: stilt + 3 on 62'6" × 52' with the road to the north. |

### Edit operations

`SetPlot`, `SetRoad`, `AddLevel`, `RemoveLevel`, `SetLevelHeight`, `AddRoom`, `RemoveRoom`, `ResizeRoom` (by distance or to a target area), `MoveRoom`, `RenameRoom`, `SetRoomType`, `AddOpening`, `MoveOpening`, `ResizeOpening`, `RemoveOpening`, `AddTree`, `UpdateTree`, `RemoveTree`, `AddColumn`, `MoveColumn`, `RemoveColumn`, `PlaceColumns` (a column at every wall corner and junction, splitting runs longer than the span limit), `AddStair` (sized to fit when no well size is given), `UpdateStair`, `RemoveStair`, `PlaceItem` (finds a spot when no wall is given), `MoveItem`, `SwapItem`, `RemoveItem`, `SetPreferences` (Vastu, span limit, budget, family size, colour theme; a budget turns on an over-budget warning), `SetFinish` (floor, wall or ceiling finish per room), `SetRate` (a project's own rate for a BOQ line, e.g. a contractor's quote), `AddCore`, `UpdateCore`, `RemoveCore` (stair, lift, shaft, duct), `AssignFlat`, `SetSetback` (an owner's own setback beside the rule's), `SetCompoundWall`, `MergeRooms`, `SplitRoom`, `AlignElements`, `ApplyTheme`, `AddMepPoint`, `MoveMepPoint`, `RemoveMepPoint`, `AutoPlaceMep`, `SetRuleProfile`.

Every op shares one shape, `{ op, target?, args, reason? }`. A request is one transaction: all ops apply or none do. Each transaction returns a change set (what changed, used for "what did the AI change?") and undo replays it backwards.

### Chat agent

The model only ever sees a compact text summary of the design (rooms with ids, clear sizes, neighbours, openings, setbacks, open issues) and can only change it through `apply_edits`. Every `apply_edits` call is dry-run and checked; a change that introduces a blocking issue is not applied unless the user explicitly accepts it. All edits in one message are committed together, so "undo" always undoes exactly the last request. The system prompt makes the agent state its assumptions on direction, units, clear versus centreline and which side stayed fixed, and ask only when an ambiguity would change the geometry.

## Tamil Nadu rules (TNCDBR 2019)

The rule pack covers rule 35(1)(a), Non High Rise buildings of up to 16 dwellings: minimum road width, height and storeys, front, side and rear setbacks, FSI with rule 49 premium FSI, and plot coverage. Exclusions from rule 29 (open stilt parking, terrace stair rooms, a terrace WC up to 10 m²) are applied by level kind. Stairs are checked against rule 52(17) (width, tread, riser, risers per flight), and open stairs in setbacks against rule 28(a)(iii).

Values were transcribed from the extracted Gazette text, and each cell cites its rule and line. Cells marked `uncertain` need checking against the printed Gazette; the pack reports them as `info` findings when a design uses them. Amendments after 2019 are not included.

## Current limits

- Rooms are axis-aligned rectangles, and plots are rectangles.
- Walls are derived from room boundaries rather than drawn: there is no wall entity to add or remove, no finish per wall face and no separate plumbing-wall type.
- Room boundaries are wall centrelines; plans label the clear size inside the walls.
- Plinth height is not modelled, so building height is the sum of floor-to-floor heights.
- Columns are checked for alignment, spans and support only; member sizes, beams and foundations are for the structural engineer.
- Vertical circulation is checked for rise, tread, riser consistency, headroom and core continuity; fire and egress checks beyond that are not done.
- Rule numbers are data in a versioned pack, but the checks that read them are code, so a new authority needs a new pack module rather than only a new table.
- The catalogue is generic Indian sizes; brand and SKU catalogues are a partner phase.
- Designs are JSON files and the studio is a local server: there is no database, no accounts and no signed share links yet.
- The cost estimate is a planning figure (about ±15%) from assumed sections and allowances, not a tender BOQ; footing sizes, steel and point counts are rules of thumb until the engineer's drawings exist.
- Every output is advisory until a registered professional signs off the revision in the tool.
