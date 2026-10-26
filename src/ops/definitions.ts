/**
 * The fixed op vocabulary. The chat compiler emits these as constrained tool
 * calls; every op is parsed against its schema before it touches the model.
 * All lengths are millimetres, areas m², road widths metres. Unit conversion
 * (ft-in → mm) happens in the compiler, before ops are emitted.
 */
import { z } from "zod";
import { OpeningType, RoomType, Side } from "../model/schema.js";

const mm = z.number().int();
const positiveMm = mm.positive();
const reason = z.string().optional();

/** How a geometry change treats rooms in its way. */
export const Strategy = z.enum(["fail", "push_neighbours", "shrink_neighbour"]);
export type Strategy = z.infer<typeof Strategy>;

export const SetPlot = z.object({
  op: z.literal("SetPlot"),
  args: z.object({
    widthMm: positiveMm.describe("Plot extent along plot X (west to east)."),
    depthMm: positiveMm.describe("Plot extent along plot Y (south to north)."),
    northAngle: z.number().optional().describe("Clockwise degrees from plot +Y to true north."),
  }),
  reason,
});

export const SetRoad = z.object({
  op: z.literal("SetRoad"),
  args: z.object({
    side: Side,
    widthM: z.number().positive().nullable().describe("Road width in metres; null removes the road on that side."),
    name: z.string().optional(),
  }),
  reason,
});

export const AddLevel = z.object({
  op: z.literal("AddLevel"),
  args: z.object({
    id: z.string().optional(),
    name: z.string(),
    kind: z.enum(["stilt", "floor", "terrace"]).optional(),
    floorToFloor: positiveMm.optional(),
    slabThickness: positiveMm.optional(),
  }),
  reason,
});

export const RemoveLevel = z.object({ op: z.literal("RemoveLevel"), target: z.string(), reason });

export const SetLevelHeight = z.object({
  op: z.literal("SetLevelHeight"),
  target: z.string(),
  args: z.object({ floorToFloor: positiveMm }),
  reason,
});

export const AddRoom = z.object({
  op: z.literal("AddRoom"),
  args: z.object({
    id: z.string().optional(),
    name: z.string(),
    type: RoomType,
    level: z.string(),
    x: mm.describe("West wall centreline, from the plot's west edge."),
    y: mm.describe("South wall centreline, from the plot's south edge."),
    width: positiveMm.describe("Centreline width, west to east."),
    depth: positiveMm.describe("Centreline depth, south to north."),
    minArea: z.number().positive().optional(),
    minWidth: positiveMm.optional(),
  }),
  reason,
});

export const RemoveRoom = z.object({ op: z.literal("RemoveRoom"), target: z.string(), reason });

export const ResizeRoom = z.object({
  op: z.literal("ResizeRoom"),
  target: z.string(),
  args: z
    .object({
      edge: Side,
      delta: mm.optional().describe("Outward movement of the edge; negative shrinks the room."),
      targetArea: z.number().positive().optional().describe("Desired centreline area in m², reached by moving only this edge."),
      strategy: Strategy.default("fail"),
    })
    .refine((a) => (a.delta === undefined) !== (a.targetArea === undefined), {
      message: "Give exactly one of delta or targetArea.",
    }),
  reason,
});

export const MoveRoom = z.object({
  op: z.literal("MoveRoom"),
  target: z.string(),
  args: z.object({ dx: mm.default(0), dy: mm.default(0) }),
  reason,
});

export const RenameRoom = z.object({
  op: z.literal("RenameRoom"),
  target: z.string(),
  args: z.object({ name: z.string().min(1) }),
  reason,
});

export const SetRoomType = z.object({
  op: z.literal("SetRoomType"),
  target: z.string(),
  args: z.object({ type: RoomType }),
  reason,
});

export const AddOpening = z.object({
  op: z.literal("AddOpening"),
  args: z.object({
    id: z.string().optional(),
    type: OpeningType,
    room: z.string(),
    side: Side,
    offset: mm.nonnegative().optional().describe("From the start of the side (west or south end); default centres it."),
    width: positiveMm.optional(),
    height: positiveMm.optional(),
    sill: mm.nonnegative().optional(),
    catalogue: z.string().optional(),
    swing: z.object({ hinge: z.enum(["start", "end"]), into: z.enum(["host", "other"]) }).optional(),
  }),
  reason,
});

export const MoveOpening = z.object({
  op: z.literal("MoveOpening"),
  target: z.string(),
  args: z
    .object({ offset: mm.nonnegative().optional(), delta: mm.optional() })
    .refine((a) => (a.offset === undefined) !== (a.delta === undefined), {
      message: "Give exactly one of offset or delta.",
    }),
  reason,
});

