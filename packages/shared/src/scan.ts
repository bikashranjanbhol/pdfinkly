/**
 * Document scanning: find the sheet of paper in a photo, straighten it, and
 * give it a clean "scanned" look. Pure functions on RGBA pixel buffers, so
 * they run the same in a Web Worker, on the main thread, or in tests.
 */

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
export interface Pt {
  x: number;
  y: number;
}
/** Corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type ScanFilter = "auto" | "gray" | "bw" | "original";

/** Longest side of a straightened page: A4 at 200 dpi. */
export const SCAN_MAX_SIDE = 2339;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function makeImg(width: number, height: number): Img {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/** Shrink so the longer side is at most `maxSide`, averaging the pixels each new pixel covers. */
export function resize(img: Img, maxSide: number): Img {
  const { width: w, height: h, data } = img;
  const s = Math.min(1, maxSide / Math.max(w, h));
  if (s >= 1) return img;
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const out = makeImg(W, H);
  const xs = new Int32Array(W + 1), ys = new Int32Array(H + 1);
  for (let x = 0; x <= W; x++) xs[x] = Math.min(w, Math.round((x * w) / W));
  for (let y = 0; y <= H; y++) ys[y] = Math.min(h, Math.round((y * h) / H));
  for (let Y = 0; Y < H; Y++) {
    const y0 = ys[Y]!, y1 = Math.max(y0 + 1, ys[Y + 1]!);
    for (let X = 0; X < W; X++) {
      const x0 = xs[X]!, x1 = Math.max(x0 + 1, xs[X + 1]!);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; a += data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0), o = (Y * W + X) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
    }
  }
  return out;
}

/** Rotate by quarter turns clockwise. */
export function rotateImg(img: Img, turns: number): Img {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return img;
  const { width: w, height: h, data } = img;
  const W = t === 2 ? w : h, H = t === 2 ? h : w;
  const out = makeImg(W, H);
  const src = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const dst = new Uint32Array(out.data.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [X, Y] = t === 1 ? [h - 1 - y, x] : t === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      dst[Y * W + X] = src[y * w + x]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** 3×3 matrix (row-major) taking the four `from` points to the four `to` points. */
export function homography(from: readonly Pt[], to: readonly Pt[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!, { x: u, y: v } = to[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    if (Math.abs(A[p]![c]!) < 1e-12) throw new Error("degenerate corners");
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      if (f) for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  const h = A.map((row, i) => row[8]! / row[i]!);
  return [...h, 1];
}

export function applyH(H: readonly number[], p: Pt): Pt {
  const d = H[6]! * p.x + H[7]! * p.y + H[8]!;
  return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / d, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / d };
}

export const quadArea = (q: readonly Pt[]) =>
  Math.abs(q.reduce((s, p, i) => { const n = q[(i + 1) % q.length]!; return s + p.x * n.y - n.x * p.y; }, 0)) / 2;

/** Put four points in top-left, top-right, bottom-right, bottom-left order. */
export function orderQuad(pts: readonly Pt[]): Quad {
  const c = { x: pts.reduce((s, p) => s + p.x, 0) / 4, y: pts.reduce((s, p) => s + p.y, 0) / 4 };
  const byAngle = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // Clockwise on screen from the corner nearest the top-left.
  let start = 0;
  byAngle.forEach((p, i) => { if (p.x + p.y < byAngle[start]!.x + byAngle[start]!.y) start = i; });
  const o = [0, 1, 2, 3].map((k) => byAngle[(start + k) % 4]!);
  return [o[0]!, o[1]!, o[2]!, o[3]!];
}

/** Is it a usable page outline: convex, no very sharp or very flat corners? */
export function quadIsSane(q: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4]!, b = q[i]!, c = q[(i + 1) % 4]!;
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cross = v1.x * v2.y - v1.y * v2.x;
    if (cross >= 0) return false; // not clockwise-convex
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)))));
    if (ang < (40 * Math.PI) / 180 || ang > (140 * Math.PI) / 180) return false;
  }
  return true;
}

export const PAPER = { a4: Math.SQRT2, letter: 11 / 8.5 } as const;

/**
 * The page's true width ÷ height, undoing perspective with a pinhole-camera
 * model (Zhang & He, "Whiteboard scanning and image enhancement", 2007):
 * the camera's focal length is recovered from how the edges converge,
 * assuming the photo's centre is the optical centre. Null when the photo is
 * too nearly straight-on for that (then edge lengths are accurate anyway).
 */
