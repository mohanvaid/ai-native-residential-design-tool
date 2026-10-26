# AI-Native Residential Design Tool

A conversational design tool for independent houses (up to G+2) in Chennai and Tamil Nadu. Every chat request becomes a small list of typed edit operations on one parametric building model, and every drawing, schedule and check is regenerated from that model.

This repository holds the engine (the model, edit operations, validation, the Tamil Nadu rule pack and floor-plan output) the chat agent that drives it, and a shareable offline plan viewer. There is no editing web UI yet.

## Quick start

```sh
npm install
npm test          # unit tests
npm run demo      # builds a 30×40 ft east-facing house and writes plans to ./out
ANTHROPIC_API_KEY=... npm run chat   # chat with that house in the terminal
```

`npm run demo` prints each edit as a transaction (committed, blocked or rejected) with its findings, then writes:

- `out/viewer.html`: one self-contained file for sharing (for example over WhatsApp). It opens offline on a phone, with tabs for the site plan and each floor, drag and pinch to pan and zoom, +/−/Fit buttons, the room, door/window and furniture schedules, the open checks, and a button to download the PDF.
- `out/3d.html`: an offline 3D view (three.js inlined, about 0.7 MB) with buttons to zoom, turn, jump to each side or the top, and cut away upper floors.
- `out/plans.pdf`: the whole drawing set: site plan, floor plans, four elevations and a section at 1:100 on A4 or A3, then the schedules.
- `out/model.glb`: the 3D model as binary glTF for Blender, SketchUp or any web viewer.
- `out/*.csv`: door and window, flooring and furniture schedules for Excel or Google Sheets.
- `out/plan-<level>.svg` and `out/model.json`.

`npm run chat` rewrites the same files after every change.

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
| `src/output/model3d.ts`, `src/output/viewer3d.ts` | 3D massing (walls cut around openings, glazing, sunshades, slabs, parapets, stair steps, furniture blocks, trees), a glTF writer and the offline 3D viewer. |
| `src/output/drawingset.ts` | The drawing set in sheet order, for the PDF and the viewer tabs. |
| `src/output/sheet.ts`, `src/output/pdf.ts` | A sheet is a display list, so one drawing renders to SVG and to a dependency-free vector PDF. |
| `src/output/viewer.ts` | The shareable single-file HTML viewer. |

### Edit operations

`SetPlot`, `SetRoad`, `AddLevel`, `RemoveLevel`, `SetLevelHeight`, `AddRoom`, `RemoveRoom`, `ResizeRoom` (by distance or to a target area), `MoveRoom`, `RenameRoom`, `SetRoomType`, `AddOpening`, `MoveOpening`, `ResizeOpening`, `RemoveOpening`, `AddTree`, `UpdateTree`, `RemoveTree`, `AddColumn`, `MoveColumn`, `RemoveColumn`, `PlaceColumns` (a column at every wall corner and junction, splitting runs longer than the span limit), `AddStair` (sized to fit when no well size is given), `UpdateStair`, `RemoveStair`, `PlaceItem` (finds a spot when no wall is given), `MoveItem`, `SwapItem`, `RemoveItem`, `SetPreferences` (Vastu, span limit, budget, family size, colour theme), `SetFinish` (floor tiles per room).

Every op shares one shape, `{ op, target?, args, reason? }`. A request is one transaction: all ops apply or none do. Each transaction returns a change set (what changed, used for "what did the AI change?") and undo replays it backwards.

### Chat agent

The model only ever sees a compact text summary of the design (rooms with ids, clear sizes, neighbours, openings, setbacks, open issues) and can only change it through `apply_edits`. Every `apply_edits` call is dry-run and checked; a change that introduces a blocking issue is not applied unless the user explicitly accepts it. All edits in one message are committed together, so "undo" always undoes exactly the last request. The system prompt makes the agent state its assumptions on direction, units, clear versus centreline and which side stayed fixed, and ask only when an ambiguity would change the geometry.

## Tamil Nadu rules (TNCDBR 2019)

The rule pack covers rule 35(1)(a), Non High Rise buildings of up to 16 dwellings: minimum road width, height and storeys, front, side and rear setbacks, FSI with rule 49 premium FSI, and plot coverage. Exclusions from rule 29 (open stilt parking, terrace stair rooms, a terrace WC up to 10 m²) are applied by level kind. Stairs are checked against rule 52(17) (width, tread, riser, risers per flight), and open stairs in setbacks against rule 28(a)(iii).

Values were transcribed from the extracted Gazette text, and each cell cites its rule and line. Cells marked `uncertain` need checking against the printed Gazette; the pack reports them as `info` findings when a design uses them. Amendments after 2019 are not included.

## Current limits

- Rooms are axis-aligned rectangles, and plots are rectangles.
- Room boundaries are wall centrelines; plans label the clear size inside the walls.
- Plinth height is not modelled, so building height is the sum of floor-to-floor heights.
- Columns are checked for alignment, spans and support only; member sizes, beams and foundations are for the structural engineer.
- Stair headroom is not checked yet, and lifts and shafts are not modelled.
- Elevations show external walls and openings; balconies, railings, staircase towers and roof details are not modelled yet.
- MEP and costing are later slices.
