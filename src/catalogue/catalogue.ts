/**
 * Starter catalogue: generic Indian sizes for furniture, sanitaryware,
 * appliances, vehicles, doors and windows. It turns "a queen bed" or "room
 * for an SUV" into a footprint, the clear space it needs and a price band.
 *
 * Entries are versioned ("bed.queen@1"). A design stores the versioned id, so
 * changing an entry means adding "@2", and saved designs keep their sizes.
 * Prices are rough 2026 Chennai retail bands in INR, for early budgeting only.
 */
import type { RoomType } from "../model/schema.js";

export type Category = "furniture" | "sanitary" | "appliance" | "vehicle" | "door" | "window" | "tile";

/** How a plan symbol is drawn. */
export type Symbol = "bed" | "sofa" | "sofa-chaise" | "table" | "dining" | "wardrobe" | "unit" | "desk" | "swing" | "wc" | "wc-indian" | "basin" | "shower" | "appliance" | "car" | "scooter" | "box";

export interface CatalogueItem {
  /** Versioned id, e.g. "bed.queen@1". */
  id: string;
  name: string;
  category: Category;
  symbol: Symbol;
  /** Along the front face, mm. */
  width: number;
  /** Front to back, mm. */
  depth: number;
  height: number;
  /** Clear space needed around it, mm: in front, at each side, behind. */
  clearance: { front: number; sides: number; back: number };
  /** Rooms it normally goes in; used to suggest and to sanity-check. */
  rooms?: RoomType[];
  /** Has a left and right hand (e.g. a sofa's chaise); `mirror` flips it. */
  handed?: boolean;
  /** Services it needs, for the MEP schedule later. */
  services?: ("socket" | "water" | "drain" | "ac-point")[];
  /** Price band in INR, per piece, or per m² laid for tiles. */
  priceInr: [number, number];
  /** Tiles only: share to add for cutting and breakage. */
  wastage?: number;
}

const C = (front: number, sides = 0, back = 0) => ({ front, sides, back });