export function trueAspect(q: Quad, photoWidth: number, photoHeight: number): number | null {
  const u0 = photoWidth / 2, v0 = photoHeight / 2;
  const m = (p: Pt) => [p.x, p.y, 1] as const;
  const [m1, m2, m4, m3] = [m(q[0]), m(q[1]), m(q[2]), m(q[3])]; // m1 tl, m2 tr, m3 bl, m4 br
  const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const [a, b] = [n2, n3] as [number[], number[]];
  if (Math.abs(a[2]!) < 1e-9 || Math.abs(b[2]!) < 1e-9) return null;
  const f2 = -(
    (a[0]! * b[0]! - (a[0]! * b[2]! + a[2]! * b[0]!) * u0 + a[2]! * b[2]! * u0 * u0) +
    (a[1]! * b[1]! - (a[1]! * b[2]! + a[2]! * b[1]!) * v0 + a[2]! * b[2]! * v0 * v0)
  ) / (a[2]! * b[2]!);
  const longSide = Math.max(photoWidth, photoHeight);
  // Phone cameras: focal length roughly 0.6–2 × the photo's long side. Outside that, the
  // perspective is too slight to measure.
  if (!(f2 > (0.4 * longSide) ** 2 && f2 < (4 * longSide) ** 2)) return null;
  const f = Math.sqrt(f2);
  // nᵀ (A⁻ᵀ A⁻¹) n with A the camera matrix.
  const norm = (n: number[]) => {
    const x = (n[0]! - u0 * n[2]!) / f, y = (n[1]! - v0 * n[2]!) / f;
    return x * x + y * y + n[2]! * n[2]!;
  };
  const r = Math.sqrt(norm(a) / norm(b));
  return Number.isFinite(r) && r > 0.1 && r < 10 ? r : null;
}

/**
 * Size of the straightened page: its proportions from the camera model when
 * the photo's size is known (else from the longer of each pair of opposite
 * edges), snapped to A4 or Letter when within 4% of them.
 */
export function outputSize(
  q: Quad,
  maxSide = SCAN_MAX_SIDE,
  photo?: { width: number; height: number },
): { width: number; height: number; paper: keyof typeof PAPER | null } {
  let w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const aspect = photo ? trueAspect(q, photo.width, photo.height) : null;
  if (aspect) {
    // Keep the longer measured side; the other follows from the true proportions.
    if (h >= w) w = h * aspect; else h = w / aspect;
  }
  let paper: keyof typeof PAPER | null = null;
  const long = Math.max(w, h), short = Math.min(w, h);
  for (const [k, r] of Object.entries(PAPER) as [keyof typeof PAPER, number][]) {
    if (Math.abs(long / short / r - 1) < 0.04) {
      paper = k;
      if (h >= w) h = w * r; else w = h * r;
      break;
    }
  }
  const s = Math.min(maxSide / Math.max(w, h), 1.25);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)), paper };
}

/** Pull the corners in a little (a fraction of each side) so no sliver of the table shows at the page edge. */
export function insetQuad(q: Quad, frac = 0.004): Quad {
  const c = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
  return q.map((p) => ({ x: p.x + (c.x - p.x) * frac * 2, y: p.y + (c.y - p.y) * frac * 2 })) as Quad;
}

/** Straighten: map the quad (pixels in `src`) onto a width × height rectangle, bilinear sampling. */
export function warp(src: Img, q: Quad, width: number, height: number): Img {
  const H = homography([{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }], q);
  const out = makeImg(width, height);
  const { data: s, width: sw, height: sh } = src;
  const d = out.data;
  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    let nx = H[0]! * 0.5 + H[1]! * py + H[2]!, ny = H[3]! * 0.5 + H[4]! * py + H[5]!, dd = H[6]! * 0.5 + H[7]! * py + H[8]!;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const fx = Math.min(sw - 1, Math.max(0, nx / dd - 0.5)), fy = Math.min(sh - 1, Math.max(0, ny / dd - 0.5));
      const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c]! + (s[i10 + c]! - s[i00 + c]!) * ax;
        const bot = s[i01 + c]! + (s[i11 + c]! - s[i01 + c]!) * ax;
        d[o + c] = top + (bot - top) * ay;
      }
      d[o + 3] = 255;
      nx += H[0]!; ny += H[3]!; dd += H[6]!;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding the page
