/**
 * The specification's reference project, used as its success test: a stilt +
 * 3 floors building on a 62'6" (east-west) × 52' (south-north) plot with the
 * road on the north. The owner keeps a 12 ft access passage along the north
 * side and 5 ft elsewhere; an existing mango (north-west corner) and neem (west
 * side) are kept. Each upper floor is one 3-bedroom flat (the client's plan,
 * 50 × 32 ft), sharing a stair, lobby and 4-person lift with the floors above
 * and below. The stilt is open parking.
 *
 * Plan coordinates below are in feet from the south-west corner of the
 * building footprint, whose outer wall face sits just over 1.5 m (5 ft) in
 * from the plot's west and south edges.
 */
import { newProject, type Project } from "../model/schema.js";
import { ftIn } from "../model/units.js";
import type { OpInput } from "../ops/definitions.js";

export const REF_PLOT = { width: ftIn(62, 6), depth: ftIn(52) };
/** Wall centreline of the footprint's south-west corner: 5'6" in, so the outer face clears the 1.5 m rule setback. */
const OX = ftIn(5, 6);
const OY = ftIn(5, 6);
const ft = (v: number) => Math.round(v * 304.8);

export const REF_FLOORS = [
  { id: "lv_l1", name: "First", flat: "F1" },
  { id: "lv_l2", name: "Second", flat: "F2" },
  { id: "lv_l3", name: "Third", flat: "F3" },
] as const;

/** The plot with its ground level turned into an open stilt floor. */
export function referencePlot(): Project {
  const p = newProject({ id: "reference", name: "Stilt + 3, 62'6\" × 52' North", plotWidthMm: REF_PLOT.width, plotDepthMm: REF_PLOT.depth });
  p.levels[0] = { ...p.levels[0]!, name: "Stilt", kind: "stilt", floorToFloor: 2700 };
  return p;
}

export const REF_SITE: OpInput[] = [
  { op: "SetRoad", args: { side: "north", widthM: 9.14, name: "30 ft road" } },
  { op: "SetSetback", args: { side: "north", distanceMm: ftIn(12), purpose: "access", note: "access passage" } },
  { op: "SetCompoundWall", args: { sides: ["north", "east", "south", "west"], heightMm: 1800 } },
  { op: "AddTree", args: { id: "tr_mango", species: "Mango", x: 900, y: REF_PLOT.depth - 1200, keep: true } },
  { op: "AddTree", args: { id: "tr_neem", species: "Neem", x: 600, y: ftIn(26), rootRadius: 900, keep: true } },
];

type R = [x0: number, y0: number, x1: number, y1: number];
const room = (id: string, name: string, type: string, level: string, [x0, y0, x1, y1]: R, extra: Record<string, unknown> = {}): OpInput =>
  ({ op: "AddRoom", args: { id, name, type, level, x: OX + ft(x0), y: OY + ft(y0), width: ft(x1) - ft(x0), depth: ft(y1) - ft(y0), ...extra } }) as OpInput;
const door = (roomId: string, side: string, offsetFt: number, width = 900, swing?: { hinge: "start" | "end"; into: "host" | "other" }): OpInput =>
  ({ op: "AddOpening", args: { type: "door", room: roomId, side, offset: ft(offsetFt), width, ...(swing ? { swing } : {}) } }) as OpInput;
const opening = (roomId: string, side: string, offsetFt: number, width: number): OpInput => ({ op: "AddOpening", args: { type: "opening", room: roomId, side, offset: ft(offsetFt), width } }) as OpInput;
/** Doors out of the lobby swing away from the lift landing. */
const AWAY = { hinge: "start", into: "other" } as const;
const win = (roomId: string, side: string, width = 1200, type: "window" | "ventilator" = "window"): OpInput => ({ op: "AddOpening", args: { type, room: roomId, side, width } }) as OpInput;

