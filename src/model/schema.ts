/**
 * The Building Model: one versioned JSON document that holds design intent.
 *
 * Geometry is 2D per level, in millimetres, with the origin at the plot's
 * south-west corner. +Y points to "plot north"; true north is plot north
 * rotated clockwise by `plot.northAngle` degrees.
 *
 * Only authored intent is stored here. Walls, the buildable envelope and every
 * drawing are derived from it (see src/model/walls.ts and src/rules).
 */
import { z } from "zod";

export const Point = z.tuple([z.number(), z.number()]);
export type Point = z.infer<typeof Point>;

/** The four sides of a plot or of a rectangular room, in plot axes. */
export const Side = z.enum(["north", "south", "east", "west"]);
export type Side = z.infer<typeof Side>;

export const Meta = z.object({
  createdByOp: z.string().optional(),
  lastChangedVersion: z.number().int().nonnegative(),
  notes: z.string().optional(),
});
export type Meta = z.infer<typeof Meta>;

export const Road = z.object({
  side: Side,
  widthM: z.number().positive(),
  name: z.string().optional(),
});
export type Road = z.infer<typeof Road>;

export const Plot = z.object({
  /** Closed polygon, counter-clockwise, no repeated last point. v1 plots are rectangles. */
  boundary: z.array(Point).min(3),
  /** Clockwise angle in degrees from plot +Y to true north. */
  northAngle: z.number().default(0),
  abuttingRoads: z.array(Road).default([]),
  soilType: z.string().optional(),
  /** Finished ground level relative to the road crown, mm. */
  levelVsRoadMm: z.number().optional(),
  surveyNo: z.string().optional(),
  /**
   * Planning area class used by TN rule tables: ordinary areas, Continuous
   * Building Areas or Economically Weaker Section areas (TNCDBR 2019 rule 30).
   */
  areaClass: z.enum(["other", "CBA", "EWS"]).default("other"),
});
export type Plot = z.infer<typeof Plot>;

export const Level = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * stilt: open parking floor; floor: a livable storey; terrace: roof level
   * holding only the stair head room, tanks and the like.
   */
  kind: z.enum(["stilt", "floor", "terrace"]).default("floor"),
  /** Floor level above plinth/ground, mm. Kept in sync with the stack order. */
  elevation: z.number(),
  floorToFloor: z.number().positive().default(3000),
  slabThickness: z.number().positive().default(150),
  meta: Meta,
});
export type Level = z.infer<typeof Level>;

export const RoomType = z.enum([
  "living",
  "dining",
  "kitchen",
  "bedroom",
  "toilet",
  "puja",
  "study",
  "utility",
  "store",
  "staircase",
  "sit-out",
  "car-porch",
  "balcony",
  "passage",
  "other",
]);
export type RoomType = z.infer<typeof RoomType>;

/** Room types that need natural light and ventilation (habitable rooms). */
export const HABITABLE: ReadonlySet<RoomType> = new Set<RoomType>([
  "living",
  "dining",
  "kitchen",
  "bedroom",
  "study",
]);

export const Room = z.object({
  id: z.string(),
  name: z.string(),
  type: RoomType,
  level: z.string(),
  /**
   * Wall-centreline polygon, counter-clockwise from the south-west corner.
   * This slice supports axis-aligned rectangles only.
   */
  boundary: z.array(Point).min(3),
  targets: z
    .object({
      /** m² */
      minArea: z.number().positive().optional(),
      /** mm */
      minWidth: z.number().positive().optional(),
    })
    .default({}),
  finishes: z.record(z.string(), z.string()).default({}),
  /** Compass zone of the room centre relative to the plot, from true north (SW, NE, C, ...). */
  zoneTags: z.array(z.string()).default([]),
  meta: Meta,
});
export type Room = z.infer<typeof Room>;

export const OpeningType = z.enum(["door", "window", "ventilator", "opening"]);
export type OpeningType = z.infer<typeof OpeningType>;

export const Opening = z.object({
  id: z.string(),
  type: OpeningType,
  /**
   * Openings are hosted on a side of a room rather than on a wall id, because
   * walls are regenerated from rooms on every edit. The derived wall that
   * contains the opening is resolved at derivation time.
   */
  host: z.object({ room: z.string(), side: Side }),
  /**
   * Distance in mm from the start of the host side to the near jamb. A side
   * starts at its west end (north/south sides) or its south end (east/west sides).
   */
  offset: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
  sill: z.number().nonnegative(),
  catalogue: z.string().optional(),
  /** Doors only: hinge side seen from inside the host room, and swing direction. */
  swing: z
    .object({ hinge: z.enum(["start", "end"]), into: z.enum(["host", "other"]) })
    .optional(),
  meta: Meta,
});
export type Opening = z.infer<typeof Opening>;