// ---------------------------------------------------------------------------

function boxBlur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && x + r >= 0) { s += a[y * w + x + r]!; n++; }
      if (x - r - 1 >= 0 && x - r - 1 < w) { s -= a[y * w + x - r - 1]!; n--; }
      if (x >= 0 && x < w) tmp[y * w + x] = s / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && y + r >= 0) { s += tmp[(y + r) * w + x]!; n++; }
      if (y - r - 1 >= 0 && y - r - 1 < h) { s -= tmp[(y - r - 1) * w + x]!; n--; }
      if (y >= 0 && y < h) out[y * w + x] = s / n;
    }
  }
  return out;
}

function otsu(values: ArrayLike<number>): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, values[i]! | 0))]!++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

/** Morphological open (erode then dilate) of a 0/1 mask with a square of radius r. */
function openMask(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, erode: boolean) => {
    const I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += src[y * w + x]!;
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1]! + row;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        const s = I[y1 * (w + 1) + x1]! - I[y0 * (w + 1) + x1]! - I[y1 * (w + 1) + x0]! + I[y0 * (w + 1) + x0]!;
        out[y * w + x] = erode ? (s === (y1 - y0) * (x1 - x0) ? 1 : 0) : s > 0 ? 1 : 0;
      }
    }
    return out;
  };
  return pass(pass(m, true), false);
}

/** The biggest region of the mask (favouring one under the centre), with its holes filled. */
function mainRegion(m: Uint8Array, w: number, h: number): { mask: Uint8Array; area: number } {
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = -1, bestScore = 0, bestArea = 0, n = 0;
  const cx = w >> 1, cy = h >> 1;
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!m[s0] || label[s0]! >= 0) continue;
    let sp = 0, area = 0, centre = false;
    stack[sp++] = s0;
    label[s0] = n;
    while (sp) {
      const p = stack[--sp]!;
      area++;
      const x = p % w, y = (p / w) | 0;
      if (Math.abs(x - cx) <= w * 0.1 && Math.abs(y - cy) <= h * 0.1) centre = true;
      if (x > 0 && m[p - 1] && label[p - 1]! < 0) { label[p - 1] = n; stack[sp++] = p - 1; }
      if (x < w - 1 && m[p + 1] && label[p + 1]! < 0) { label[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && m[p - w] && label[p - w]! < 0) { label[p - w] = n; stack[sp++] = p - w; }
      if (y < h - 1 && m[p + w] && label[p + w]! < 0) { label[p + w] = n; stack[sp++] = p + w; }
    }
    const score = area * (centre ? 2 : 1);
    if (score > bestScore) { bestScore = score; best = n; bestArea = area; }
    n++;
  }
  const mask = new Uint8Array(w * h);
  if (best < 0) return { mask, area: 0 };
  for (let i = 0; i < w * h; i++) if (label[i] === best) mask[i] = 1;
  // Fill holes: anything not reachable from the border without crossing the region.
  const outside = new Uint8Array(w * h);
  let sp = 0;
  const push = (p: number) => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp]!, x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  let area = 0;
  for (let i = 0; i < w * h; i++) if (!outside[i]) { mask[i] = 1; area++; }
  void bestArea;
  return { mask, area };
}

function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const tri = (a: Pt, b: Pt, c: Pt) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;

/** The largest quadrilateral with corners on the hull. */
function largestQuad(hull: Pt[]): Pt[] | null {
  let H = hull;
  if (H.length > 100) { const k = Math.ceil(H.length / 100); H = H.filter((_, i) => i % k === 0); }
  const n = H.length;
  if (n < 4) return null;
  let best = 0, q: Pt[] | null = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      let bj = -1, bja = -1;
      for (let j = i + 1; j < k; j++) { const a = tri(H[i]!, H[j]!, H[k]!); if (a > bja) { bja = a; bj = j; } }
      let bl = -1, bla = -1;
      for (let l = k + 1; l < n + i; l++) { const a = tri(H[k]!, H[l % n]!, H[i]!); if (a > bla) { bla = a; bl = l % n; } }
      if (bj < 0 || bl < 0) continue;
      if (bja + bla > best) { best = bja + bla; q = [H[i]!, H[bj]!, H[k]!, H[bl]!]; }
    }
  }
  return q;
}

