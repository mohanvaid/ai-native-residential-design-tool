/** Unit helpers. The model stores millimetres; Chennai clients talk in feet-inches and sq ft. */

export const MM_PER_FT = 304.8;
export const MM_PER_IN = 25.4;
export const SQFT_PER_SQM = 10.7639;

export function ftIn(feet: number, inches = 0): number {
  return Math.round(feet * MM_PER_FT + inches * MM_PER_IN);
}

/** 3658 → `12'0"`. Rounded to the nearest inch. */
export function formatFtIn(mm: number): string {
  const totalIn = Math.round(mm / MM_PER_IN);
  const sign = totalIn < 0 ? "-" : "";
  const abs = Math.abs(totalIn);
  return `${sign}${Math.floor(abs / 12)}'${abs % 12}"`;
}

export const mm2ToSqm = (mm2: number) => mm2 / 1e6;
export const sqmToSqft = (sqm: number) => sqm * SQFT_PER_SQM;

export function formatArea(sqm: number): string {
  return `${Math.round(sqmToSqft(sqm))} sq ft (${sqm.toFixed(1)} m²)`;
}

export function formatMetres(mm: number): string {
  return `${(mm / 1000).toFixed(2)} m`;
}
