import { describe, expect, it } from "vitest";
import { fromTextFrame, rectFromTextFrame, textRotation, toTextFrame, visualToPage } from "../src/visual";

describe("text frames", () => {
  it("classifies the four upright text directions", () => {
    expect(textRotation(12, 0, 0, 12)).toBe(0);
    expect(textRotation(0, 12, -12, 0)).toBe(90);
    expect(textRotation(-12, 0, 0, -12)).toBe(180);
    expect(textRotation(0, -12, 12, 0)).toBe(270);
    expect(textRotation(10, 1, -1, 10)).toBeNull(); // skewed
    expect(textRotation(12, 0, 0, -12)).toBeNull(); // mirrored
  });

  it("round-trips points and agrees with visualToPage", () => {
    for (const rot of [0, 90, 180, 270]) {
      const [X, Y] = toTextFrame(rot, 123, 456);
      const [x, y] = fromTextFrame(rot, X, Y);
      expect(x).toBeCloseTo(123);
      expect(y).toBeCloseTo(456);
      // A rect measured in the text frame, mapped back: its visual top-left plus
      // (u, v) lands where moving u along the text and v down from its top does.
      const frameRect = { x: 10, y: -80, w: 60, h: 20 };
      const r = rectFromTextFrame(rot, frameRect);
      const [px, py] = visualToPage(r, rot, 5, 3);
      const [fx, fy] = toTextFrame(rot, px, py);
      expect(fx).toBeCloseTo(frameRect.x + 5);
      expect(fy).toBeCloseTo(frameRect.y + frameRect.h - 3);
    }
  });
});