/** Fit straight lines to the region's outline along each side, and meet them at the corners. */
function refineQuad(q: Quad, edge: Pt[], diag: number): Quad {
  const lines: { p: Pt; d: Pt }[] = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s]!, b = q[(s + 1) % 4]!;
    const len = dist(a, b);
    const dx = (b.x - a.x) / len, dy = (b.y - a.y) / len;
    const near: Pt[] = [];
    for (const p of edge) {
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
      if (t < 0.12 || t > 0.88) continue;
      if (Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) <= Math.max(1.5, diag * 0.012)) near.push(p);
    }
    if (near.length < 6) { lines.push({ p: a, d: { x: dx, y: dy } }); continue; }
    const mx = near.reduce((s2, p) => s2 + p.x, 0) / near.length, my = near.reduce((s2, p) => s2 + p.y, 0) / near.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of near) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let d = { x: Math.cos(ang), y: Math.sin(ang) };
    if (d.x * dx + d.y * dy < 0) d = { x: -d.x, y: -d.y };
    lines.push({ p: { x: mx, y: my }, d });
  }
  const out: Pt[] = [];
  for (let c = 0; c < 4; c++) {
    const l1 = lines[(c + 3) % 4]!, l2 = lines[c]!;
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    let p = q[c]!;
    if (Math.abs(den) > 1e-6) {
      const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
      const cand = { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
      if (dist(cand, p) < diag * 0.06) p = cand;
    }
    out.push(p);
  }
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

export interface Detection {
  /** Corners as fractions of the photo's width and height. */
  quad: Quad;
  /** False when no clear page edge was found (the quad is then a default inset). */
  found: boolean;
}

export const DEFAULT_QUAD: Quad = [
  { x: 0.04, y: 0.04 }, { x: 0.96, y: 0.04 }, { x: 0.96, y: 0.96 }, { x: 0.04, y: 0.96 },
];

interface Edges { mag: Float32Array; ux: Float32Array; uy: Float32Array; thr: number; w: number; h: number }

/** Gradients of brightness and of "paperness" (whichever is stronger at each pixel). */
function edgeMap(L: Float32Array, P: Float32Array, w: number, h: number): Edges {
  const mag = new Float32Array(w * h), ux = new Float32Array(w * h), uy = new Float32Array(w * h);
  const sobel = (a: Float32Array, i: number) => {
    const gx = a[i - w + 1]! + 2 * a[i + 1]! + a[i + w + 1]! - a[i - w - 1]! - 2 * a[i - 1]! - a[i + w - 1]!;
    const gy = a[i + w - 1]! + 2 * a[i + w]! + a[i + w + 1]! - a[i - w - 1]! - 2 * a[i - w]! - a[i - w + 1]!;
    return [gx, gy] as const;
  };
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let [gx, gy] = sobel(L, i);
    const [px, py] = sobel(P, i);
    if (px * px + py * py > gx * gx + gy * gy) { gx = px; gy = py; }
    const m = Math.hypot(gx, gy);
    mag[i] = m;
    if (m > 0) { ux[i] = gx / m; uy[i] = gy / m; }
  }
  const sorted = Float32Array.from(mag).sort();
  // Low enough for a faint page border, but above sensor noise and wood grain; never set by dense text.
  const thr = Math.min(80, Math.max(30, sorted[Math.floor(sorted.length * 0.8)]! * 1.2));
  return { mag, ux, uy, thr, w, h };
}

/**
 * How much of each side of the quad runs along a real edge (a strong gradient
 * across the side, within two pixels). Returns the weakest side's share and the mean.
 */
function edgeSupport(q: Quad, E: Edges): { min: number; mean: number } {
  const per: number[] = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s]!, b = q[(s + 1) % 4]!;
    const len = dist(a, b);
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const K = 40;
    let hits = 0, n = 0;
    for (let k = 0; k < K; k++) {
      const t = 0.04 + (0.92 * k) / (K - 1);
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x < 1 || y < 1 || x >= E.w - 1 || y >= E.h - 1) continue; // off the photo: not counted either way
      n++;
      for (let d = -2; d <= 2; d++) {
        const X = Math.round(x + nx * d), Y = Math.round(y + ny * d);
        if (X < 1 || Y < 1 || X >= E.w - 1 || Y >= E.h - 1) continue;
        const i = Y * E.w + X;
        if (E.mag[i]! >= E.thr && Math.abs(E.ux[i]! * nx + E.uy[i]! * ny) > 0.85) { hits++; break; }
      }
    }
    per.push(n >= K * 0.5 ? hits / n : 0);
  }
  return { min: Math.min(...per), mean: per.reduce((x, y) => x + y, 0) / 4 };
}

