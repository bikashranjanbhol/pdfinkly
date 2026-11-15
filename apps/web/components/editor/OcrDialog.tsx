"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import { OCR_FONT_NAME } from "@pdfinkly/shared";
import { IconX } from "../icons";
import { looksScanned, OCR_LANGS, recognisePages, type OcrLang, type OcrPageInput, type OcrProgress, type OcrResult } from "@/lib/client/ocr";
import { textBlocks } from "./textBlocks";

export interface OcrPageRef {
  ref: string;
  label: string;
  /** Rotation added in the editor (unsaved), on top of the page's own. */
  rotation: number;
  load: () => Promise<PDFPageProxy | null>;
}

/** scan: no text layer; ocr: only text from an earlier OCR run; text: real text. */
type PageKind = "scan" | "ocr" | "text";

async function pageKind(page: PDFPageProxy): Promise<PageKind> {
  if (await looksScanned(page).catch(() => false)) return "scan";
  // Mostly recognised text (a few edited paragraphs may be real text now).
  let ocr = 0, other = 0;
  for (const b of await textBlocks(page)) {
    if (b.font.raw === OCR_FONT_NAME) ocr += b.text.length;
    else other += b.text.length;
  }
  return ocr > other ? "ocr" : "text";
}

const LANG_KEY = "pdfinkly.ocrLangs";
const loadLangs = (): OcrLang[] => {
  try {
    const v = JSON.parse(localStorage.getItem(LANG_KEY) ?? "[]") as string[];
    const ok = v.filter((l): l is OcrLang => l in OCR_LANGS);
    return ok.length ? ok : ["eng"];
  } catch {
    return ["eng"];
  }
};