/** Stair, lobby and the common rooms on every level. */
const STAIR: R = [10, 0, 23, 7];
const LOBBY: R = [23, 0, 29.5, 7];
const LIFT: R = [29.5, 0, 35, 7];
/** Stair well inside the stair room's walls and the columns at its corners. */
const WELL_INSET = 150;

function common(level: string, s: string): OpInput[] {
  return [
    room(`rm_stair_${s}`, "Staircase", "staircase", level, STAIR),
    room(`rm_lobby_${s}`, "Lobby", "lobby", level, LOBBY),
    opening(`rm_stair_${s}`, "east", 0.5, 1000),
  ];
}

/** One floor of the client's plan: a single 3-bedroom flat. */
export function typicalFloor(level: string, s: string): OpInput[] {
  const id = (k: string) => `rm_${k}_${s}`;
  return [
    ...common(level, s),
    room(id("liv"), "Living & dining", "living", level, [10, 7, 40, 19]),
    room(id("utlw"), "Utility (west)", "utility", level, [0, 0, 10, 4]),
    room(id("kitw"), "Kitchen (west)", "kitchen", level, [0, 4, 10, 14]),
    room(id("puja1"), "Puja room 1", "puja", level, [0, 14, 5, 19]),
    room(id("pasw"), "Passage", "passage", level, [5, 14, 10, 19]),
    room(id("bed2"), "Bedroom 2", "bedroom", level, [0, 19, 10, 32]),
    room(id("pwd"), "Powder room", "toilet", level, [10, 19, 15, 24]),
    room(id("tltw"), "Toilet (Bedroom 2)", "toilet", level, [10, 24, 15, 32]),
    room(id("mbr"), "Master bedroom", "bedroom", level, [15, 19, 35, 32]),
    room(id("pase"), "Passage", "passage", level, [35, 19, 40, 24]),
    room(id("tltne"), "Toilet (Bedroom 3)", "toilet", level, [35, 24, 40, 32]),
    room(id("bed3"), "Bedroom 3", "bedroom", level, [40, 19, 50, 32]),
    room(id("pase2"), "Passage", "passage", level, [40, 14, 42, 19]),
    room(id("tlte"), "Toilet (east)", "toilet", level, [42, 14, 50, 19]),
    room(id("kite"), "Kitchen (east)", "kitchen", level, [40, 4, 50, 14]),
    room(id("utle"), "Utility (east)", "utility", level, [40, 0, 50, 4]),
    room(id("puja2"), "Puja room 2", "puja", level, [35, 0, 40, 5]),
    room(id("foyer"), "Puja foyer", "passage", level, [35, 5, 40, 7]),

    // Entry from the lobby, and the doors the client asked for
    door(id("lobby"), "north", 0.6, 1000, AWAY),
    door(id("utlw"), "north", 3),
    win(id("utlw"), "west", 600),
    door(id("kitw"), "east", 5),
    win(id("kitw"), "west", 1500),
    door(id("puja1"), "east", 1, 750),
    win(id("puja1"), "west", 600),
    opening(id("pasw"), "east", 0.5, 1200),
    door(id("bed2"), "south", 6),
    win(id("bed2"), "west", 1500),
    win(id("bed2"), "north", 1500),
    door(id("tltw"), "west", 1, 750),
    win(id("tltw"), "north", 600, "ventilator"),
    door(id("pwd"), "south", 1, 750),
    door(id("mbr"), "south", 0.6),
    door(id("mbr"), "east", 1.5),
    win(id("mbr"), "north", 1800),
    opening(id("pase"), "south", 0.5, 1200),
    door(id("tltne"), "east", 3, 750),
    win(id("tltne"), "north", 600, "ventilator"),
    door(id("bed3"), "west", 0.6),
    win(id("bed3"), "east", 1500),
    win(id("bed3"), "north", 1500),
    opening(id("pase2"), "west", 0.5, 1200),
    door(id("tlte"), "west", 1, 750),
    win(id("tlte"), "east", 600, "ventilator"),
    door(id("kite"), "west", 5),
    win(id("kite"), "east", 1500),
    door(id("utle"), "north", 3),
    win(id("utle"), "east", 600),
    opening(id("foyer"), "north", 0.5, 1200),
    door(id("puja2"), "north", 1, 750),
    win(id("puja2"), "south", 600),
  ];
}