/** Straight lines through the edges (Hough transform, each edge pixel voting along its own direction). */
function houghLines(E: Edges, count: number): { th: number; rho: number }[] {
  const { w, h } = E;
  const diag = Math.ceil(Math.hypot(w, h));
  const NT = 180, NR = 2 * diag + 1;
  const acc = new Float32Array(NT * NR);
  const cos = new Float32Array(NT), sin = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { cos[t] = Math.cos((t * Math.PI) / NT); sin[t] = Math.sin((t * Math.PI) / NT); }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (E.mag[i]! < E.thr) continue;
    let th = Math.round((Math.atan2(E.uy[i]!, E.ux[i]!) * NT) / Math.PI);
    th = ((th % NT) + NT) % NT;
    for (let d = -3; d <= 3; d++) {
      const t = (th + d + NT) % NT;
      const r = Math.round(x * cos[t]! + y * sin[t]!) + diag;
      acc[t * NR + r]! += 1;
    }
  }
  const lines: { th: number; rho: number }[] = [];
  for (let k = 0; k < count; k++) {
    let bi = 0;
    for (let i = 1; i < acc.length; i++) if (acc[i]! > acc[bi]!) bi = i;
    if (acc[bi]! < Math.min(w, h) * 0.15) break;
    const t = Math.floor(bi / NR), r = (bi % NR) - diag;
    lines.push({ th: (t * Math.PI) / NT, rho: r });
    // Suppress this line's neighbourhood (angles wrap round at 180°, with rho changing sign).
    for (let dt = -8; dt <= 8; dt++) {
      let tt = t + dt, rr = r;
      if (tt < 0) { tt += NT; rr = -r; } else if (tt >= NT) { tt -= NT; rr = -r; }
      for (let dr = -10; dr <= 10; dr++) {
        const ri = rr + dr + diag;
        if (ri >= 0 && ri < NR) acc[tt * NR + ri] = 0;
      }
    }
  }
  return lines;
}

function meet(a: { th: number; rho: number }, b: { th: number; rho: number }): Pt | null {
  const ca = Math.cos(a.th), sa = Math.sin(a.th), cb = Math.cos(b.th), sb = Math.sin(b.th);
  const det = ca * sb - sa * cb;
  if (Math.abs(det) < 0.2) return null; // nearly parallel
  return { x: (a.rho * sb - b.rho * sa) / det, y: (ca * b.rho - cb * a.rho) / det };
}

/** Four-sided outlines made from the strongest straight edges. */
function lineQuads(E: Edges): Quad[] {
  const L = houghLines(E, 14);
  const out: Quad[] = [];
  const mx = E.w * 0.03, my = E.h * 0.03;
  const inside = (p: Pt) => p.x >= -mx && p.y >= -my && p.x <= E.w + mx && p.y <= E.h + my;
  for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length; b++)
    for (let c = b + 1; c < L.length; c++) for (let d = c + 1; d < L.length; d++) {
      const four = [L[a]!, L[b]!, L[c]!, L[d]!];
      // The three ways to split four lines into two pairs of opposite sides.
      for (const [p1, p2, p3, p4] of [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]] as const) {
        const corners = [meet(four[p1]!, four[p3]!), meet(four[p3]!, four[p2]!), meet(four[p2]!, four[p4]!), meet(four[p4]!, four[p1]!)];
        if (corners.some((p) => !p || !inside(p))) continue;
        const q = orderQuad(corners as Pt[]);
        if (quadIsSane(q) && quadArea(q) > E.w * E.h * 0.08) out.push(q);
      }
    }
  return out;
}

/**
 * Sharpen the corners at higher resolution: along each side, find where
 * brightness changes fastest across it (to a fraction of a pixel), fit a
 * straight line through those points (dropping outliers), and meet the lines.
 */
