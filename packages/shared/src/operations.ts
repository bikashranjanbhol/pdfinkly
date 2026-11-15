import { z } from "zod";

/**
 * The editor never mutates the PDF while you work. It keeps the base version's
 * bytes plus a list of operations, renders them on top, and writes them into
 * the file only on export. Undo, autosave and conflict checks all use the list.
 *
 * Coordinates are PDF points in the page's UNROTATED space, origin bottom-left
 * (pdf-lib's system). Pages are referenced by stable ids, never by index:
 *   "p3"            = page 3 (1-based) of the base version
 *   "b:<id>"        = an inserted blank page
 *   "x:<id>:<n>"    = page n (1-based) of another PDF version merged in
 */

const num = z.number().finite();
export const PageRefSchema = z.string().min(1).max(120);
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const RectSchema = z.object({ x: num, y: num, w: num.nonnegative(), h: num.nonnegative() });
export const PointSchema = z.tuple([num, num]);
export const FontSchema = z.enum(["Helvetica", "TimesRoman", "Courier"]);
/** Typefaces available for redrawing edited text. Carlito/Caladea are metric-compatible with Calibri/Cambria. */
export const FaceSchema = z.enum(["Helvetica", "TimesRoman", "Courier", "Carlito", "Caladea"]);

// Inline images (uploads, signatures) as PNG/JPEG data URLs, capped at ~1.5 MB.
const DataUrlSchema = z
  .string()
  .max(2_000_000)
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/);

export const AnnotationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), rect: RectSchema, text: z.string().max(5000), font: FontSchema, size: num.min(4).max(144), color: ColorSchema }),
  z.object({ kind: z.literal("highlight"), rect: RectSchema, color: ColorSchema }),
  z.object({ kind: z.literal("ink"), strokes: z.array(z.array(num).max(20000)).max(200), width: num.min(0.25).max(48), color: ColorSchema }),
  z.object({ kind: z.literal("rect"), rect: RectSchema, stroke: ColorSchema, fill: ColorSchema.nullable(), width: num.min(0).max(48) }),
  z.object({ kind: z.literal("ellipse"), rect: RectSchema, stroke: ColorSchema, fill: ColorSchema.nullable(), width: num.min(0).max(48) }),
  z.object({ kind: z.literal("line"), from: PointSchema, to: PointSchema, stroke: ColorSchema, width: num.min(0.25).max(48) }),
  z.object({ kind: z.literal("arrow"), from: PointSchema, to: PointSchema, stroke: ColorSchema, width: num.min(0.25).max(48) }),
  z.object({ kind: z.literal("image"), rect: RectSchema, dataUrl: DataUrlSchema }),
  z.object({ kind: z.literal("signature"), rect: RectSchema, dataUrl: DataUrlSchema }),
  z.object({ kind: z.literal("note"), at: PointSchema, text: z.string().max(2000) }),
  z.object({ kind: z.literal("whiteout"), rect: RectSchema }),
  /**
   * Edited text that was already in the PDF. On export the original glyphs under
   * `cover` are deleted from the page's content stream, then `text` is drawn in
   * `rect`, one line per "\n" (wrapped if wider than the box). Lines are placed
   * from `firstBaseline` below the top of `rect`, `lineHeight` apart.
   */
  z.object({
    kind: z.literal("replace"),
    rect: RectSchema,
    cover: z.array(RectSchema).min(1).max(400),
    text: z.string().max(20000),
    original: z.string().max(20000),
    face: FaceSchema,
    bold: z.boolean(),
    italic: z.boolean(),
    size: num.min(2).max(200),
    color: ColorSchema,
    bg: ColorSchema,
    lineHeight: num.min(1).max(600),
    firstBaseline: num.min(0).max(600),
    /** The PDF's own font name, e.g. "BAAAAA+Carlito-Bold" (shown to the user). */
    srcFont: z.string().max(200),
  }),
]);
export type Annotation = z.infer<typeof AnnotationSchema>;
export type AnnotationKind = Annotation["kind"];
export type Rect = z.infer<typeof RectSchema>;
export type FontName = z.infer<typeof FontSchema>;
export type Face = z.infer<typeof FaceSchema>;

const IdSchema = z.string().min(1).max(64);

