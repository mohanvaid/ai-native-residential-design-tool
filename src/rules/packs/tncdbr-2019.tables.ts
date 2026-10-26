/**
 * Tamil Nadu Combined Development and Building Rules, 2019: table values for
 * Non High Rise residential buildings of up to 16 dwellings (rule 35(1)(a)),
 * which covers v1's independent houses up to G+2.
 *
 * Transcribed from the Gazette text MOHAN supplied (extracted to
 * rules/TNCDBR_Rules_2019.txt in the project files; `line` points there).
 * The extraction is partly garbled, so cells marked `uncertain` must be
 * checked against the printed Gazette. Later amendments are not included.
 *
 * Edit this file, not the checks, when a rule changes.
 */
import type { Cell } from "../types.js";

const R35A = "TNCDBR 2019 r.35(1)(a)";

/**
 * Banded rows, checked in order: a row applies when value <= upToM, or
 * value < upToM when `belowUpTo` is set. upToM null means no upper limit.
 */
export interface Band<T> {
  upToM: number | null;
  belowUpTo?: true;
  cell: Cell<T>;
}

export interface SideSetbackRow {
  /** Plot width (frontage) band, metres. */
  plotWidthUpToM: number | null;
  /** Building height band, metres. */
  heightUpToM: number | null;
  setbackM: number;
  applies: "one_side" | "both_sides";
}

