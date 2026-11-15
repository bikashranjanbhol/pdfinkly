"use client";

import type { PageImage } from "@pdfinkly/shared/export";

/** EXIF orientation (1–8) of a JPEG, or 1 when there's none. */
export function exifOrientation(b: Uint8Array): number {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1]!, len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10; // TIFF header
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
      const u32 = (o: number) => (le ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 : ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0);
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if (marker === 0xda) return 1; // image data starts: no EXIF before it
    i += 2 + len;
  }
  return 1;
}

const encode = (c: HTMLCanvasElement, type: "image/png" | "image/jpeg") =>
  new Promise<Uint8Array>((res, rej) => c.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error("Couldn't encode the picture"))), type, 0.92));

/**
 * A picture ready to be a PDF page: JPEG/PNG kept as they are (no quality
 * loss) unless the photo is stored rotated (EXIF) or in another format, which
 * are redrawn upright and re-encoded.
 */
export async function prepareImage(file: File): Promise<PageImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(/heic|heif/i.test(file.type + file.name) ? `${file.name}: this browser can't read HEIC photos. Save it as JPG first (or use Safari).` : `${file.name} isn't a picture this browser can read.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const upright = !isJpeg || exifOrientation(bytes) === 1;
  try {
    if (isJpeg && upright) return { bytes, type: "jpg", width: bitmap.width, height: bitmap.height };
    if (isPng) return { bytes, type: "png", width: bitmap.width, height: bitmap.height };
    // Rotated JPEGs and other formats: draw upright (createImageBitmap applies EXIF) and re-encode.
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("2d")!.drawImage(bitmap, 0, 0);
    const photo = isJpeg || /webp|avif|jpe?g/i.test(file.type) || c.width * c.height > 2_000_000;
    const out = await encode(c, photo ? "image/jpeg" : "image/png");
    c.width = c.height = 0;
    return { bytes: out, type: photo ? "jpg" : "png", width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