export function refineCorners(src: Img, q: Quad): Quad {
  const img = resize(src, 1400);
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) lum[i] = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
  const L = boxBlur(lum, w, h, 1);
  const at = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return NaN;
    const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
    return (L[i]! * (1 - ax) + L[i + 1]! * ax) * (1 - ay) + (L[i + w]! * (1 - ax) + L[i + w + 1]! * ax) * ay;
  };
  const Q = q.map((p) => ({ x: p.x * w, y: p.y * h })) as Quad;
  const diag = Math.hypot(w, h), R = Math.max(6, diag * 0.012);
  const lines: { p: Pt; d: Pt }[] = [];
  for (let sIdx = 0; sIdx < 4; sIdx++) {
    const a = Q[sIdx]!, b = Q[(sIdx + 1) % 4]!;
    const len = dist(a, b), dx = (b.x - a.x) / len, dy = (b.y - a.y) / len, nx = -dy, ny = dx;
    let pts: Pt[] = [];
    for (let k = 0; k < 80; k++) {
      const t = 0.06 + (0.88 * k) / 79;
      const cx = a.x + (b.x - a.x) * t, cy = a.y + (b.y - a.y) * t;
      let best = 0, bo = 0;
      const prof: number[] = [];
      for (let o = -R; o <= R; o += 0.5) prof.push(at(cx + nx * o, cy + ny * o));
      for (let i = 1; i < prof.length - 1; i++) {
        const d = Math.abs(prof[i + 1]! - prof[i - 1]!);
        if (d > best) { best = d; bo = i; }
      }
      if (!(best > 6) || bo < 2 || bo > prof.length - 3) continue;
      // Sub-pixel: the peak of a parabola through the gradient here and either side.
      const g = (i: number) => Math.abs(prof[i + 1]! - prof[i - 1]!);
      const gm = g(bo - 1), gp = g(bo + 1), curve = gm - 2 * best + gp;
      const frac = curve < 0 ? Math.max(-0.5, Math.min(0.5, (gm - gp) / (2 * curve))) : 0;
      const o = -R + (bo + frac) * 0.5;
      pts.push({ x: cx + nx * o, y: cy + ny * o });
    }
    const fit = (ps: Pt[]) => {
      const mx = ps.reduce((s2, p) => s2 + p.x, 0) / ps.length, my = ps.reduce((s2, p) => s2 + p.y, 0) / ps.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of ps) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { p: { x: mx, y: my }, d: { x: Math.cos(ang), y: Math.sin(ang) } };
    };
    if (pts.length < 20) { lines.push({ p: a, d: { x: dx, y: dy } }); continue; }
    let line = fit(pts);
    for (let iter = 0; iter < 2; iter++) {
      const res = pts.map((p) => Math.abs((p.x - line.p.x) * line.d.y - (p.y - line.p.y) * line.d.x));
      const med = [...res].sort((x, y) => x - y)[res.length >> 1]!;
      const keep = pts.filter((_, i) => res[i]! <= Math.max(1, 2.5 * med));
      if (keep.length < 15) break;
      pts = keep;
      line = fit(pts);
    }
    lines.push(line);
  }
  const out: Pt[] = [];
  for (let c = 0; c < 4; c++) {
    const l1 = lines[(c + 3) % 4]!, l2 = lines[c]!;
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x;
    let p = Q[c]!;
    if (Math.abs(den) > 1e-6) {
      const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den;
      const cand = { x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t };
      if (dist(cand, p) < diag * 0.02) p = cand;
    }
    out.push({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) });
  }
  const r = out as Quad;
  return quadIsSane(r) ? r : q;
}

/**
 * Find the sheet of paper. Two kinds of candidate outline: the bright,
 * colourless region (paper against a darker or colourful surface) and
 * four-sided shapes made of the strongest straight edges (which shadows
 * and light-coloured tables don't fool). The outline whose sides best follow
 * real edges wins, bigger ones preferred.
 */