export const CATALOGUE: readonly CatalogueItem[] = [
  // Beds: the "front" is the foot end; people walk down both long sides.
  { id: "bed.single@1", name: "Single bed", category: "furniture", symbol: "bed", width: 900, depth: 1900, height: 450, clearance: C(600), rooms: ["bedroom"], priceInr: [12000, 35000] },
  { id: "bed.double@1", name: "Double bed", category: "furniture", symbol: "bed", width: 1350, depth: 1900, height: 450, clearance: C(600, 600), rooms: ["bedroom"], priceInr: [18000, 50000] },
  { id: "bed.queen@1", name: "Queen bed", category: "furniture", symbol: "bed", width: 1500, depth: 2000, height: 450, clearance: C(600, 600), rooms: ["bedroom"], priceInr: [22000, 65000] },
  { id: "bed.king@1", name: "King bed", category: "furniture", symbol: "bed", width: 1800, depth: 2000, height: 450, clearance: C(600, 600), rooms: ["bedroom"], priceInr: [28000, 90000] },
  { id: "wardrobe.2door@1", name: "Wardrobe, 2 door", category: "furniture", symbol: "wardrobe", width: 900, depth: 600, height: 2100, clearance: C(600), rooms: ["bedroom"], priceInr: [15000, 45000] },
  { id: "wardrobe.3door@1", name: "Wardrobe, 3 door", category: "furniture", symbol: "wardrobe", width: 1350, depth: 600, height: 2100, clearance: C(600), rooms: ["bedroom"], priceInr: [22000, 65000] },
  { id: "wardrobe.sliding@1", name: "Sliding wardrobe", category: "furniture", symbol: "wardrobe", width: 1800, depth: 650, height: 2100, clearance: C(450), rooms: ["bedroom"], priceInr: [35000, 110000] },
  { id: "desk.study@1", name: "Study desk", category: "furniture", symbol: "desk", width: 1200, depth: 600, height: 750, clearance: C(750), rooms: ["bedroom", "study"], services: ["socket"], priceInr: [6000, 25000] },
  // Living
  { id: "sofa.2seat@1", name: "2-seater sofa", category: "furniture", symbol: "sofa", width: 1500, depth: 850, height: 850, clearance: C(450), rooms: ["living"], priceInr: [18000, 60000] },
  { id: "sofa.3seat@1", name: "3-seater sofa", category: "furniture", symbol: "sofa", width: 2100, depth: 900, height: 850, clearance: C(450), rooms: ["living"], priceInr: [25000, 85000] },
  { id: "sofa.3seat-chaise@1", name: "3-seater sofa with chaise", category: "furniture", symbol: "sofa-chaise", width: 2400, depth: 1600, height: 850, clearance: C(450), rooms: ["living"], handed: true, priceInr: [40000, 140000] },
  { id: "chair.arm@1", name: "Armchair", category: "furniture", symbol: "sofa", width: 800, depth: 800, height: 850, clearance: C(450), rooms: ["living", "bedroom"], priceInr: [8000, 30000] },
  { id: "table.coffee@1", name: "Coffee table", category: "furniture", symbol: "table", width: 1000, depth: 500, height: 400, clearance: C(0), rooms: ["living"], priceInr: [5000, 25000] },
  { id: "unit.tv@1", name: "TV unit", category: "furniture", symbol: "unit", width: 1800, depth: 400, height: 500, clearance: C(1500), rooms: ["living", "bedroom"], services: ["socket"], priceInr: [10000, 45000] },
  { id: "swing.oonjal@1", name: "Oonjal (swing)", category: "furniture", symbol: "swing", width: 1200, depth: 600, height: 450, clearance: C(900, 150, 900), rooms: ["living", "sit-out"], priceInr: [15000, 60000] },
  { id: "unit.pooja@1", name: "Pooja unit", category: "furniture", symbol: "unit", width: 900, depth: 450, height: 1800, clearance: C(750), rooms: ["puja", "living", "dining"], priceInr: [12000, 60000] },
  // Dining: the clearance is the space to pull chairs out and pass behind them.
  { id: "dining.4@1", name: "4-seater dining", category: "furniture", symbol: "dining", width: 1200, depth: 800, height: 750, clearance: C(750, 600, 750), rooms: ["dining", "living", "kitchen"], priceInr: [15000, 50000] },
  { id: "dining.6@1", name: "6-seater dining", category: "furniture", symbol: "dining", width: 1800, depth: 900, height: 750, clearance: C(750, 600, 750), rooms: ["dining", "living"], priceInr: [25000, 80000] },
  { id: "dining.8@1", name: "8-seater dining", category: "furniture", symbol: "dining", width: 2400, depth: 1000, height: 750, clearance: C(750, 600, 750), rooms: ["dining", "living"], priceInr: [40000, 130000] },
  // Kitchen and utility
  { id: "fridge.single@1", name: "Fridge, single door", category: "appliance", symbol: "appliance", width: 600, depth: 650, height: 1500, clearance: C(750), rooms: ["kitchen", "dining", "utility"], services: ["socket"], priceInr: [15000, 30000] },
  { id: "fridge.double@1", name: "Fridge, double door", category: "appliance", symbol: "appliance", width: 700, depth: 720, height: 1750, clearance: C(900), rooms: ["kitchen", "dining", "utility"], services: ["socket"], priceInr: [25000, 60000] },
  { id: "washer.front@1", name: "Washing machine, front load", category: "appliance", symbol: "appliance", width: 600, depth: 600, height: 850, clearance: C(600), rooms: ["utility", "toilet", "balcony"], services: ["socket", "water", "drain"], priceInr: [25000, 50000] },
  // Sanitaryware: front clearance per NBC-style guidance for small toilets.
  { id: "wc.ewc@1", name: "Western WC", category: "sanitary", symbol: "wc", width: 400, depth: 700, height: 400, clearance: C(600, 200), rooms: ["toilet"], services: ["water", "drain"], priceInr: [6000, 25000] },
  { id: "wc.iwc@1", name: "Indian WC", category: "sanitary", symbol: "wc-indian", width: 450, depth: 650, height: 0, clearance: C(500, 200, 200), rooms: ["toilet"], services: ["water", "drain"], priceInr: [2500, 8000] },
  { id: "basin.wall@1", name: "Wash basin", category: "sanitary", symbol: "basin", width: 550, depth: 450, height: 800, clearance: C(600, 100), rooms: ["toilet", "dining", "passage"], services: ["water", "drain"], priceInr: [3000, 15000] },
  { id: "shower.area@1", name: "Shower area", category: "sanitary", symbol: "shower", width: 900, depth: 900, height: 0, clearance: C(0), rooms: ["toilet"], services: ["water", "drain"], priceInr: [4000, 20000] },
  // Vehicles: width across the car, depth nose to tail; the front is the nose. Sides leave room to open doors.
  { id: "car.hatchback@1", name: "Hatchback", category: "vehicle", symbol: "car", width: 1700, depth: 3800, height: 1550, clearance: C(300, 600, 300), rooms: ["car-porch", "parking"], priceInr: [0, 0] },
  { id: "car.sedan@1", name: "Sedan", category: "vehicle", symbol: "car", width: 1750, depth: 4500, height: 1500, clearance: C(300, 600, 300), rooms: ["car-porch", "parking"], priceInr: [0, 0] },
  { id: "car.suv-compact@1", name: "Compact SUV", category: "vehicle", symbol: "car", width: 1800, depth: 4000, height: 1650, clearance: C(300, 600, 300), rooms: ["car-porch", "parking"], priceInr: [0, 0] },
  { id: "car.suv@1", name: "Full-size SUV", category: "vehicle", symbol: "car", width: 1900, depth: 4800, height: 1800, clearance: C(300, 600, 300), rooms: ["car-porch", "parking"], priceInr: [0, 0] },
  { id: "scooter@1", name: "Scooter", category: "vehicle", symbol: "scooter", width: 700, depth: 1850, height: 1150, clearance: C(300, 300, 300), rooms: ["car-porch", "sit-out"], priceInr: [0, 0] },
  // Doors and windows: sizes for AddOpening, prices for the estimate.
  { id: "door.main-teak@1", name: "Main door, teak", category: "door", symbol: "box", width: 1050, depth: 0, height: 2100, clearance: C(0), priceInr: [45000, 120000] },
  { id: "door.flush@1", name: "Internal flush door", category: "door", symbol: "box", width: 900, depth: 0, height: 2100, clearance: C(0), priceInr: [9000, 18000] },
  { id: "door.toilet-pvc@1", name: "Toilet door, PVC", category: "door", symbol: "box", width: 750, depth: 0, height: 2100, clearance: C(0), priceInr: [5000, 9000] },
  { id: "window.upvc-1500@1", name: "uPVC sliding window, 1500", category: "window", symbol: "box", width: 1500, depth: 0, height: 1200, clearance: C(0), priceInr: [14000, 24000] },
  { id: "window.upvc-1200@1", name: "uPVC sliding window, 1200", category: "window", symbol: "box", width: 1200, depth: 0, height: 1200, clearance: C(0), priceInr: [11000, 19000] },
  { id: "ventilator.600@1", name: "Ventilator with louvres, 600", category: "window", symbol: "box", width: 600, depth: 0, height: 450, clearance: C(0), priceInr: [2500, 5000] },
  // Floor finishes: size is the tile, price per m² laid.
  { id: "tile.vitrified-600@1", name: "Vitrified tile 600 × 600", category: "tile", symbol: "box", width: 600, depth: 600, height: 10, clearance: C(0), wastage: 0.1, priceInr: [900, 1800] },
  { id: "tile.vitrified-800@1", name: "Vitrified tile 800 × 800", category: "tile", symbol: "box", width: 800, depth: 800, height: 10, clearance: C(0), wastage: 0.12, priceInr: [1200, 2400] },
  { id: "tile.ceramic-antiskid-300@1", name: "Anti-skid ceramic tile 300 × 300", category: "tile", symbol: "box", width: 300, depth: 300, height: 8, clearance: C(0), wastage: 0.07, priceInr: [700, 1300] },
  { id: "tile.granite-flamed@1", name: "Flamed granite 600 × 600", category: "tile", symbol: "box", width: 600, depth: 600, height: 18, clearance: C(0), wastage: 0.08, priceInr: [1800, 3200] },
  { id: "tile.wood-laminate@1", name: "Wooden laminate 1200 × 200", category: "tile", symbol: "box", width: 1200, depth: 200, height: 8, clearance: C(0), wastage: 0.08, priceInr: [1300, 2600] },
];

