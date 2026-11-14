import { describe, expect, it, beforeAll } from "vitest";
import { PDFDocument } from "pdf-lib";
import { cssToRect, makeGeom, rectToCss, toCss, toPdf } from "./geometry";

const ROTATIONS = [0, 90, 180, 270] as const;
// A page whose origin is not (0, 0), to catch offset mistakes.
const VIEW: [number, number, number, number] = [10, 20, 622, 812];

type Viewport = { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
let viewportFor: (rotation: number, scale: number) => Viewport;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([700, 900]);
  page.setMediaBox(VIEW[0], VIEW[1], VIEW[2] - VIEW[0], VIEW[3] - VIEW[1]);
  const bytes = await doc.save();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: bytes, useWorkerFetch: false, disableFontFace: true }).promise;
  const p = await pdf.getPage(1);
  viewportFor = (rotation, scale) => p.getViewport({ scale, rotation }) as unknown as Viewport;
});

describe("page geometry matches PDF.js", () => {
  for (const rotation of ROTATIONS) {
    it(`size and points agree at ${rotation}°`, () => {
      const g = makeGeom(VIEW, rotation, 1.5);
      const vp = viewportFor(rotation, 1.5);
      expect(g.width).toBeCloseTo(vp.width, 6);
      expect(g.height).toBeCloseTo(vp.height, 6);
      for (const [x, y] of [[10, 20], [622, 812], [100, 700], [400.5, 33.25]] as const) {
        const [cx, cy] = toCss(g, x, y);
        const [ex, ey] = vp.convertToViewportPoint(x, y);
        expect(cx).toBeCloseTo(ex!, 6);
        expect(cy).toBeCloseTo(ey!, 6);
      }
    });
  }
});

describe("round trips", () => {
  for (const rotation of ROTATIONS) {
    it(`point and rect survive css ↔ pdf at ${rotation}°`, () => {
      const g = makeGeom(VIEW, rotation, 1.25);
      const [px, py] = toPdf(g, ...toCss(g, 123.4, 567.8));
      expect(px).toBeCloseTo(123.4, 9);
      expect(py).toBeCloseTo(567.8, 9);

      const r = { x: 50, y: 60, w: 200, h: 40 };
      const c = rectToCss(g, r);
      const back = cssToRect(g, c.left, c.top, c.width, c.height);
      expect(back.x).toBeCloseTo(r.x, 9);
      expect(back.y).toBeCloseTo(r.y, 9);
      expect(back.w).toBeCloseTo(r.w, 9);
      expect(back.h).toBeCloseTo(r.h, 9);
    });
  }

  it("normalises negative and oversized rotations", () => {
    expect(makeGeom(VIEW, -90, 1).rotation).toBe(270);
    expect(makeGeom(VIEW, 450, 1).rotation).toBe(90);
  });
});
