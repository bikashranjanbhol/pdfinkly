"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFPageProxy } from "pdfjs-dist";
import type { OcrLine } from "@pdfinkly/shared";
import { IconX } from "../icons";
import { looksScanned, OCR_LANGS, recognisePages, type OcrLang, type OcrProgress } from "@/lib/client/ocr";

export interface OcrPageRef {
  ref: string;
  label: string;
  load: () => Promise<PDFPageProxy | null>;
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
  onRecognised: (result: Record<string, OcrLine[]>, stats: { pages: number; words: number }) => void;
}) {
  const [scanned, setScanned] = useState<string[] | null>(null);
  const [scope, setScope] = useState<"scanned" | "all">("scanned");
  const [langs, setLangs] = useState<OcrLang[]>(["eng"]);
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => setLangs(loadLangs()), []);
  useEffect(() => dialog.current?.focus(), []);

  // Find pages without text (likely scans).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found: string[] = [];
      for (const p of pages) {
        const page = await p.load().catch(() => null);
        if (page && (await looksScanned(page).catch(() => false))) found.push(p.ref);
        if (cancelled) return;
      }
      if (!cancelled) {
        setScanned(found);
        setScope(found.length ? "scanned" : "all");
      }
    })();
    return () => { cancelled = true; };
  }, [pages]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !progress && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, progress]);

  const targets = scope === "all" ? pages : pages.filter((p) => scanned?.includes(p.ref));

  async function start() {
    setError(null);
    try { localStorage.setItem(LANG_KEY, JSON.stringify(langs)); } catch { /* private mode */ }
    const ac = new AbortController();
    abort.current = ac;
    try {
      const loaded: Array<{ ref: string; page: PDFPageProxy }> = [];
      for (const t of targets) {
        const page = await t.load();
        if (page) loaded.push({ ref: t.ref, page });
      }
      const result = await recognisePages(loaded, langs, setProgress, ac.signal);
      const words = Object.values(result).reduce((n, lines) => n + lines.reduce((m, l) => m + l.words.length, 0), 0);
      if (words === 0) {
        setProgress(null);
        setError("No text was recognised. The pages may be blank, photos, or too blurry. Try a sharper scan.");
        return;
      }
      onRecognised(result, { pages: Object.values(result).filter((l) => l.length).length, words });
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
                      Pages without text {scanned.length ? `(${scanned.length} of ${pages.length})` : "(none found)"}
                    </label>
                    <label className="flex items-center gap-2.5 text-sm">
                      <input type="radio" name="ocr-scope" checked={scope === "all"} onChange={() => setScope("all")} />
                      All pages ({pages.length})
                    </label>
                    {scope === "all" && scanned.length < pages.length && (
                      <p className="text-[13px] text-amber-800">Pages that already have text will get a second text layer, so search may show matches twice.</p>
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
