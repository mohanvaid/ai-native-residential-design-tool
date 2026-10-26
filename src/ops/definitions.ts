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
};