export const ResizeOpening = z.object({
  op: z.literal("ResizeOpening"),
  target: z.string(),
  args: z.object({
    width: positiveMm.optional(),
    height: positiveMm.optional(),
    sill: mm.nonnegative().optional(),
    anchor: z.enum(["start", "centre", "end"]).default("centre"),
  }),
  reason,
});

export const RemoveOpening = z.object({ op: z.literal("RemoveOpening"), target: z.string(), reason });

const levelRef = z.string().describe("Level id.");

export const AddTree = z.object({
  op: z.literal("AddTree"),
  args: z.object({
    id: z.string().optional(),
    species: z.string().describe("e.g. Mango, Neem, Coconut."),
    x: mm.describe("Trunk centre from the plot's west edge."),
    y: mm.describe("Trunk centre from the plot's south edge."),
    canopyRadius: positiveMm.optional().describe("Default depends on species."),
    rootRadius: positiveMm.optional().describe("Root protection radius; default depends on species."),
    keep: z.boolean().default(true),
  }),
  reason,
});

export const UpdateTree = z.object({
  op: z.literal("UpdateTree"),
  target: z.string(),
  args: z.object({
    x: mm.optional(),
    y: mm.optional(),
    canopyRadius: positiveMm.optional(),
    rootRadius: positiveMm.optional(),
    keep: z.boolean().optional().describe("false marks the tree for removal, which lifts its keep-out zone."),
  }),
  reason,
});

export const RemoveTree = z.object({ op: z.literal("RemoveTree"), target: z.string(), reason });

const columnSize = {
  width: positiveMm.optional().describe("Along plot X; default 230 (9 in)."),
  depth: positiveMm.optional().describe("Along plot Y; default 300 (12 in)."),
};

export const AddColumn = z.object({
  op: z.literal("AddColumn"),
  args: z.object({
    id: z.string().optional(),
    x: mm.describe("Column centre."),
    y: mm.describe("Column centre."),
    ...columnSize,
    fromLevel: levelRef,
    toLevel: levelRef.optional().describe("Top level it runs through; default the top floor."),
  }),
  reason,
});

export const MoveColumn = z.object({
  op: z.literal("MoveColumn"),
  target: z.string(),
  args: z.object({ dx: mm.default(0), dy: mm.default(0) }),
  reason,
});

export const RemoveColumn = z.object({ op: z.literal("RemoveColumn"), target: z.string(), reason });

export const PlaceColumns = z.object({
  op: z.literal("PlaceColumns"),
  args: z.object({
    fromLevel: levelRef.optional().describe("Default the lowest level."),
    toLevel: levelRef.optional().describe("Default the top level that has rooms."),
    maxSpan: positiveMm.optional().describe("Longest wall run between columns; default the project's limit (4500)."),
    ...columnSize,
  }),
  reason,
});

const StairShape = z.enum(["straight", "dog-leg"]);

export const AddStair = z.object({
  op: z.literal("AddStair"),
  args: z.object({
    id: z.string().optional(),
    fromLevel: levelRef,
    toLevel: levelRef.optional().describe("Default the level directly above."),
    x: mm.describe("South-west corner of the stair well."),
    y: mm.describe("South-west corner of the stair well."),
    up: Side.describe("Direction you face starting up the first flight."),
    shape: StairShape.default("dog-leg"),
    turn: z.enum(["left", "right"]).default("right"),
    flightWidth: positiveMm.default(900).describe("Used to size the well when width/depth are not given."),
    tread: positiveMm.default(250),
    risers: z.number().int().positive().optional().describe("Default: floor-to-floor height / 190 mm, rounded up."),
    width: positiveMm.optional().describe("Well size west to east; default sized to fit."),
    depth: positiveMm.optional().describe("Well size south to north; default sized to fit."),
    external: z.boolean().default(false).describe("An open stair outside the building."),
  }),
  reason,
});

export const UpdateStair = z.object({
  op: z.literal("UpdateStair"),
  target: z.string(),
  args: z.object({
    dx: mm.optional(),
    dy: mm.optional(),
    width: positiveMm.optional(),
    depth: positiveMm.optional(),
    up: Side.optional(),
    shape: StairShape.optional(),
    turn: z.enum(["left", "right"]).optional(),
    tread: positiveMm.optional(),
    risers: z.number().int().positive().optional(),
    external: z.boolean().optional(),
  }),
  reason,
});

export const RemoveStair = z.object({ op: z.literal("RemoveStair"), target: z.string(), reason });