export const TNCDBR_2019 = {
  id: "IN-TN-TNCDBR-2019",
  version: "2019 Gazette (no amendments)",

  /** Rule 35(1)(a) A. Other areas need a 3.0 m road; at 6.0 m and above the height limit rises. */
  minRoadWidthM: {
    other: { value: 3.0, cite: `${R35A} A`, line: 1466 } as Cell<number>,
    CBA: { value: null, cite: `${R35A} A`, line: 1466, uncertain: "Digits lost in the extracted text (reads \" m\")." } as Cell<number>,
    EWS: { value: null, cite: `${R35A} A`, line: 1466, uncertain: "Digits lost in the extracted text (reads \" m\")." } as Cell<number>,
  },

  /**
   * Rule 35(1)(a) B, by abutting road width. Other areas: road 3.0–6.0 m allows
   * GF+1F (or stilt+2F), max 9 m; road 6.0 m and above allows GF+2F (or
   * stilt+3F), max 12 m.
   */
  height: {
    other: [
      { upToM: 6.0, cell: { value: { maxHeightM: 9, storeys: 2 }, cite: `${R35A} B`, line: 1467, uncertain: "Column mapping inferred from a flattened table: confirm the 3.0–6.0 m road column is GF+1F / 9 m." } },
      { upToM: null, cell: { value: { maxHeightM: 12, storeys: 3 }, cite: `${R35A} B`, line: 1467 } },
    ] as Band<{ maxHeightM: number; storeys: number }>[],
    CBA: [
      { upToM: null, cell: { value: { maxHeightM: 12, storeys: 3 }, cite: `${R35A} B`, line: 1467, uncertain: "Table flattened: three height cells for four columns. Confirm CBA is GF+2F / 12 m." } },
    ] as Band<{ maxHeightM: number; storeys: number }>[],
    EWS: [
      { upToM: null, cell: { value: null, cite: `${R35A} B`, line: 1467, uncertain: "Table flattened: cannot tell which height cell is the EWS column." } },
    ] as Band<{ maxHeightM: number; storeys: number }>[],
  },

  /** Rule 35(1)(a) D, "Normally Permissible FSI" (the heading is garbled in the extraction). */
  fsi: { value: 2.0, cite: `${R35A} D`, line: 1501 } as Cell<number>,

  /** Rule 49: premium FSI as a share of normal FSI, by road width; nothing below 9 m. */
  premiumFsi: [
    { upToM: 9.0, belowUpTo: true, cell: { value: 0, cite: "TNCDBR 2019 r.49 (below 9.0 m)", line: 2913 } },
    { upToM: 12.0, belowUpTo: true, cell: { value: 0.3, cite: "TNCDBR 2019 r.49", line: 2918 } },
    { upToM: 18.0, belowUpTo: true, cell: { value: 0.4, cite: "TNCDBR 2019 r.49", line: 2917 } },
    { upToM: null, cell: { value: 0.5, cite: "TNCDBR 2019 r.49", line: 2916 } },
  ] as Band<number>[],

  /**
   * Rule 35(1)(a) has no plot coverage row for these buildings; coverage is
   * limited only by setbacks. (Coverage limits elsewhere in the rules are for
   * other building classes, e.g. r.38 transport terminals.)
   */
  coverage: { value: null, cite: `${R35A} (no coverage row)`, line: 1447 } as Cell<number>,

  /** Rule 35(1)(a) E(i), front setback by abutting road width. */
  frontSetback: {
    other: [
      { upToM: 9.0, cell: { value: 1.5, cite: `${R35A} E(i)`, line: 1510 } },
      { upToM: 18.0, cell: { value: 3.0, cite: `${R35A} E(i)`, line: 1511 } },
      { upToM: 30.5, cell: { value: 4.5, cite: `${R35A} E(i)`, line: 1514 } },
      { upToM: null, cell: { value: 6.0, cite: `${R35A} E(i)`, line: 1517 } },
    ] as Band<number>[],
    CBA: [{ upToM: null, cell: { value: 1.5, cite: `${R35A} E(i)`, line: 1507, uncertain: "Read as the CBA column from a flattened row \"1.5m 1.0m\"; confirm." } }] as Band<number>[],
    EWS: [{ upToM: null, cell: { value: 1.0, cite: `${R35A} E(i)`, line: 1507, uncertain: "Read as the EWS column from a flattened row \"1.5m 1.0m\"; confirm." } }] as Band<number>[],
  },

  /**
   * Rule 35(1)(a) E(ii), side setback for other areas by plot width and
   * building height. CBA: nil. The extracted text has no row for plots wider
   * than 12 m.
   */
  sideSetback: {
    cite: { value: null, cite: `${R35A} E(ii)`, line: 1521 } as Cell<unknown>,
    other: [
      { plotWidthUpToM: 7, heightUpToM: 9, setbackM: 1.0, applies: "one_side" },
      { plotWidthUpToM: 7, heightUpToM: null, setbackM: 1.0, applies: "both_sides" },
      { plotWidthUpToM: 12, heightUpToM: 6, setbackM: 1.0, applies: "one_side" },
      { plotWidthUpToM: 12, heightUpToM: 9, setbackM: 1.5, applies: "one_side" },
      { plotWidthUpToM: 12, heightUpToM: null, setbackM: 1.5, applies: "both_sides" },
    ] as SideSetbackRow[],
    widerThan12mUncertain: "No side setback row for plots wider than 12 m in the extracted text; confirm against the Gazette or amendments.",
    CBA: [{ plotWidthUpToM: null, heightUpToM: null, setbackM: 0, applies: "both_sides" }] as SideSetbackRow[],
    EWSUncertain: "Flattened table: unclear whether the plot-width table also applies to EWS areas.",
  },

  /** Rule 35(1)(a) E(iii), rear setback by building height. CBA: nil. */
  rearSetback: {
    other: [
      { upToM: 7.0, cell: { value: 0, cite: `${R35A} E(iii)`, line: 1546 } },
      { upToM: 12.0, cell: { value: 1.5, cite: `${R35A} E(iii)`, line: 1547 } },
    ] as Band<number>[],
    CBA: [{ upToM: null, cell: { value: 0, cite: `${R35A} E(iii)`, line: 1543 } }] as Band<number>[],
  },

  /** Rule 28(a): structures allowed inside setbacks (not checked yet; for projections later). */
  setbackStructures: {
    sunshadeMaxM: { value: 0.6, cite: "TNCDBR 2019 r.28(a)(i)", line: 1330, uncertain: "Extracted as \"06m\"; read as 0.6 m." } as Cell<number>,
    compoundWallMaxHeightM: { value: 2.0, cite: "TNCDBR 2019 r.28(a)(iv)", line: 1337 } as Cell<number>,
    openStairUpToBuildingHeightM: { value: 9.0, cite: "TNCDBR 2019 r.28(a)(iii)", line: 1333 } as Cell<number>,
  },

  /**
   * Rule 29 and the height definition (r.2(57)): what FSI and height leave out.
   * Applied by level kind: stilt parking and terrace-level stair rooms, tanks
   * and a WC up to 10 m².
   */
  exclusions: {
    terraceWcMaxSqm: { value: 10, cite: "TNCDBR 2019 r.29(1)", line: 1357 } as Cell<number>,
    parapetUpToM: { value: 1.5, cite: "TNCDBR 2019 r.2(57)", line: 262 } as Cell<number>,
  },
} as const;
