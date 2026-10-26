import { describe, expect, it } from "vitest";
import { ModelStore, floorPlanSheet, renderFloorPlanPdf, renderViewerHtml, sheetsToPdf, fitPaper, type Project } from "../src/index.js";
import { DEMO_GROUND_FLOOR, DEMO_ROAD, demoPlot } from "../src/templates/demo-house.js";

function demo(): Project {
  const store = new ModelStore(demoPlot());
  store.commit(DEMO_ROAD);
  store.commit(DEMO_GROUND_FLOOR);
  store.commit([{ op: "AddLevel", args: { id: "lv_ff", name: "First" } }]);
  return store.current;
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("PDF", () => {
  it("writes the site plan and one page per level with a valid cross-reference table", () => {
    const pdf = text(renderFloorPlanPdf(demo()));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(3);
    const xref = Number(/startxref\s+(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    for (const m of pdf.slice(xref).matchAll(/^(\d{10}) 00000 n/gm)) {
      expect(pdf.slice(Number(m[1]), Number(m[1]) + 20)).toMatch(/^\d+ 0 obj/);
    }
  });

  it("keeps 1:100 when the drawing fits A4, and the advisory stamp and revision", () => {
    const p = demo();
    const sheet = floorPlanSheet(p, "lv_gf");
    expect(fitPaper(sheet)).toMatchObject({ scale: 100 });
    const pdf = text(sheetsToPdf([sheet]));
    expect(pdf).toContain("ADVISORY");
    expect(pdf).toContain("Rev C");
  });
});

describe("viewer", () => {
  it("is one self-contained file with every level, schedules and the PDF", () => {
    const html = renderViewerHtml(demo());
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)="https?:/);
    // Site, two floors, four elevations and a section
    expect(html.match(/<svg /g)).toHaveLength(8);
    expect(html).toContain(">Section</button>");
    expect(html).toContain(">Site</button>");
    expect(html).toContain(">Ground</button>");
    expect(html).toContain(">First</button>");
    expect(html).toContain("ADVISORY · NOT FOR CONSTRUCTION OR APPROVAL");
    expect(html).toContain("Rev C");
    expect(html).toContain("<td>D1</td>");
    expect(html).toContain("Download drawings as PDF");
    expect(html).toContain('id="zin"');
  });

  it("can leave the PDF out to stay small", () => {
    const html = renderViewerHtml(demo(), { includePdf: false });
    expect(html).not.toContain("Download drawings as PDF");
    expect(html.length).toBeLessThan(renderViewerHtml(demo()).length);
  });
});
