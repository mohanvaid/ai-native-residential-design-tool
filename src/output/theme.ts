/** Exterior colour themes for elevations and 3D (project.prefs.theme). */
import type { Project } from "../model/schema.js";

export interface Palette {
  walls: string;
  accent: string;
  roof: string;
  frame: string;
  glass: string;
  door: string;
  floor: string;
  ground: string;
}

export const THEMES: Record<Project["prefs"]["theme"], Palette> = {
  classic: { walls: "#f3e6c8", accent: "#b5532c", roof: "#cfcac0", frame: "#ffffff", glass: "#a9cce3", door: "#7b4a26", floor: "#e9e4da", ground: "#cdd8c0" },
  modern: { walls: "#f4f4f2", accent: "#4b4f54", roof: "#d6d6d6", frame: "#2f3337", glass: "#9fb8c8", door: "#3a3a3a", floor: "#e6e6e6", ground: "#d3dcc8" },
  earthy: { walls: "#e3c9a3", accent: "#7a4b2a", roof: "#c9b79c", frame: "#5a3a22", glass: "#a7c4c2", door: "#5a3a22", floor: "#ead9bf", ground: "#cbd5b5" },
};

export const palette = (project: Project): Palette => THEMES[project.prefs.theme] ?? THEMES.classic;