export function OcrDialog({
  pages,
  unsaved,
  onClose,
  onRecognised,
}: {
  pages: OcrPageRef[];
  unsaved: number;
  onClose: () => void;
  onRecognised: (result: OcrResult, stats: { pages: number; words: number }) => void;
}) {
  const [kinds, setKinds] = useState<Record<string, PageKind> | null>(null);
  const [upright, setUpright] = useState(true);
  const [scope, setScope] = useState<"scanned" | "all">("scanned");
  const [langs, setLangs] = useState<OcrLang[]>(["eng"]);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => setLangs(loadLangs()), []);
  useEffect(() => dialog.current?.focus(), []);

  // Find scanned pages (no text, or only text from an earlier OCR run).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found: Record<string, PageKind> = {};
      for (const p of pages) {
        const page = await p.load().catch(() => null);
        found[p.ref] = page ? await pageKind(page).catch((): PageKind => "text") : "text";
        if (cancelled) return;
      }
      if (!cancelled) {
        setKinds(found);
        setScope(Object.values(found).some((k) => k !== "text") ? "scanned" : "all");
      }
    })();
    return () => { cancelled = true; };
  }, [pages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !progress && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, progress]);

  const scanned = kinds ? pages.filter((p) => kinds[p.ref] !== "text") : null;
  const redo = kinds ? pages.filter((p) => kinds[p.ref] === "ocr").length : 0;
  const withText = kinds ? pages.filter((p) => kinds[p.ref] === "text").length : 0;
  const targets = scope === "all" ? pages : scanned ?? [];

  async function start() {
    setError(null);
    try { localStorage.setItem(LANG_KEY, JSON.stringify(langs)); } catch { /* private mode */ }
    const ac = new AbortController();
    abort.current = ac;
    try {
      const loaded: OcrPageInput[] = [];
      for (const t of targets) {
        const page = await t.load();
        if (page) loaded.push({ ref: t.ref, page, rotation: t.rotation, scanned: kinds?.[t.ref] !== "text" });
      }
      const result = await recognisePages(loaded, langs, setProgress, ac.signal);
      if (!upright) result.turns = {};
      const words = Object.values(result.lines).reduce((n, lines) => n + lines.reduce((m, l) => m + l.words.length, 0), 0);
      if (words === 0) {
        setProgress(null);
        setError("No text was recognised. The pages may be blank, photos, or too blurry. Try a sharper scan.");
        return;
      }
      onRecognised(result, { pages: Object.values(result.lines).filter((l) => l.length).length, words });
    } catch (e) {
      setProgress(null);
      if ((e as { name?: string }).name === "AbortError" || ac.signal.aborted) return;
      setError(e instanceof Error ? `Text recognition failed: ${e.message}` : "Text recognition failed.");
    } finally {
      abort.current = null;
    }
  }

  const pct = progress ? Math.round(progress.fraction * 100) : 0;
  const statusText = !progress ? "" :
    progress.status === "loading" ? "Loading the text recogniser…" :
    progress.status === "rendering" ? `Preparing page ${progress.page + 1} of ${progress.total}…` :
    progress.status === "recognising" ? `Reading page ${progress.page + 1} of ${progress.total}…` :
    progress.status === "orienting" ? `Page ${progress.page + 1} reads poorly; checking if it's sideways…` :
    "Saving…";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ocr-title" className="w-full max-w-[520px] rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 id="ocr-title" className="text-lg font-semibold">Recognise text (OCR)</h2>
            <p className="mt-0.5 text-sm text-zinc-600">Makes scanned pages searchable, copyable and editable. It runs on this device; the document isn&apos;t sent anywhere.</p>
          </div>
          {!progress && <button type="button" aria-label="Close" onClick={onClose} className="btn-ghost min-h-10 px-2.5"><IconX /></button>}
        </div>

        <div className="flex flex-col gap-5 px-6 py-5">
          {progress ? (
            <div className="flex flex-col gap-2" aria-live="polite">
              <div className="flex justify-between text-sm"><span>{statusText}</span><span className="tabular-nums text-zinc-600">{pct}%</span></div>
              <div role="progressbar" aria-label="Recognising text" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.max(3, pct)}%` }} />
              </div>
              <p className="text-[13px] text-zinc-500">The first run downloads the recogniser (about 4 MB plus each language), then it&apos;s cached.</p>
            </div>
          ) : (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-[13px] font-semibold text-zinc-700">Pages</legend>
                {scanned === null ? (
                  <p className="text-sm text-zinc-600">Checking which pages are scans…</p>
                ) : (
                  <>
                    <label className="flex items-center gap-2.5 text-sm">
                      <input type="radio" name="ocr-scope" checked={scope === "scanned"} disabled={scanned.length === 0} onChange={() => setScope("scanned")} />
                      Scanned pages {scanned.length ? `(${scanned.length} of ${pages.length})` : "(none found)"}
                    </label>
                    <label className="flex items-center gap-2.5 text-sm">
                      <input type="radio" name="ocr-scope" checked={scope === "all"} onChange={() => setScope("all")} />
                      All pages ({pages.length})
                    </label>
                    {redo > 0 && (
                      <p className="text-[13px] text-zinc-600">
                        {redo === 1 ? "1 page was" : `${redo} pages were`} recognised before. Recognising again replaces that text.
                      </p>
                    )}
                    {scope === "all" && withText > 0 && (
                      <p className="text-[13px] text-amber-800">Pages that already have real text will get a second text layer, so search may show matches twice.</p>
                    )}
                  </>
                )}
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-[13px] font-semibold text-zinc-700">Languages in the document</legend>
                {(Object.keys(OCR_LANGS) as OcrLang[]).map((l) => (
                  <label key={l} className="flex items-center gap-2.5 text-sm">
                    <input type="checkbox" checked={langs.includes(l)}
                      onChange={(e) => setLangs((cur) => (e.target.checked ? [...new Set([...cur, l])] : cur.filter((x) => x !== l)))} />
                    {OCR_LANGS[l]}
                  </label>
                ))}
                <p className="text-[13px] text-zinc-500">Pick only the languages the pages contain; extra languages make it slower and less accurate. Hindi text becomes searchable and copyable; editing Hindi isn&apos;t supported yet.</p>
              </fieldset>
              <label className="flex items-start gap-2.5 text-sm">
                <input type="checkbox" className="mt-0.5" checked={upright} onChange={(e) => setUpright(e.target.checked)} />
                <span>Turn sideways or upside-down pages upright<span className="block text-[13px] text-zinc-500">Pages are always read in the right direction; this also rotates them in the document.</span></span>
              </label>
              {unsaved > 0 && <p className="rounded-lg bg-zinc-50 px-3 py-2 text-[13px] text-zinc-600">Your {unsaved} unsaved change{unsaved > 1 ? "s" : ""} will be saved in the same new version.</p>}
              {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4">
          {progress ? (
            <button type="button" className="btn-secondary" onClick={() => abort.current?.abort()}>Cancel</button>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={onClose}>Not now</button>
              <button type="button" className="btn-primary" disabled={scanned === null || targets.length === 0 || langs.length === 0} onClick={() => void start()}>
                Recognise text{targets.length ? ` on ${targets.length} page${targets.length > 1 ? "s" : ""}` : ""}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