export const OperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("annot.add"), id: IdSchema, page: PageRefSchema, annot: AnnotationSchema }),
  z.object({ op: z.literal("annot.update"), id: IdSchema, annot: AnnotationSchema }),
  z.object({ op: z.literal("annot.delete"), id: IdSchema }),
  z.object({ op: z.literal("page.move"), page: PageRefSchema, toIndex: z.number().int().min(0) }),
  z.object({ op: z.literal("page.rotate"), page: PageRefSchema, degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }),
  z.object({ op: z.literal("page.delete"), page: PageRefSchema }),
  z.object({
    op: z.literal("page.insertBlank"),
    at: z.number().int().min(0),
    page: PageRefSchema,
    size: z.object({ w: num.positive(), h: num.positive() }),
  }),
  z.object({
    op: z.literal("page.insertFrom"),
    at: z.number().int().min(0),
    /** The other file and version the pages come from (needed to fetch its bytes). */
    fileId: z.string().uuid(),
    versionId: z.string().uuid(),
    pageCount: z.number().int().min(1).max(5000),
    pages: z.array(PageRefSchema).min(1).max(5000),
  }),
  z.object({ op: z.literal("form.set"), field: z.string().min(1).max(500), value: z.union([z.string().max(5000), z.boolean()]) }),
]);
export type Operation = z.infer<typeof OperationSchema>;
export const OperationsSchema = z.array(OperationSchema).max(20000);

/* ------------------------------------------------------------------ model */

export type PageSource =
  | { kind: "base"; index: number } // 0-based page index in the base version
  | { kind: "ext"; versionId: string; index: number }
  | { kind: "blank"; w: number; h: number };

export interface PageEntry {
  ref: string;
  source: PageSource;
  /** Extra rotation added in the editor, on top of the page's own /Rotate. */
  rotation: 0 | 90 | 180 | 270;
}

export interface PlacedAnnotation {
  id: string;
  page: string;
  annot: Annotation;
}

export interface DocModel {
  pages: PageEntry[];
  annotations: PlacedAnnotation[];
  form: Record<string, string | boolean>;
  /** True when pages were moved, rotated, deleted or inserted. */
  structureChanged: boolean;
  /** Versions merged in, which export needs the bytes of. */
  externalVersions: string[];
}

export const basePageRef = (index: number) => `p${index + 1}`;

/** Replay operations over a base document with `basePageCount` pages. Pure. */
export function deriveModel(basePageCount: number, ops: readonly Operation[]): DocModel {
  const pages: PageEntry[] = Array.from({ length: basePageCount }, (_, i) => ({
    ref: basePageRef(i),
    source: { kind: "base", index: i },
    rotation: 0,
  }));
  const annots = new Map<string, PlacedAnnotation>();
  const form: Record<string, string | boolean> = {};
  const external = new Set<string>();
  let structureChanged = false;

  const findPage = (ref: string) => pages.findIndex((p) => p.ref === ref);
  const clampIndex = (i: number, len: number) => Math.max(0, Math.min(i, len));

  for (const op of ops) {
    switch (op.op) {
      case "annot.add":
        if (findPage(op.page) !== -1) annots.set(op.id, { id: op.id, page: op.page, annot: op.annot });
        break;
      case "annot.update": {
        const a = annots.get(op.id);
        if (a) annots.set(op.id, { ...a, annot: op.annot });
        break;
      }
      case "annot.delete":
        annots.delete(op.id);
        break;
      case "page.move": {
        const from = findPage(op.page);
        if (from === -1) break;
        const [entry] = pages.splice(from, 1);
        pages.splice(clampIndex(op.toIndex, pages.length), 0, entry!);
        structureChanged = true;
        break;
      }
      case "page.rotate": {
        const i = findPage(op.page);
        if (i === -1) break;
        const p = pages[i]!;
        p.rotation = (((p.rotation + op.degrees) % 360) as PageEntry["rotation"]);
        structureChanged = true;
        break;
      }
      case "page.delete": {
        const i = findPage(op.page);
        if (i === -1 || pages.length <= 1) break; // a PDF keeps at least one page
        pages.splice(i, 1);
        for (const [id, a] of annots) if (a.page === op.page) annots.delete(id);
        structureChanged = true;
        break;
      }
      case "page.insertBlank":
        if (findPage(op.page) !== -1) break;
        pages.splice(clampIndex(op.at, pages.length), 0, { ref: op.page, source: { kind: "blank", w: op.size.w, h: op.size.h }, rotation: 0 });
        structureChanged = true;
        break;
      case "page.insertFrom": {
        const entries: PageEntry[] = [];
        op.pages.forEach((ref, n) => {
          if (n < op.pageCount && findPage(ref) === -1) {
            entries.push({ ref, source: { kind: "ext", versionId: op.versionId, index: n }, rotation: 0 });
          }
        });
        if (entries.length === 0) break;
        pages.splice(clampIndex(op.at, pages.length), 0, ...entries);
        external.add(op.versionId);
        structureChanged = true;
        break;
      }
      case "form.set":
        form[op.field] = op.value;
        break;
    }
  }

  // Drop merged versions whose pages were all deleted again.
  const stillUsed = new Set(pages.flatMap((p) => (p.source.kind === "ext" ? [p.source.versionId] : [])));
  return {
    pages,
    annotations: [...annots.values()],
    form,
    structureChanged,
    externalVersions: [...external].filter((v) => stillUsed.has(v)),
  };
}

/** Short random id for annotations and inserted pages. */
export function newId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}
