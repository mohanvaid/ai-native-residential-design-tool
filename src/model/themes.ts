/**
 * Interior themes: a floor, wall and ceiling finish per room type, applied in
 * one step with ApplyTheme. Rooms not listed for a theme keep their finishes.
 */
import type { RoomType } from "./schema.js";

export interface SurfaceSet {
  floor?: string;
  wall?: string;
  ceiling?: string;
}

export interface InteriorTheme {
  id: string;
  name: string;
  description: string;
  /** Finishes by room type; "*" applies to every room type not listed. */
  rooms: Partial<Record<RoomType | "*", SurfaceSet>>;
}

const WET: SurfaceSet = { floor: "tile.ceramic-antiskid-300@1", wall: "walltile.glazed-300x450@1", ceiling: "ceiling.grid-moisture@1" };

export const INTERIOR_THEMES: readonly InteriorTheme[] = [
  {
    id: "classic-white",
    name: "Classic white",
    description: "White walls and ceilings, 600 vitrified floors throughout, standard wet areas.",
    rooms: {
      "*": { floor: "tile.vitrified-600@1", wall: "paint.emulsion-white@1", ceiling: "ceiling.paint-white@1" },
      toilet: { floor: "tile.ceramic-antiskid-300@1", wall: "walltile.glazed-300x450@1", ceiling: "ceiling.paint-white@1" },
      kitchen: { floor: "tile.vitrified-600@1", wall: "walltile.glazed-300x450@1", ceiling: "ceiling.paint-white@1" },
    },
  },
  {
    id: "warm-contemporary",
    name: "Warm contemporary",
    description: "Ivory and greige walls, 800 vitrified living floors, wooden laminate in bedrooms, gypsum cove ceilings in living and master rooms.",
    rooms: {
      "*": { floor: "tile.vitrified-600@1", wall: "paint.emulsion-ivory@1", ceiling: "ceiling.paint-white@1" },
      living: { floor: "tile.vitrified-800@1", wall: "paint.premium-greige@1", ceiling: "ceiling.gypsum@1" },
      dining: { floor: "tile.vitrified-800@1", wall: "paint.premium-greige@1", ceiling: "ceiling.gypsum@1" },
      bedroom: { floor: "tile.wood-laminate@1", wall: "paint.emulsion-ivory@1", ceiling: "ceiling.gypsum@1" },
      toilet: WET,
      kitchen: { floor: "tile.vitrified-600@1", wall: "walltile.glazed-300x600@1", ceiling: "ceiling.paint-white@1" },
    },
  },
  {
    id: "chettinad-earth",
    name: "Chettinad earth",
    description: "Terracotta and sage walls with granite sit-outs, after Chettinad houses; white ceilings.",
    rooms: {
      "*": { floor: "tile.vitrified-600@1", wall: "paint.emulsion-ivory@1", ceiling: "ceiling.paint-white@1" },
      living: { floor: "tile.vitrified-800@1", wall: "paint.premium-terracotta@1", ceiling: "ceiling.paint-white@1" },
      puja: { floor: "tile.granite-flamed@1", wall: "paint.premium-terracotta@1", ceiling: "ceiling.paint-white@1" },
      bedroom: { floor: "tile.vitrified-600@1", wall: "paint.premium-sage@1", ceiling: "ceiling.paint-white@1" },
      "sit-out": { floor: "tile.granite-flamed@1" },
      toilet: WET,
    },
  },
];

export function interiorTheme(id: string): InteriorTheme | undefined {
  return INTERIOR_THEMES.find((t) => t.id === id);
}

export function themeFinishes(theme: InteriorTheme, type: RoomType): SurfaceSet {
  return theme.rooms[type] ?? (type === "parking" || type === "car-porch" || type === "staircase" ? {} : (theme.rooms["*"] ?? {}));
}