/** The floor finish a room gets when none is chosen. */
export function defaultFloorFinish(type: RoomType): string {
  if (type === "toilet" || type === "utility" || type === "balcony") return "tile.ceramic-antiskid-300@1";
  if (type === "car-porch" || type === "sit-out") return "tile.granite-flamed@1";
  return "tile.vitrified-600@1";
}

const BY_ID = new Map(CATALOGUE.map((c) => [c.id, c]));

/** Looks up an entry by versioned id, or by bare id for the latest version. */
export function catalogueItem(id: string): CatalogueItem | undefined {
  if (id.includes("@")) return BY_ID.get(id);
  return CATALOGUE.filter((c) => c.id.startsWith(`${id}@`)).sort((a, b) => version(b.id) - version(a.id))[0];
}

const version = (id: string) => Number(id.split("@")[1] ?? 0);

/** Items that can be placed in rooms (not doors, windows or finishes). */
export const PLACEABLE = CATALOGUE.filter((c) => c.category !== "door" && c.category !== "window" && c.category !== "tile");

/** One line per entry, for the agent's system prompt. */
export function catalogueDigest(): string {
  return CATALOGUE.map((c) => `${c.id.split("@")[0]}: ${c.name}, ${c.depth ? `${c.width} wide × ${c.depth} deep` : `${c.width} wide × ${c.height} high`}${c.handed ? ", handed" : ""}`).join("\n");
}