const placement = {
  against: Side.optional().describe("Wall of the room to put the item's back against (a bed's headboard, a sofa's back)."),
  offset: mm.nonnegative().optional().describe("Along that wall, from its west or south end to the item's near edge."),
  align: z.enum(["start", "centre", "end"]).optional().describe("Along that wall, when no offset is given; default centre."),
  facing: Side.optional().describe("Direction the item's front faces (a bed's foot, a car's nose)."),
  x: mm.optional().describe("Explicit centre; give with y."),
  y: mm.optional(),
};

export const PlaceItem = z.object({
  op: z.literal("PlaceItem"),
  args: z.object({
    id: z.string().optional(),
    catalogue: z.string().describe("Catalogue id, e.g. bed.queen or sofa.3seat-chaise."),
    room: z.string(),
    mirror: z.boolean().optional().describe("For handed items: flip, e.g. chaise on the other side."),
    ...placement,
  }),
  reason,
});

export const MoveItem = z.object({
  op: z.literal("MoveItem"),
  target: z.string(),
  args: z.object({ dx: mm.optional(), dy: mm.optional(), room: z.string().optional().describe("Move it to another room."), ...placement }),
  reason,
});

export const SwapItem = z.object({
  op: z.literal("SwapItem"),
  target: z.string(),
  args: z.object({ catalogue: z.string().describe("The new catalogue id; it keeps the same wall and centre where it fits.") }),
  reason,
});

export const RemoveItem = z.object({ op: z.literal("RemoveItem"), target: z.string(), reason });

export const Op = z.discriminatedUnion("op", [
  SetPlot,
  SetRoad,
  AddLevel,
  RemoveLevel,
  SetLevelHeight,
  AddRoom,
  RemoveRoom,
  ResizeRoom,
  MoveRoom,
  RenameRoom,
  SetRoomType,
  AddOpening,
  MoveOpening,
  ResizeOpening,
  RemoveOpening,
  AddTree,
  UpdateTree,
  RemoveTree,
  AddColumn,
  MoveColumn,
  RemoveColumn,
  PlaceColumns,
  AddStair,
  UpdateStair,
  RemoveStair,
  PlaceItem,
  MoveItem,
  SwapItem,
  RemoveItem,
]);
export type Op = z.infer<typeof Op>;
/** An op as the compiler emits it, before defaults are filled in. */
export type OpInput = z.input<typeof Op>;
export type OpName = Op["op"];

export const OP_SCHEMAS = Op.options;

/** JSON Schema for each op, ready to expose to the LLM as tool definitions. */
export function opToolDefinitions(): { name: string; description: string; input_schema: unknown }[] {
  return OP_SCHEMAS.map((schema) => {
    const name = schema.shape.op.value;
    return { name, description: DESCRIPTIONS[name], input_schema: z.toJSONSchema(schema, { io: "input" }) };
  });
}

const DESCRIPTIONS: Record<OpName, string> = {
  SetPlot: "Set a rectangular plot size and its orientation.",
  SetRoad: "Add, change or remove the road abutting one side of the plot.",
  AddLevel: "Add a level on top of the current stack.",
  RemoveLevel: "Remove an empty level.",
  SetLevelHeight: "Change a level's floor-to-floor height.",
  AddRoom: "Add a rectangular room on a level.",
  RemoveRoom: "Remove a room and its openings.",
  ResizeRoom: "Move one edge of a room, by a distance or to reach a target area.",
  MoveRoom: "Move a room on its level; its openings move with it.",
  RenameRoom: "Rename a room.",
  SetRoomType: "Change a room's type.",
  AddOpening: "Add a door, window, ventilator or opening on one side of a room.",
  MoveOpening: "Slide an opening along its wall.",
  ResizeOpening: "Change an opening's width, height or sill.",
  RemoveOpening: "Remove an opening.",
  AddTree: "Record an existing tree on the site, to keep (with a keep-out zone) or to remove.",
  UpdateTree: "Move or resize a tree's zones, or mark it to keep or remove.",
  RemoveTree: "Delete a tree from the site record.",
  AddColumn: "Add one column through a range of levels.",
  MoveColumn: "Move a column on every level it runs through.",
  RemoveColumn: "Remove a column.",
  PlaceColumns: "Replace the columns in a level range with a frame at every wall corner and junction, splitting wall runs longer than maxSpan.",
  AddStair: "Add a stair from one level to the next, sized to fit unless a well size is given.",
  UpdateStair: "Move, resize, turn or reshape a stair.",
  RemoveStair: "Remove a stair.",
  PlaceItem: "Place furniture, sanitaryware, an appliance or a vehicle from the catalogue in a room. With no position it finds a spot clear of doors and other items.",
  MoveItem: "Move or turn a placed item: by dx/dy, to a wall, to a new centre, or into another room.",
  SwapItem: "Replace a placed item with another catalogue entry (e.g. queen bed to king) in the same place.",
  RemoveItem: "Remove a placed item.",
};
