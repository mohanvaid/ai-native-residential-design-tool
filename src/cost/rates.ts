/**
 * Chennai rate table for a G+2 RCC-framed house, indicative for late 2026,
 * in INR including material and labour, before the contractor's margin.
 * These are planning numbers for comparing options, not a tender: a project
 * overrides any rate with SetRate, and a quantity surveyor should confirm
 * them before anyone signs a contract.
 */
export type Unit = "m³" | "m²" | "m" | "kg" | "no." | "point" | "set";

export interface Rate {
  code: string;
  trade: string;
  description: string;
  unit: Unit;
  /** INR per unit, material + labour. */
  rate: number;
  /** Labour share of the rate, for the material/labour split. */
  labour: number;
}

export const CITY = "Chennai";
export const RATE_TABLE_VERSION = "Chennai indicative rates, Q4 2026";

/** Contractor's overheads and profit, and a contingency, on the construction subtotal. */
export const MARGIN = 0.1;
export const CONTINGENCY = 0.03;

export const RATES: readonly Rate[] = [
  { code: "EW-01", trade: "Earthwork", description: "Excavation for footings in ordinary soil, including disposal", unit: "m³", rate: 450, labour: 0.9 },
  { code: "EW-02", trade: "Earthwork", description: "Plinth filling with gravel/earth, consolidated", unit: "m³", rate: 1100, labour: 0.5 },
  { code: "CC-01", trade: "Concrete", description: "PCC 1:4:8 below footings and floors", unit: "m³", rate: 6800, labour: 0.3 },
  { code: "RC-01", trade: "RCC", description: "RCC M20 footings, including formwork", unit: "m³", rate: 8800, labour: 0.3 },
  { code: "RC-02", trade: "RCC", description: "RCC M20 columns, including formwork", unit: "m³", rate: 11500, labour: 0.4 },
  { code: "RC-03", trade: "RCC", description: "RCC M20 plinth beams, beams and lintels, including formwork", unit: "m³", rate: 11000, labour: 0.4 },
  { code: "RC-04", trade: "RCC", description: "RCC M20 floor and roof slabs, including formwork", unit: "m³", rate: 10000, labour: 0.35 },
  { code: "RC-05", trade: "RCC", description: "RCC M20 staircase waist slab and steps", unit: "m³", rate: 12000, labour: 0.4 },
  { code: "ST-01", trade: "Steel", description: "Fe500D reinforcement, cut, bent and tied", unit: "kg", rate: 88, labour: 0.15 },
  { code: "BW-01", trade: "Masonry", description: "Brickwork 230 mm in CM 1:6", unit: "m³", rate: 7600, labour: 0.35 },
  { code: "BW-02", trade: "Masonry", description: "Brickwork 115 mm partitions and parapets in CM 1:4", unit: "m²", rate: 1050, labour: 0.4 },
  { code: "PL-01", trade: "Plastering", description: "Internal plaster 12 mm CM 1:5, walls and ceilings", unit: "m²", rate: 280, labour: 0.6 },
  { code: "PL-02", trade: "Plastering", description: "External plaster 18 mm CM 1:4 with waterproof compound", unit: "m²", rate: 360, labour: 0.6 },
  { code: "WP-01", trade: "Waterproofing", description: "Terrace waterproofing and weathering course with pressed tiles", unit: "m²", rate: 950, labour: 0.4 },
  { code: "FL-02", trade: "Flooring", description: "Skirting 100 mm to match flooring", unit: "m", rate: 240, labour: 0.4 },
  { code: "FL-03", trade: "Flooring", description: "Glazed wall tiles in toilets to 2.1 m", unit: "m²", rate: 1250, labour: 0.35 },
  { code: "JN-01", trade: "Doors and windows", description: "Door, with frame, shutter and hardware", unit: "no.", rate: 14000, labour: 0.15 },
  { code: "JN-02", trade: "Doors and windows", description: "Window or ventilator, uPVC with glass and grill", unit: "m²", rate: 7500, labour: 0.1 },
  { code: "RL-01", trade: "Railings", description: "MS stair railing, painted", unit: "m", rate: 2800, labour: 0.35 },
  { code: "PT-01", trade: "Painting", description: "Internal: putty, primer and two coats of emulsion", unit: "m²", rate: 135, labour: 0.55 },
  { code: "PT-02", trade: "Painting", description: "External: primer and two coats of exterior emulsion", unit: "m²", rate: 110, labour: 0.5 },
  { code: "EL-01", trade: "Electrical", description: "Wiring points with switches and conduits (estimated count per room)", unit: "point", rate: 1700, labour: 0.4 },
  { code: "EL-02", trade: "Electrical", description: "Distribution board, earthing and service connection", unit: "set", rate: 45000, labour: 0.3 },
  { code: "PB-01", trade: "Plumbing", description: "Toilet plumbing: water supply, drainage, CP fittings and fixtures", unit: "set", rate: 55000, labour: 0.3 },
  { code: "PB-02", trade: "Plumbing", description: "Kitchen sink, water and drainage points", unit: "set", rate: 18000, labour: 0.3 },
  { code: "PB-03", trade: "Plumbing", description: "Sump, overhead tank, pump and external drainage (allowance)", unit: "set", rate: 160000, labour: 0.35 },
  { code: "LF-01", trade: "Lift", description: "Machine-room-less passenger lift, supplied and installed, per stop", unit: "no.", rate: 260000, labour: 0.15 },
  { code: "LF-02", trade: "Lift", description: "Lift shaft and duct enclosure, RCC/brick 230 mm, plastered", unit: "m²", rate: 2400, labour: 0.4 },
  { code: "CW-01", trade: "Compound wall", description: "Compound wall, 230 mm brick on footing with coping, plastered and painted both sides", unit: "m", rate: 7800, labour: 0.4 },
  { code: "EL-03", trade: "Electrical", description: "Light, fan or switchboard point, wired (from the electrical layout)", unit: "point", rate: 1500, labour: 0.4 },
  { code: "EL-04", trade: "Electrical", description: "Power point 16 A, AC or geyser point, wired on its own circuit", unit: "point", rate: 2600, labour: 0.4 },
  { code: "EL-05", trade: "Electrical", description: "Socket 6 A, TV or data point, wired", unit: "point", rate: 1200, labour: 0.4 },
  { code: "PB-04", trade: "Plumbing", description: "Water supply point, CPVC concealed (from the plumbing layout)", unit: "point", rate: 2200, labour: 0.4 },
  { code: "PB-05", trade: "Plumbing", description: "Drainage point, floor trap or WC outlet, uPVC", unit: "point", rate: 2600, labour: 0.4 },
  { code: "PB-06", trade: "Plumbing", description: "Soil/waste stack, uPVC 110 mm with fittings, per storey", unit: "m", rate: 1400, labour: 0.35 },
];

const BY_CODE = new Map(RATES.map((r) => [r.code, r]));
export const rateFor = (code: string) => BY_CODE.get(code);
