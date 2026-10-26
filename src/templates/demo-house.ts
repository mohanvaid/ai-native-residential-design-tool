/**
 * Starter template: a 1BHK ground floor on a 30 × 40 ft east-facing plot with
 * a 30 ft road. Used by the demo, the chat CLI and tests.
 */
import { newProject, type Project } from "../model/schema.js";
import { ftIn } from "../model/units.js";
import type { OpInput } from "../ops/definitions.js";

export function demoPlot(): Project {
  return newProject({ id: "demo", name: "Demo house, 30×40 East", plotWidthMm: ftIn(40), plotDepthMm: ftIn(30) });
}

export const DEMO_ROAD: OpInput[] = [{ op: "SetRoad", args: { side: "east", widthM: 9.14, name: "30 ft road" } }];

export const DEMO_GROUND_FLOOR: OpInput[] = [
  { op: "AddRoom", args: { id: "rm_bed1", name: "Bedroom", type: "bedroom", level: "lv_gf", x: 600, y: 1200, width: 4200, depth: 3600, minArea: 9.5 } },
  { op: "AddRoom", args: { id: "rm_liv", name: "Living", type: "living", level: "lv_gf", x: 4800, y: 1200, width: 4200, depth: 4200 } },
  { op: "AddRoom", args: { id: "rm_din", name: "Dining", type: "dining", level: "lv_gf", x: 4800, y: 5400, width: 4200, depth: 3300 } },
  { op: "AddRoom", args: { id: "rm_tlt1", name: "Toilet", type: "toilet", level: "lv_gf", x: 600, y: 4800, width: 1800, depth: 1800 } },
  { op: "AddRoom", args: { id: "rm_kit", name: "Kitchen", type: "kitchen", level: "lv_gf", x: 2400, y: 4800, width: 2400, depth: 3900 } },
  { op: "AddRoom", args: { id: "rm_puja", name: "Puja", type: "puja", level: "lv_gf", x: 600, y: 6600, width: 1800, depth: 2100 } },
  { op: "AddOpening", args: { type: "door", room: "rm_liv", side: "east", offset: 600, width: 1050, swing: { hinge: "start", into: "host" } } },
  { op: "AddOpening", args: { type: "window", room: "rm_liv", side: "east", offset: 2200, width: 1500 } },
  { op: "AddOpening", args: { type: "window", room: "rm_liv", side: "south", width: 1500 } },
  { op: "AddOpening", args: { type: "door", room: "rm_bed1", side: "east", offset: 2400 } },
  { op: "AddOpening", args: { type: "window", room: "rm_bed1", side: "south", width: 1500 } },
  { op: "AddOpening", args: { type: "window", room: "rm_bed1", side: "west" } },
  { op: "AddOpening", args: { type: "door", room: "rm_tlt1", side: "south", offset: 600, width: 750, swing: { hinge: "end", into: "host" } } },
  { op: "AddOpening", args: { type: "ventilator", room: "rm_tlt1", side: "west" } },
  { op: "AddOpening", args: { type: "door", room: "rm_kit", side: "east", offset: 1400 } },
  { op: "AddOpening", args: { type: "window", room: "rm_kit", side: "north" } },
  { op: "AddOpening", args: { type: "door", room: "rm_puja", side: "east", offset: 600, width: 750 } },
  { op: "AddOpening", args: { type: "window", room: "rm_puja", side: "north", width: 600 } },
  { op: "AddOpening", args: { type: "opening", room: "rm_liv", side: "north", offset: 1200, width: 1800 } },
  { op: "AddOpening", args: { type: "window", room: "rm_din", side: "north", width: 1500 } },
  { op: "AddOpening", args: { type: "window", room: "rm_din", side: "east", width: 1200 } },
];