export function detectDocument(src: Img, debug?: (c: { quad: Quad; min: number; mean: number; area: number; kind: string }) => void): Detection {
  const img = resize(src, 360);
  const { width: w, height: h, data } = img;
  const diag = Math.hypot(w, h);
  const raw = new Float32Array(w * h), lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = data[p]!, g = data[p + 1]!, b = data[p + 2]!;
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    lum[i] = L;
    raw[i] = L - (Math.max(r, g, b) - Math.min(r, g, b));
  }
  const P = boxBlur(boxBlur(raw, w, h, 2), w, h, 1);
  const E = edgeMap(boxBlur(lum, w, h, 1), boxBlur(raw, w, h, 1), w, h);

  const candidates: Quad[] = [];
  let fullFrame: Quad | null = null;
  const t0 = otsu(P);
  for (const t of [t0, t0 + 15, t0 - 15, t0 + 30]) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = P[i]! > t ? 1 : 0;
    const { mask, area } = mainRegion(openMask(m, w, h, 2), w, h);
    if (area < w * h * 0.05) continue;
    const edge: Pt[] = [];
    for (let y = 0; y < h; y++) {
      let l = -1, r = -1;
      for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (l < 0) l = x; r = x; }
      if (l >= 0) edge.push({ x: l, y: y + 0.5 }, { x: r + 1, y: y + 0.5 });
    }
    for (let x = 0; x < w; x++) {
      let tp = -1, bt = -1;
      for (let y = 0; y < h; y++) if (mask[y * w + x]) { if (tp < 0) tp = y; bt = y; }
      if (tp >= 0) edge.push({ x: x + 0.5, y: tp }, { x: x + 0.5, y: bt + 1 });
    }
    const raw4 = largestQuad(convexHull(edge));
    if (!raw4) continue;
    let quad = refineQuad(orderQuad(raw4), edge, diag);
    quad = quad.map((p) => ({ x: Math.min(w, Math.max(0, p.x)), y: Math.min(h, Math.max(0, p.y)) })) as Quad;
    if (!quadIsSane(quad)) continue;
    candidates.push(quad);
    // A page filling the whole photo has no edges to follow: accept it if it looks like paper.
    const qa = quadArea(quad), frac = qa / (w * h), fill = area / qa;
    if (frac > 0.93 && fill > 0.9 && !fullFrame) {
      let s = 0;
      for (let i = 0; i < w * h; i++) s += P[i]!;
      if (s / (w * h) > 150) fullFrame = quad;
    }
  }
  const nRegion = candidates.length;
  candidates.push(...lineQuads(E));

  let best: { quad: Quad; score: number } | null = null;
  for (const q of candidates) {
    const sup = edgeSupport(q, E);
    debug?.({ quad: q, ...sup, area: quadArea(q) / (w * h), kind: candidates.indexOf(q) < nRegion ? "region" : "lines" });
    if (sup.min < 0.45 || sup.mean < 0.6) continue;
    const score = sup.mean * Math.sqrt(quadArea(q) / (w * h));
    if (!best || score > best.score) best = { quad: q, score };
  }
  const chosen = best?.quad ?? fullFrame;
  if (!chosen) return { quad: DEFAULT_QUAD.map((p) => ({ ...p })) as Quad, found: false };
  const quad = chosen.map((p) => ({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) })) as Quad;
  return { quad: best ? refineCorners(src, quad) : quad, found: true };
}

// ---------------------------------------------------------------------------
// The scanned look
// ---------------------------------------------------------------------------

/**
 * Estimate the paper's colour everywhere on the page (lighting, shadows,
 * colour cast) on a coarse grid: the brightest pixels of each cell, then the
 * median of each neighbourhood so bold text doesn't count, smoothed, and never
 * much darker than the wider area (so a dark photo on the page isn't taken for shadow).
 */
function paperColour(img: Img): { grid: Float32Array; gw: number; gh: number; cell: number } {
  const { width: w, height: h, data } = img;
  const cell = Math.max(8, Math.round(Math.min(w, h) / 40));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  let grid = new Float32Array(gw * gh * 4); // r, g, b, luminance
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * cell, y0 = gy * cell, x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
      let maxL = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4, L = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        if (L > maxL) maxL = L;
      }
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4, L = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        if (L >= maxL - 18) { r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++; }
      }
      const o = (gy * gw + gx) * 4;
      grid[o] = r / n; grid[o + 1] = g / n; grid[o + 2] = b / n; grid[o + 3] = 0.299 * grid[o]! + 0.587 * grid[o + 1]! + 0.114 * grid[o + 2]!;
    }
  }
  // Each cell takes the median of its neighbourhood: cells covered by bold text or a
  // thick line are outvoted by the paper around them, while gradual shadows are kept.
  const median = (g: Float32Array) => {
    const out = new Float32Array(g.length);
    const idx: number[] = [];
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      idx.length = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < gw && Y < gh) idx.push((Y * gw + X) * 4);
      }
      idx.sort((a, b) => g[a + 3]! - g[b + 3]!);
      const m = idx[idx.length >> 1]!;
      out.set(g.subarray(m, m + 4), (y * gw + x) * 4);
    }
    return out;
  };
  grid = median(grid);
  const blurGrid = (g: Float32Array, r: number) => {
    const out = new Float32Array(g.length);
    for (let c = 0; c < 4; c++) {
      const ch = new Float32Array(gw * gh);
      for (let i = 0; i < gw * gh; i++) ch[i] = g[i * 4 + c]!;
      const b = boxBlur(ch, gw, gh, r);
      for (let i = 0; i < gw * gh; i++) out[i * 4 + c] = b[i]!;
    }
    return out;
  };
  const wide = blurGrid(grid, 6);
  for (let i = 0; i < gw * gh * 4; i++) grid[i] = Math.max(grid[i]!, wide[i]! * 0.72);
  grid = blurGrid(blurGrid(grid, 1), 1);
  return { grid, gw, gh, cell };
}