export const REF_BUILDING: OpInput[] = [
  { op: "AddLevel", args: { id: "lv_l1", name: "First", floorToFloor: 3000 } },
  { op: "AddLevel", args: { id: "lv_l2", name: "Second", floorToFloor: 3000 } },
  { op: "AddLevel", args: { id: "lv_l3", name: "Third", floorToFloor: 3000 } },
  { op: "AddLevel", args: { id: "lv_tr", name: "Terrace", kind: "terrace", floorToFloor: 3000 } },

  // Stilt: lobby, stair and open parking
  ...common("lv_gf", "s"),
  room("rm_park_s", "Parking", "parking", "lv_gf", [0, 7, 50, 32]),
  room("rm_park_w", "Parking (two-wheelers)", "parking", "lv_gf", [0, 0, 10, 7]),
  room("rm_park_e", "Parking (two-wheelers)", "parking", "lv_gf", [35, 0, 50, 7]),
  opening("rm_lobby_s", "north", 0.5, 1500),

  ...REF_FLOORS.flatMap((f, i) => typicalFloor(f.id, `${i + 1}`)),

  // Terrace: stair head room and lobby
  ...common("lv_tr", "t"),
  door("rm_lobby_t", "north", 0.6, 1000, AWAY),

  // One dog-leg stair per floor, clear of the walls and corner columns of the 13 × 7 ft stair room, and the lift beside the lobby
  ...["lv_gf", "lv_l1", "lv_l2", "lv_l3"].map(
    (from, i): OpInput => ({
      op: "AddStair",
      args: { id: `st_${i}`, fromLevel: from, x: OX + ft(STAIR[0]) + WELL_INSET, y: OY + ft(STAIR[1]) + WELL_INSET, width: ft(STAIR[2]) - ft(STAIR[0]) - 2 * WELL_INSET, depth: ft(STAIR[3]) - ft(STAIR[1]) - 2 * WELL_INSET, up: "west", shape: "dog-leg", turn: "right", tread: 250 },
    }),
  ),
  { op: "AddCore", args: { id: "lift_1", kind: "lift", name: "the lift", x: OX + ft(LIFT[0]), y: OY + ft(LIFT[1]), width: ft(LIFT[2] - LIFT[0]), depth: ft(LIFT[3] - LIFT[1]), fromLevel: "lv_gf", toLevel: "lv_l3", doorSide: "west", persons: 4 } },
];

/** Rooms of each typical floor assigned to its flat; stair and lobby stay common. */
export function referenceFlats(project: Project): OpInput[] {
  return REF_FLOORS.map((f) => ({
    op: "AssignFlat",
    args: { rooms: project.rooms.filter((r) => r.level === f.id && r.type !== "staircase" && r.type !== "lobby").map((r) => r.id), flat: f.flat },
  }));
}

/** Three cars nose-in from the north passage, in the bays between the stilt columns. */
export const REF_PARKING: OpInput[] = [
  { op: "PlaceItem", args: { id: "it_car1", catalogue: "car.sedan", room: "rm_park_s", x: OX + ft(19), y: OY + ft(23.6), facing: "north" } },
  { op: "PlaceItem", args: { id: "it_car2", catalogue: "car.suv-compact", room: "rm_park_s", x: OX + ft(30), y: OY + ft(23.6), facing: "north" } },
  { op: "PlaceItem", args: { id: "it_car3", catalogue: "car.sedan", room: "rm_park_s", x: OX + ft(46), y: OY + ft(23.6), facing: "north" } },
];

/** Columns at every wall corner and junction from the stilt up. */
export const REF_STRUCTURE: OpInput[] = [{ op: "PlaceColumns", args: { fromLevel: "lv_gf", toLevel: "lv_tr" } }];
