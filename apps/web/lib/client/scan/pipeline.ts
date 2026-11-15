/**
 * Turning a photo into a scanned page. Runs in the scan worker (with
 * OffscreenCanvas) or, where workers can't draw, on the page itself.
 */
import {
  applyFilter, detectDocument, insetQuad, outputSize, rotateImg, resize, warp,
  type Img, type Quad, type ScanFilter,
} from "@pdfinkly/shared/scan";

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function canvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

const ctx2d = (c: AnyCanvas) => c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Decode (turned upright from the camera's EXIF tag), at most `maxSide` pixels on the longer side. */
async function decode(blob: Blob, maxSide: number): Promise<{ img: Img; natural: { width: number; height: number } }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This browser can't read that picture. Try a JPG or PNG.");
  }
  const natural = { width: bmp.width, height: bmp.height };
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = canvas(w, h);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;
  return { img: { data, width: w, height: h }, natural };
}

async function encode(img: Img, quality: number): Promise<Blob> {
  const c = canvas(img.width, img.height);
  ctx2d(c).putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const blob =
    "convertToBlob" in c
      ? await c.convertToBlob({ type: "image/jpeg", quality })
      : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("Couldn't save the page."))), "image/jpeg", quality));
  c.width = c.height = 0;
  return blob;
}

export interface Analysis {
  quad: Quad;
  found: boolean;
  /** Upright photo size. */
  width: number;
  height: number;
  /** The photo at a size good for adjusting corners on screen. */
  preview: Blob;
}

/** Find the page in a photo. */
export async function analyse(blob: Blob): Promise<Analysis> {
  const { img, natural } = await decode(blob, 1400);
  const { quad, found } = detectDocument(img);
  return { quad, found, ...natural, preview: await encode(img, 0.82) };
}

export interface Rendered {
  jpeg: Blob;
  width: number;
  height: number;
  thumb: Blob;
}

/** JPEG quality per look: black & white compresses well, colour needs a little more. */
const QUALITY: Record<ScanFilter, number> = { auto: 0.8, gray: 0.78, bw: 0.72, original: 0.85 };

/** Straighten and clean up one page. `quad` is in fractions of the upright photo. */
export async function render(blob: Blob, quad: Quad, filter: ScanFilter, turns: number, photo: { width: number; height: number }): Promise<Rendered> {
  const W = photo.width, H = photo.height;
  const qNat = quad.map((p) => ({ x: p.x * W, y: p.y * H })) as Quad;
  const size = outputSize(qNat, undefined, photo);
  // Decode only as large as needed: the page area about 1.4× the output, never more than the photo.
  const qLong = Math.max(...[0, 1, 2, 3].map((i) => Math.hypot(qNat[i]!.x - qNat[(i + 1) % 4]!.x, qNat[i]!.y - qNat[(i + 1) % 4]!.y)));
  const scale = Math.min(1, (1.4 * Math.max(size.width, size.height)) / qLong);
  const { img } = await decode(blob, Math.max(W, H) * scale);
  const q = insetQuad(quad.map((p) => ({ x: p.x * img.width, y: p.y * img.height })) as Quad);
  let page = applyFilter(warp(img, q, size.width, size.height), filter);
  page = rotateImg(page, turns);
  const [jpeg, thumb] = [await encode(page, QUALITY[filter]), await encode(resize(page, 420), 0.75)];
  return { jpeg, width: page.width, height: page.height, thumb };
}
