# AI-Native Residential Design Tool

A conversational design tool for independent houses (up to G+2) in Chennai and Tamil Nadu. Every chat request becomes a small list of typed edit operations on one parametric building model, and every drawing, schedule and check is regenerated from that model.

This repository holds the engine (the model, edit operations, validation, the Tamil Nadu rule pack and floor-plan output) and the chat agent that drives it. There is no web UI yet.

## Quick start

```sh
npm install
npm test          # unit tests
npm run demo      # builds a 30×40 ft east-facing house and writes plans to ./out
ANTHROPIC_API_KEY=... npm run chat   # chat with that house in the terminal
```

`npm run demo` prints each edit as a transaction (committed, blocked or rejected) with its findings, then writes `out/plan-lv_gf.svg`, `out/plan-lv_ff.svg` and `out/model.json`.

## How it fits together

| Path | What it is |
| --- | --- |
| `src/model/schema.ts` | The Building Model (zod schemas): project, plot and roads, levels, rooms, openings. Millimetres, origin at the plot's south-west corner. |
| `src/model/walls.ts` | Walls derived from room boundaries: shared stretches become 115 mm internal walls, the rest 230 mm external walls. |
| `src/ops/definitions.ts` | The op vocabulary, with JSON Schema tool definitions for the LLM (`opToolDefinitions()`). |
| `src/ops/apply.ts` | What each op does, including ripple strategies (`fail`, `shrink_neighbour`, `push_neighbours`). |
| `src/engine.ts` | Transactions (`dryRun`), validation, and `ModelStore` with version history and undo. |
| `src/model/validate.ts` | Core invariants: overlaps, plot bounds, openings fitting their walls, windows and doors per room. |
| `src/rules/` | Rule packs. `packs/tncdbr-2019.tables.ts` holds the TNCDBR 2019 numbers as data, `packs/tncdbr-2019.ts` the checks. |
| `src/agent/` | The chat agent: Claude turns each message into typed ops through tools (`apply_edits`, `query_model`, `undo_last_request`); the engine checks them; each message becomes one revision, and the reply ends with a computed change summary (`Rev C: Living now 13'3" × 15'3" (was …) · all checks pass`). |
| `src/output/floorplan.ts` | Floor plan SVG at 1:100: hatched walls, door swings, window symbols, D/W/V marks, room tags in ft-in and sq ft, dimension chains, setback lines, north arrow. |

### Edit operations

`SetPlot`, `SetRoad`, `AddLevel`, `RemoveLevel`, `SetLevelHeight`, `AddRoom`, `RemoveRoom`, `ResizeRoom` (by distance or to a target area), `MoveRoom`, `RenameRoom`, `SetRoomType`, `AddOpening`, `MoveOpening`, `ResizeOpening`, `RemoveOpening`.

Every op shares one shape, `{ op, target?, args, reason? }`. A request is one transaction: all ops apply or none do. Each transaction returns a change set (what changed, used for "what did the AI change?") and undo replays it backwards.

### Chat agent

The model only ever sees a compact text summary of the design (rooms with ids, clear sizes, neighbours, openings, setbacks, open issues) and can only change it through `apply_edits`. Every `apply_edits` call is dry-run and checked; a change that introduces a blocking issue is not applied unless the user explicitly accepts it. All edits in one message are committed together, so "undo" always undoes exactly the last request. The system prompt makes the agent state its assumptions on direction, units, clear versus centreline and which side stayed fixed, and ask only when an ambiguity would change the geometry.

## Tamil Nadu rules (TNCDBR 2019)

The rule pack covers rule 35(1)(a), Non High Rise buildings of up to 16 dwellings: minimum road width, height and storeys, front, side and rear setbacks, FSI with rule 49 premium FSI, and plot coverage. Exclusions from rule 29 (open stilt parking, terrace stair rooms, a terrace WC up to 10 m²) are applied by level kind.

Values were transcribed from the extracted Gazette text, and each cell cites its rule and line. Cells marked `uncertain` need checking against the printed Gazette; the pack reports them as `info` findings when a design uses them. Amendments after 2019 are not included.

## Current limits

- Rooms are axis-aligned rectangles, and plots are rectangles.
- Room boundaries are wall centrelines; plans label the clear size inside the walls.
- Plinth height is not modelled, so building height is the sum of floor-to-floor heights.
- Structural members, stairs, MEP, sections, 3D, schedules and costing are later slices.
