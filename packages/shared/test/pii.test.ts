import { describe, expect, it } from "vitest";
import { findInRuns, verhoeffValid, type TextRun } from "../src/pii";

/** A valid Aadhaar-format number (Verhoeff check digit) starting with `prefix` (11 digits). */
const aadhaar = (prefix: string) => {
  for (let d = 0; d < 10; d++) if (verhoeffValid(prefix + d)) return prefix + d;
  throw new Error("no check digit");
};
const run = (str: string, x: number, y: number, size = 10, rot = 0): TextRun => {
  const w = str.length * size * 0.55;
  const c = Math.cos((rot * Math.PI) / 180), s = Math.sin((rot * Math.PI) / 180);
  return { str, width: w, transform: [size * c, size * s, -size * s, size * c, x, y] };
};

describe("personal data finder", () => {
  const A = aadhaar("23456789012");
  const spaced = `${A.slice(0, 4)} ${A.slice(4, 8)} ${A.slice(8)}`;

  it("validates Aadhaar numbers with Verhoeff", () => {
    expect(verhoeffValid(A)).toBe(true);
    const wrong = A.slice(0, 11) + ((Number(A[11]) + 1) % 10);
    expect(verhoeffValid(wrong)).toBe(false);
  });

  it("finds each kind, with labels and boxes on the right words", () => {
    const runs = [
      run(`Aadhaar: ${spaced}`, 50, 700),
      run("PAN: ABCPE1234F", 50, 680),
      run("Mobile +91 98765 43210, email aditi.sharma@example.com", 50, 660),
      run("UPI aditi@oksbi  IFSC HDFC0001234", 50, 640),
      run("Savings A/c No. 50100123456789", 50, 620),
      run("Invoice 2026-0042 total 1,24,500 order 123456789012", 50, 600), // no false positives
    ];
    const found = findInRuns(runs, ["aadhaar", "pan", "phone", "email", "ifsc", "bank"]);
    const by = (k: string) => found.filter((f) => f.kind === k).map((f) => f.text);
    expect(by("aadhaar")).toEqual([spaced]);
    expect(by("pan")).toEqual(["ABCPE1234F"]);
    expect(by("phone")).toEqual(["+91 98765 43210"]);
    expect(by("email").sort()).toEqual(["aditi.sharma@example.com", "aditi@oksbi"]);
    expect(by("ifsc")).toEqual(["HDFC0001234"]);
    expect(by("bank")).toEqual(["50100123456789"]);
    expect(found).toHaveLength(7);
    const pan = found.find((f) => f.kind === "pan")!;
    // "PAN: " is 5 characters before it; the box starts after them and ends at the line end.
    expect(pan.rect.x).toBeGreaterThan(50 + 4 * 5.5);
    expect(pan.rect.x + pan.rect.w).toBeGreaterThan(50 + 15 * 5.5 - 2);
    expect(pan.rect.y).toBeLessThan(680);
    expect(pan.rect.y + pan.rect.h).toBeGreaterThan(687);
  });

  it("joins runs on one line (OCR words, tab-separated PDFs)", () => {
    const words = [run("Aadhaar", 50, 500), run(A.slice(0, 4), 95, 500), run(A.slice(4, 8), 122, 500), run(A.slice(8), 149, 500)];
    const [m] = findInRuns(words, ["aadhaar"]);
    expect(m?.text).toBe(spaced);
    expect(m!.rect.x).toBeLessThan(96);
    expect(m!.rect.x + m!.rect.w).toBeGreaterThan(149 + 4 * 5.5 - 1);
  });

  it("works on text that runs up a rotated page", () => {
    const r = run("PAN ABCPE1234F", 300, 100, 10, 90);
    const [m] = findInRuns([r], ["pan"]);
    expect(m?.text).toBe("ABCPE1234F");
    // Runs along +y from y=100: the PAN starts ~4 characters in, and the box is a few points around x=300.
    expect(m!.rect.y).toBeGreaterThan(115);
    expect(m!.rect.w).toBeLessThan(16);
    expect(m!.rect.x).toBeLessThan(300);
    expect(m!.rect.x + m!.rect.w).toBeGreaterThan(300 - 1);
  });

  it("custom search is case-insensitive and tolerant of spacing", () => {
    const found = findInRuns([run("Project  Falcon budget", 50, 400), run("project falcon", 50, 380)], ["custom"], "Project Falcon");
    expect(found.map((f) => f.text)).toEqual(["Project  Falcon", "project falcon"]);
  });
});
