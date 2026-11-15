import { describe, expect, it } from "vitest";
import {
  applyFilter, applyH, detectDocument, homography, makeImg, outputSize, quadIsSane, resize, rotateImg, trueAspect, warp,
  type Img, type Pt, type Quad,
} from "../src/scan";

// ---------------------------------------------------------------------------
// Synthetic photos: a printed page lying on a surface, photographed at an angle.
// ---------------------------------------------------------------------------

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

type Surface = "wood" | "dark" | "beige" | "cloth";
const SURFACE: Record<Surface, [number, number, number]> = {
  wood: [150, 105, 65], dark: [45, 45, 50], beige: [205, 190, 160], cloth: [60, 90, 150],
};

/** Page content at (u, v) in 0..1: text lines, a heading, a dark picture box. */
function ink(u: number, v: number, withPicture: boolean): number {
  if (u < 0.08 || u > 0.92 || v < 0.06 || v > 0.94) return 0;
  if (withPicture && u > 0.55 && u < 0.88 && v > 0.12 && v < 0.3) return 0.85; // a dark photo on the page
  if (v > 0.07 && v < 0.1 && u < 0.6) return 1; // heading
  const line = (v - 0.14) / 0.035;
  if (line > 0 && line % 1 < 0.35 && line < 22) {
    const word = (u * 14 + Math.floor(line) * 0.37) % 1;
    return word < 0.82 ? 1 : 0;
  }
  return 0;
}

interface PhotoOpts {
  w?: number; h?: number; surface?: Surface; quad: Quad; shadow?: boolean; cast?: [number, number, number]; picture?: boolean;
}

function photo({ w = 900, h = 1200, surface = "wood", quad, shadow = false, cast = [1, 1, 1], picture = false }: PhotoOpts): Img {
  const img = makeImg(w, h);
  const toPage = homography(quad, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  const [sr, sg, sb] = SURFACE[surface];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const soft = (t: number) => Math.min(1, Math.max(0, t / (w * 0.08) + 0.5));
      const light = 0.85 + 0.25 * (x / w) * (1 - 0.4 * (y / h)) - (shadow ? 0.35 * soft(w * 0.55 - x) * soft(y - h * 0.35) : 0);
      const grain = surface === "wood" ? 18 * Math.sin(y * 0.09 + Math.sin(x * 0.02) * 3) : 0;
      const n = (rand() - 0.5) * 16;
      let r = sr + grain + n, g = sg + grain * 0.7 + n, b = sb + grain * 0.4 + n;
      const p = applyH(toPage, { x: x + 0.5, y: y + 0.5 });
      if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
        const k = ink(p.x, p.y, picture);
        r = 245 - k * 215 + n; g = 243 - k * 215 + n; b = 236 - k * 210 + n;
      }
      const i = (y * w + x) * 4;
      img.data[i] = r * light * cast[0]; img.data[i + 1] = g * light * cast[1]; img.data[i + 2] = b * light * cast[2]; img.data[i + 3] = 255;
    }
  }
  return img;
}

const px = (q: Quad, w: number, h: number) => q.map((p) => ({ x: p.x * w, y: p.y * h })) as Quad;
const worstError = (a: Quad, b: Quad, diag: number) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y))) / diag;

const Q = (pts: number[][]): Quad => pts.map(([x, y]) => ({ x: x!, y: y! })) as Quad;

