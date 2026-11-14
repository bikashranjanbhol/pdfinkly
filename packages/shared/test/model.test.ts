import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { deriveModel, OperationsSchema, type Operation } from "../src/operations";
import { exportPdf, visualToPage, ExportError } from "../src/export";

const text = (page = "p1"): Operation => ({
  op: "annot.add",
  id: "t1",
  page,
  annot: { kind: "text", rect: { x: 50, y: 600, w: 200, h: 40 }, text: "Payment due within 15 days", font: "Helvetica", size: 12, color: "#B91C1C" },
});

async function makePdf(pages: number, withForm = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i + 1}`, { x: 50, y: 740, size: 18, font });
  }
  if (withForm) {
    const form = doc.getForm();
    form.createTextField("client.name").addToPage(doc.getPage(0), { x: 50, y: 500, width: 200, height: 20 });
    form.createCheckBox("agree").addToPage(doc.getPage(0), { x: 50, y: 460, width: 14, height: 14 });
  }
  return doc.save();
}

describe("deriveModel", () => {
  it("starts with base pages in order", () => {
    const m = deriveModel(3, []);
    expect(m.pages.map((p) => p.ref)).toEqual(["p1", "p2", "p3"]);
    expect(m.structureChanged).toBe(false);
  });

  it("moves, rotates, deletes and inserts by stable ref", () => {
    const ops: Operation[] = [
      { op: "page.move", page: "p3", toIndex: 0 },
      { op: "page.rotate", page: "p1", degrees: 90 },
      { op: "page.rotate", page: "p1", degrees: 270 },
      { op: "page.rotate", page: "p2", degrees: 90 },
      { op: "page.insertBlank", at: 1, page: "b:x1", size: { w: 612, h: 792 } },
      { op: "page.delete", page: "p1" },
    ];
    const m = deriveModel(3, ops);
    expect(m.pages.map((p) => p.ref)).toEqual(["p3", "b:x1", "p2"]);
    expect(m.pages.find((p) => p.ref === "p2")!.rotation).toBe(90);
    expect(m.structureChanged).toBe(true);
  });

  it("drops annotations on deleted pages and never deletes the last page", () => {
    const m = deriveModel(2, [text("p2"), { op: "page.delete", page: "p2" }, { op: "page.delete", page: "p1" }]);
    expect(m.pages.map((p) => p.ref)).toEqual(["p1"]);
    expect(m.annotations).toHaveLength(0);
  });

  it("updates and deletes annotations", () => {
    const upd: Operation = { op: "annot.update", id: "t1", annot: { kind: "highlight", rect: { x: 1, y: 2, w: 3, h: 4 }, color: "#FACC15" } };
    expect(deriveModel(1, [text(), upd]).annotations[0]!.annot.kind).toBe("highlight");
    expect(deriveModel(1, [text(), { op: "annot.delete", id: "t1" }]).annotations).toHaveLength(0);
  });

  it("is pure: same ops give the same model", () => {
    const ops: Operation[] = [text(), { op: "page.move", page: "p1", toIndex: 1 }];
    expect(deriveModel(2, ops)).toEqual(deriveModel(2, ops));
  });

  it("forgets merged versions whose pages were all deleted", () => {
    const v = "6f1c2a7d-3b8e-4f6a-8c5d-7e9b1a3c5e7f";
    const m = deriveModel(1, [
      { op: "page.insertFrom", at: 1, fileId: v, versionId: v, pageCount: 1, pages: ["x:a:1"] },
      { op: "page.delete", page: "x:a:1" },
    ]);
    expect(m.externalVersions).toEqual([]);
  });
});

describe("OperationsSchema", () => {
  it("accepts valid operations and rejects bad colors", () => {
    expect(OperationsSchema.safeParse([text()]).success).toBe(true);
    const bad = [{ ...text(), annot: { kind: "highlight", rect: { x: 0, y: 0, w: 1, h: 1 }, color: "red" } }];
    expect(OperationsSchema.safeParse(bad).success).toBe(false);
  });
});

describe("visualToPage", () => {
  const r = { x: 100, y: 200, w: 50, h: 30 };
  it("maps the visual top-left for each rotation", () => {
    expect(visualToPage(r, 0, 0, 0)).toEqual([100, 230]);
    expect(visualToPage(r, 90, 0, 0)).toEqual([100, 200]);
    expect(visualToPage(r, 180, 0, 0)).toEqual([150, 200]);
    expect(visualToPage(r, 270, 0, 0)).toEqual([150, 230]);
  });
});

describe("exportPdf", () => {
  it("keeps the file as-is in structure when only annotating", async () => {
    const base = await makePdf(2);
    const ops: Operation[] = [
      text(),
      { op: "annot.add", id: "h", page: "p1", annot: { kind: "highlight", rect: { x: 50, y: 700, w: 200, h: 20 }, color: "#FACC15" } },
      { op: "annot.add", id: "i", page: "p2", annot: { kind: "ink", strokes: [[10, 10, 50, 60, 90, 20]], width: 2, color: "#1D4ED8" } },
      { op: "annot.add", id: "a", page: "p2", annot: { kind: "arrow", from: [100, 100], to: [200, 150], stroke: "#B91C1C", width: 2 } },
      { op: "annot.add", id: "e", page: "p2", annot: { kind: "ellipse", rect: { x: 300, y: 300, w: 80, h: 40 }, stroke: "#15803D", fill: null, width: 2 } },
      { op: "annot.add", id: "n", page: "p2", annot: { kind: "note", at: [500, 700], text: "Check with legal" } },
    ];
    const out = await PDFDocument.load(await exportPdf({ base, ops }));
    expect(out.getPageCount()).toBe(2);
  });

  it("reorders, rotates, deletes and inserts pages", async () => {
    const base = await makePdf(3);
    const ops: Operation[] = [
      { op: "page.move", page: "p3", toIndex: 0 },
      { op: "page.rotate", page: "p3", degrees: 90 },
      { op: "page.delete", page: "p2" },
      { op: "page.insertBlank", at: 3, page: "b:z", size: { w: 300, h: 400 } },
      text("p3"),
    ];
    const out = await PDFDocument.load(await exportPdf({ base, ops }));
    expect(out.getPageCount()).toBe(3);
    expect(out.getPage(0).getRotation().angle).toBe(90);
    expect(out.getPage(2).getSize()).toEqual({ width: 300, height: 400 });
  });

  it("merges pages from another PDF", async () => {
    const base = await makePdf(1);
    const other = await makePdf(2);
    const v = "6f1c2a7d-3b8e-4f6a-8c5d-7e9b1a3c5e7f";
    const ops: Operation[] = [{ op: "page.insertFrom", at: 1, fileId: v, versionId: v, pageCount: 2, pages: ["x:m:1", "x:m:2"] }];
    const out = await PDFDocument.load(await exportPdf({ base, ops, external: { [v]: other } }));
    expect(out.getPageCount()).toBe(3);
    await expect(exportPdf({ base, ops })).rejects.toBeInstanceOf(ExportError);
  });

  it("fills form fields and keeps them when pages are untouched", async () => {
    const base = await makePdf(1, true);
    const ops: Operation[] = [
      { op: "form.set", field: "client.name", value: "Aditi Sharma" },
      { op: "form.set", field: "agree", value: true },
    ];
    const out = await PDFDocument.load(await exportPdf({ base, ops }));
    const form = out.getForm();
    expect(form.getTextField("client.name").getText()).toBe("Aditi Sharma");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
  });

  it("places a signature image", async () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const base = await makePdf(1);
    const ops: Operation[] = [{ op: "annot.add", id: "s", page: "p1", annot: { kind: "signature", rect: { x: 60, y: 80, w: 160, h: 50 }, dataUrl: png } }];
    const bytes = await exportPdf({ base, ops });
    expect(bytes.length).toBeGreaterThan(base.length);
  });

  it("replaces characters standard fonts cannot draw", async () => {
    const base = await makePdf(1);
    const ops: Operation[] = [{
      op: "annot.add", id: "u", page: "p1",
      annot: { kind: "text", rect: { x: 50, y: 600, w: 200, h: 40 }, text: "₹ 500 — नमस्ते", font: "Helvetica", size: 12, color: "#18181B" },
    }];
    await expect(exportPdf({ base, ops })).resolves.toBeInstanceOf(Uint8Array);
  });
});