/** An existing tree to keep or remove. Its root zone keeps the footprint, parking and sumps away. */
export const Tree = z.object({
  id: z.string(),
  species: z.string(),
  /** Trunk centre, mm from the plot's south-west corner. */
  at: Point,
  /** Canopy radius, mm: upper floors and balconies should stay clear of it. */
  canopyRadius: z.number().positive(),
  /** Root protection radius, mm: no foundation, column or stair inside it. */
  rootRadius: z.number().positive(),
  keep: z.boolean().default(true),
  meta: Meta,
});
export type Tree = z.infer<typeof Tree>;

/**
 * A column, rectangular in plan, running through a contiguous range of
 * levels (inclusive). The structural grid is derived from column positions.
 */
export const Column = z.object({
  id: z.string(),
  /** Centre, mm. */
  at: Point,
  /** Size along plot X and plot Y, mm (e.g. 230 × 300 for 9" × 12"). */
  width: z.number().positive(),
  depth: z.number().positive(),
  fromLevel: z.string(),
  toLevel: z.string(),
  meta: Meta,
});
export type Column = z.infer<typeof Column>;

/**
 * A stair from one level to the level directly above, within a rectangular
 * well. `up` is the direction a person faces when starting up the first
 * flight. A dog-leg stair turns at a half landing at the far end of the well
 * and comes back alongside the first flight; its flights are half the well
 * wide. A straight stair fills the well, with a mid landing past 15 risers.
 */
export const Stair = z.object({
  id: z.string(),
  fromLevel: z.string(),
  toLevel: z.string(),
  /** Stair well outline (clear of any walls), counter-clockwise rectangle. */
  boundary: z.array(Point).min(3),
  shape: z.enum(["straight", "dog-leg"]),
  up: Side,
  /** For a dog-leg: which side of the well the first flight runs along, seen walking up. */
  turn: z.enum(["left", "right"]).default("right"),
  /** Number of risers; derived from the floor-to-floor height when absent. */
  risers: z.number().int().positive().optional(),
  tread: z.number().positive().default(250),
  /** An open stair outside the building, which some rules allow in setbacks. */
  external: z.boolean().default(false),
  meta: Meta,
});
export type Stair = z.infer<typeof Stair>;

export const Jurisdiction = z.enum(["IN-TN-CMDA", "IN-TN-DTCP", "NONE"]);
export type Jurisdiction = z.infer<typeof Jurisdiction>;

export const Project = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(),
  /** Increments on every committed transaction. */
  version: z.number().int().nonnegative(),
  /** Counter for generated element ids. */
  seq: z.number().int().nonnegative(),
  units: z.object({ display: z.enum(["imperial", "metric"]).default("imperial") }).default({ display: "imperial" }),
  jurisdiction: Jurisdiction,
  /** Rule pack ids to run; empty means "pick from jurisdiction". */
  ruleSets: z.array(z.string()).default([]),
  prefs: z
    .object({
      vastu: z.enum(["off", "prefer", "strict"]).default("off"),
      budgetInr: z.number().positive().optional(),
      familySize: z.number().int().positive().optional(),
      /** Beam spans longer than this, in mm, are flagged for the engineer. */
      maxSpanMm: z.number().positive().default(4500),
    })
    .default({ vastu: "off", maxSpanMm: 4500 }),
  plot: Plot,
  levels: z.array(Level),
  rooms: z.array(Room),
  openings: z.array(Opening),
  trees: z.array(Tree).default([]),
  columns: z.array(Column).default([]),
  stairs: z.array(Stair).default([]),
});
export type Project = z.infer<typeof Project>;

/** Validation and rule-pack output. */
export interface Finding {
  severity: "block" | "warn" | "info";
  /** Stable machine code, e.g. "room.overlap" or "tn.setback.front". */
  code: string;
  message: string;
  elements: string[];
  source: string;
}

export function newProject(init: {
  id: string;
  name: string;
  plotWidthMm: number;
  plotDepthMm: number;
  jurisdiction?: Jurisdiction;
  northAngle?: number;
}): Project {
  const { plotWidthMm: w, plotDepthMm: d } = init;
  return Project.parse({
    schemaVersion: 1,
    id: init.id,
    name: init.name,
    version: 0,
    seq: 0,
    jurisdiction: init.jurisdiction ?? "IN-TN-CMDA",
    plot: {
      boundary: [
        [0, 0],
        [w, 0],
        [w, d],
        [0, d],
      ],
      northAngle: init.northAngle ?? 0,
    },
    levels: [
      {
        id: "lv_gf",
        name: "Ground",
        elevation: 0,
        floorToFloor: 3000,
        slabThickness: 150,
        meta: { lastChangedVersion: 0 },
      },
    ],
    rooms: [],
    openings: [],
  });
}