describe("geometry", () => {
  it("homography maps the four corners exactly", () => {
    const from = Q([[0, 0], [100, 0], [100, 140], [0, 140]]);
    const to = Q([[12, 30], [180, 8], [210, 250], [5, 230]]);
    const H = homography(from, to);
    from.forEach((p, i) => {
      const r = applyH(H, p);
      expect(r.x).toBeCloseTo(to[i]!.x, 6);
      expect(r.y).toBeCloseTo(to[i]!.y, 6);
    });
  });

  it("sizes the page from its edges and snaps to A4 or Letter", () => {
    expect(outputSize(Q([[0, 0], [2000, 0], [2000, 2760], [0, 2800]]))).toMatchObject({ paper: "a4", height: 2339, width: 1654 });
    expect(outputSize(Q([[0, 0], [850, 0], [850, 1100], [0, 1100]])).paper).toBe("letter");
    const r = outputSize(Q([[0, 0], [500, 0], [500, 500], [0, 500]]));
    expect(r).toMatchObject({ paper: null, width: 625, height: 625 }); // small sources are enlarged at most 1.25×
  });

  it("recovers a page's true proportions from a photo taken at an angle", () => {
    // An A4 sheet seen by a pinhole camera (focal length = the photo's long side) tilted 30° and turned 10°.
    const W = 3000, H = 4000, f = 4000;
    const project = (x: number, y: number) => {
      const a = (30 * Math.PI) / 180, b = (10 * Math.PI) / 180;
      const y1 = y * Math.cos(a), z1 = y * Math.sin(a);
      const x2 = x * Math.cos(b) + z1 * Math.sin(b), z2 = -x * Math.sin(b) + z1 * Math.cos(b);
      const Z = z2 + 450;
      return { x: W / 2 + (f * x2) / Z, y: H / 2 + (f * y1) / Z };
    };
    const q = [project(-105, -148.5), project(105, -148.5), project(105, 148.5), project(-105, 148.5)] as Quad;
    expect(1 / trueAspect(q, W, H)!).toBeCloseTo(Math.SQRT2, 3);
    expect(outputSize(q, 2339, { width: W, height: H })).toMatchObject({ paper: "a4", width: 1654, height: 2339 });
  });

  it("rejects twisted or squashed outlines", () => {
    expect(quadIsSane(Q([[0, 0], [100, 0], [100, 100], [0, 100]]))).toBe(true);
    expect(quadIsSane(Q([[0, 0], [100, 100], [100, 0], [0, 100]]))).toBe(false);
    expect(quadIsSane(Q([[0, 0], [100, 0], [55, 10], [0, 100]]))).toBe(false);
  });

  it("rotates by quarter turns", () => {
    const img = makeImg(3, 2);
    img.data.set([255, 0, 0, 255], 0); // top-left red
    const r = rotateImg(img, 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect(Array.from(r.data.slice(4, 8))).toEqual([255, 0, 0, 255]); // now top-right
    expect(rotateImg(rotateImg(img, 2), 2).data).toEqual(img.data);
  });

  it("resizes by averaging", () => {
    const img = makeImg(4, 4);
    for (let i = 0; i < 16; i++) img.data.set(i % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    const r = resize(img, 2);
    expect([r.width, r.height]).toEqual([2, 2]);
    expect(Math.abs(r.data[0]! - 127.5)).toBeLessThanOrEqual(0.5);
  });
});

describe("detectDocument", () => {
  const cases: [string, PhotoOpts][] = [
    ["straight on a dark desk", { surface: "dark", quad: Q([[120, 140], [790, 150], [780, 1080], [110, 1070]]) }],
    ["at an angle on wood", { surface: "wood", quad: Q([[180, 120], [760, 210], [840, 1130], [70, 1010]]) }],
    ["tilted on a beige table", { surface: "beige", quad: Q([[260, 90], [830, 300], [660, 1150], [60, 930]]) }],
    ["on blue cloth with a shadow", { surface: "cloth", shadow: true, quad: Q([[90, 100], [820, 80], [860, 1150], [40, 1120]]) }],
    ["under yellow light, with a picture on it", { surface: "wood", cast: [1, 0.93, 0.75], picture: true, quad: Q([[150, 200], [720, 160], [800, 1000], [100, 1060]]) }],
    ["landscape photo", { w: 1200, h: 900, surface: "dark", quad: Q([[300, 60], [930, 110], [900, 860], [270, 840]]) }],
  ];
  for (const [name, opts] of cases) {
    it(`finds the page ${name}`, () => {
      const img = photo(opts);
      const d = detectDocument(img);
      expect(d.found).toBe(true);
      const err = worstError(px(d.quad, img.width, img.height), opts.quad, Math.hypot(img.width, img.height));
      expect(err).toBeLessThan(0.012);
    });
  }

  it("says so when there is no page to find", () => {
    const img = makeImg(400, 300);
    for (let i = 0; i < img.data.length; i += 4) img.data.set([120 + rand() * 20, 120, 120, 255], i);
    expect(detectDocument(img).found).toBe(false);
  });

  it("handles a page that fills the photo", () => {
    const img = photo({ w: 600, h: 800, quad: Q([[-5, -5], [605, -5], [605, 805], [-5, 805]]) });
    const d = detectDocument(img);
    const q = px(d.quad, 600, 800);
    expect(worstError(q, Q([[0, 0], [600, 0], [600, 800], [0, 800]]), 1000)).toBeLessThan(0.02);
  });
});

describe("straighten and clean up", () => {
  const quad = Q([[180, 120], [760, 210], [840, 1130], [70, 1010]]);
  const img = photo({ surface: "wood", quad, shadow: true });
  const size = outputSize(quad, 800);
  const flat = warp(img, quad, size.width, size.height);
  const at = (im: Img, u: number, v: number) => {
    const x = Math.floor(u * im.width), y = Math.floor(v * im.height);
    const i = (y * im.width + x) * 4;
    return 0.299 * im.data[i]! + 0.587 * im.data[i + 1]! + 0.114 * im.data[i + 2]!;
  };

  it("straightens the page so nothing of the table shows", () => {
    for (const [u, v] of [[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]]) {
      expect(at(flat, u!, v!)).toBeGreaterThan(120); // paper (shadowed or not), not wood
    }
    expect(at(flat, 0.3, 0.085)).toBeLessThan(80); // the heading is where it belongs
  });

  it("Auto whitens the paper, including in the shadow, and keeps the text dark", () => {
    const out = applyFilter(warp(img, quad, size.width, size.height), "auto");
    for (const [u, v] of [[0.03, 0.5], [0.95, 0.5], [0.03, 0.97], [0.5, 0.97], [0.95, 0.03]]) {
      expect(at(out, u!, v!), `paper at ${u},${v}`).toBeGreaterThan(240);
    }
    expect(at(out, 0.3, 0.085)).toBeLessThan(60);
  });

  it("Black & white has only black and white, and keeps the text", () => {
    const out = applyFilter(warp(img, quad, size.width, size.height), "bw");
    const values = new Set<number>();
    for (let i = 0; i < out.data.length; i += 4) values.add(out.data[i]!);
    expect([...values].sort()).toEqual([0, 255]);
    expect(at(out, 0.3, 0.085)).toBe(0);
    expect(at(out, 0.5, 0.97)).toBe(255);
  });

  it("Greyscale has no colour", () => {
    const out = applyFilter(warp(img, quad, size.width, size.height), "gray");
    for (let i = 0; i < out.data.length; i += 4 * 97) expect(out.data[i]).toBe(out.data[i + 2]);
  });

  it("doesn't wash out a dark picture printed on the page", () => {
    const q2 = Q([[150, 200], [720, 160], [800, 1000], [100, 1060]]);
    const im = photo({ surface: "wood", picture: true, quad: q2 });
    const s = outputSize(q2, 800);
    const out = applyFilter(warp(im, q2, s.width, s.height), "auto");
    expect(at(out, 0.72, 0.21)).toBeLessThan(150);
  });
});
