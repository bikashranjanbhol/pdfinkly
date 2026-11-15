import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { asNumber, gridsToXlsx, toGrid } from "./xlsx";
import type { Cellish } from "./layout";

const c = (text: string, x: number, baseline: number, w = text.length * 5, size = 10): Cellish => ({ text, x, x1: x + w, baseline, size });

describe("Excel conversion", () => {
  it("reads amounts the way they're written in India and elsewhere", () => {
    expect(asNumber("1,24,500.00")).toEqual({ value: 124500, percent: false, decimals: 2 });
    expect(asNumber("₹ 2,500")?.value).toBe(2500);
    expect(asNumber("Rs. 99.5")?.value).toBe(99.5);
    expect(asNumber("(1,200.00)")?.value).toBe(-1200);
    expect(asNumber("-45")?.value).toBe(-45);
    expect(asNumber("18%")).toEqual({ value: 0.18, percent: true, decimals: 0 });
    for (const t of ["560034", "INV-2026-0042", "12/03/2026", "0091234", "Total", "1,2,3"]) {
      if (t === "560034") expect(asNumber(t)?.value).toBe(560034);
      else expect(asNumber(t), t).toBeNull();
    }
  });

  it("puts a statement's text into rows and columns", () => {
    const cells = [
      c("Account statement", 50, 60, 120, 14),
      c("Date", 50, 100), c("Description", 120, 100), c("Amount", 300, 100),
      c("01/11/2026", 50, 115), c("Salary", 120, 115), c("1,24,500.00", 290, 115),
      c("05/11/2026", 50, 130), c("Rent", 120, 130), c("(25,000.00)", 288, 130),
      c("Closing balance", 120, 160), c("99,500.00", 296, 160),
    ];
    const g = toGrid(cells);
    expect(g[0]).toEqual(["Account statement"]);
    expect(g[1]).toEqual([]); // the gap after the title
    expect(g[2]).toEqual(["Date", "Description", "Amount"]);
    expect(g[3]).toEqual(["01/11/2026", "Salary", 124500]);
    expect(g[4]).toEqual(["05/11/2026", "Rent", -25000]);
    expect(g[6]).toEqual([null, "Closing balance", 99500]);
  });

  it("joins words PDF.js split into separate runs", () => {
    const g = toGrid([c("Invoice", 50, 100, 35), c("total", 87, 100, 25), c("2,500", 300, 100), c("Tax", 50, 115), c("450", 300, 115)]);
    expect(g[0]).toEqual(["Invoice total", 2500]);
  });

  it("writes a valid workbook", async () => {
    const bytes = await gridsToXlsx([{ name: "Page 1", grid: [["Item", "Amount"], ["Tea & <snacks>", 120.5]], formats: [[null, null], [null, "dec"]] }]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("Tea &amp; &lt;snacks&gt;");
    expect(sheet).toContain('<c r="B2" s="1"><v>120.5</v></c>');
  });
});