/** Divide out the paper colour: the page becomes white, shadows and colour casts go. */
function flatten(img: Img): Img {
  const { width: w, height: h, data } = img;
  const { grid, gw, gh, cell } = paperColour(img);
  const out = makeImg(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const gyf = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const gy0 = gyf | 0, gy1 = Math.min(gh - 1, gy0 + 1), ay = gyf - gy0;
    for (let x = 0; x < w; x++) {
      const gxf = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const gx0 = gxf | 0, gx1 = Math.min(gw - 1, gx0 + 1), ax = gxf - gx0;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = grid[(gy0 * gw + gx0) * 4 + c]!, b = grid[(gy0 * gw + gx1) * 4 + c]!;
        const cc = grid[(gy1 * gw + gx0) * 4 + c]!, dd = grid[(gy1 * gw + gx1) * 4 + c]!;
        const bg = (a + (b - a) * ax) * (1 - ay) + (cc + (dd - cc) * ax) * ay;
        d[i + c] = (data[i + c]! * 255) / Math.max(24, bg);
      }
      d[i + 3] = 255;
    }
  }
  return out;
}

/** Tone curve for the cleaned page: near-white becomes white, ink gets darker. */
const CURVE = (() => {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - 28) / (232 - 28)));
    lut[v] = Math.round(255 * Math.pow(t, 1.25));
  }
  return lut;
})();

/** The finished look of a straightened page. */
export function applyFilter(img: Img, f: ScanFilter): Img {
  if (f === "original") return img;
  const flat = flatten(img);
  const d = flat.data, n = flat.width * flat.height;
  if (f === "auto") {
    for (let i = 0; i < n * 4; i += 4) {
      const r = CURVE[d[i]! | 0]!, g = CURVE[d[i + 1]! | 0]!, b = CURVE[d[i + 2]! | 0]!;
      // A little more colour, so stamps, signatures and highlights stay visible.
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = clamp255(L + (r - L) * 1.2); d[i + 1] = clamp255(L + (g - L) * 1.2); d[i + 2] = clamp255(L + (b - L) * 1.2);
    }
    return flat;
  }
  const L = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) L[i] = 0.299 * d[p]! + 0.587 * d[p + 1]! + 0.114 * d[p + 2]!;
  if (f === "gray") {
    for (let i = 0, p = 0; i < n; i++, p += 4) d[p] = d[p + 1] = d[p + 2] = CURVE[Math.min(255, L[i]!) | 0]!;
    return flat;
  }
  // Black & white: one threshold for the (now evenly lit) page, between ink and paper,
  // then lone specks are cleaned away.
  const W = flat.width, Hh = flat.height;
  let ink = 0, inkN = 0;
  for (let i = 0; i < n; i++) if (L[i]! < 200) { ink += L[i]!; inkN++; }
  const inkMean = inkN ? ink / inkN : 100;
  const t = Math.min(210, Math.max(125, inkMean + (245 - inkMean) * 0.45));
  const bw = new Uint8Array(n);
  for (let i = 0; i < n; i++) bw[i] = L[i]! < t ? 1 : 0;
  for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (!bw[i]) continue;
    const nb = bw[i - 1]! + bw[i + 1]! + bw[i - W]! + bw[i + W]! + bw[i - W - 1]! + bw[i - W + 1]! + bw[i + W - 1]! + bw[i + W + 1]!;
    if (nb === 0) bw[i] = 0;
  }
  for (let i = 0, p = 0; i < n; i++, p += 4) d[p] = d[p + 1] = d[p + 2] = bw[i] ? 0 : 255;
  return flat;
}
