import { z } from "zod";

/**
 * Recognised text for one page, in the page's unrotated PDF space.
 * Each word is placed by the start of its baseline (x, y), its width along the
 * baseline, and the line's text direction (unit vector), so text on rotated
 * pages is placed correctly too.
 */
export const OcrWordSchema = z.object({
  text: z.string().min(1).max(200),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  size: z.number().finite().positive().max(500),
});
export const OcrLineSchema = z.object({
  dir: z.tuple([z.number().finite(), z.number().finite()]),
  words: z.array(OcrWordSchema).min(1).max(500),
});
export type OcrWord = z.infer<typeof OcrWordSchema>;
export type OcrLine = z.infer<typeof OcrLineSchema>;

/** Name the text layer's font carries, so the editor can tell OCR text apart. */
export const OCR_FONT_NAME = "PDFInkly-OCR";

