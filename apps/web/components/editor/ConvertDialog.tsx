"use client";

import { useEffect, useRef, useState } from "react";
import { saveBytes } from "@/lib/client/api";
import { convertPdf, countScannedPages, FORMAT_INFO, type ConvertFormat } from "@/lib/client/convert";
import { OCR_LANGS, type OcrLang } from "@/lib/client/ocr";
import { IconX } from "../icons";

const CHOICES: Array<{ id: "docx" | "xlsx" | "pptx" | "img"; title: string; note: string }> = [
  { id: "docx", title: "Word", note: "Editable text with its fonts, plus the pictures" },
  { id: "xlsx", title: "Excel", note: "Tables and amounts as rows, columns and numbers" },
  { id: "pptx", title: "PowerPoint", note: "A slide per page, text in editable boxes" },
  { id: "img", title: "Images", note: "A JPG or PNG of every page" },
];

/** Convert the PDF (as it is now, with unsaved edits) to Word, Excel, PowerPoint or images. */
export function ConvertDialog({ fileName, getBytes, onClose }: { fileName: string; getBytes: () => Promise<Uint8Array>; onClose: () => void }) {
  const [source, setSource] = useState<Uint8Array | null>(null);
  const [scanned, setScanned] = useState<number | null>(null);
  const [choice, setChoice] = useState<(typeof CHOICES)[number]["id"]>("docx");
  const [imgType, setImgType] = useState<"jpg" | "png">("jpg");
  const [dpi, setDpi] = useState(150);
  const [ocr, setOcr] = useState(true);
  const [langs, setLangs] = useState<OcrLang[]>(() => {
    try { return (JSON.parse(localStorage.getItem("pdfinkly.ocrLangs") ?? "") as OcrLang[]).filter((l) => l in OCR_LANGS); } catch { return ["eng"]; }
  });
  const [progress, setProgress] = useState<{ f: number; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getBytes()
      .then(async (b) => { if (!live) return; setSource(b); const n = await countScannedPages(b); if (live) setScanned(n); })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't prepare the PDF."));
    return () => { live = false; };
  }, [getBytes]);
  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !progress && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, progress]);

  const format: ConvertFormat = choice === "img" ? imgType : choice;
  const usesOcr = choice !== "img" && !!scanned;

  async function run() {
    if (!source) return;
    setError(null);
    setDone(null);
    setProgress({ f: 0, note: "Starting…" });
    try {
      if (usesOcr && ocr) try { localStorage.setItem("pdfinkly.ocrLangs", JSON.stringify(langs)); } catch { /* private mode */ }
      const out = await convertPdf(source, format, { fileName, dpi, ocrLangs: usesOcr && ocr ? langs : null }, (f, note) => setProgress({ f, note }));
      saveBytes(out.data, out.name, out.mime);
      setDone(`Downloaded ${out.name}.${out.recognised ? ` Text on ${out.recognised} scanned page${out.recognised > 1 ? "s was" : " was"} recognised first.` : ""}`);
    } catch (e) {
      setError(e instanceof Error ? `Conversion failed: ${e.message}` : "Conversion failed.");
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="convert-title" className="w-full max-w-[540px] rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 id="convert-title" className="text-lg font-semibold">Convert PDF</h2>
            <p className="text-sm text-zinc-600">Runs in your browser; the file isn&apos;t sent anywhere.</p>
          </div>
          <button type="button" aria-label="Close" className="btn-ghost min-h-9 px-2" onClick={onClose} disabled={!!progress}><IconX /></button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <fieldset className="grid grid-cols-2 gap-2" disabled={!!progress}>
            <legend className="mb-2 text-[13px] font-semibold text-zinc-700">Convert to</legend>
            {CHOICES.map((c) => (
              <label key={c.id} className={`flex cursor-pointer flex-col gap-0.5 rounded-xl border p-3 ${choice === c.id ? "border-brand-600 bg-brand-50" : "border-zinc-200 hover:border-zinc-300"}`}>
                <span className="flex items-center gap-2 text-sm font-semibold"><input type="radio" name="convert-to" checked={choice === c.id} onChange={() => setChoice(c.id)} />{c.title}</span>
                <span className="pl-6 text-[13px] text-zinc-600">{c.note}</span>
              </label>
            ))}
          </fieldset>

          {choice === "img" && (
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Image type
                <select className="field h-10 font-normal" value={imgType} onChange={(e) => setImgType(e.target.value as "jpg" | "png")}>
                  <option value="jpg">JPG (smaller)</option>
                  <option value="png">PNG (sharpest)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Resolution
                <select className="field h-10 font-normal" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                  <option value={72}>Screen (72 dpi)</option>
                  <option value={150}>Standard (150 dpi)</option>
                  <option value={300}>Print (300 dpi)</option>
                </select>
              </label>
            </div>
          )}

          {usesOcr && (
            <div className="flex flex-col gap-2 rounded-xl bg-zinc-50 px-3 py-3 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
                <span>Recognise text on the {scanned === 1 ? "scanned page" : `${scanned} scanned pages`} first<span className="block text-[13px] text-zinc-500">So the text is editable instead of a picture. Takes a few seconds a page.</span></span>
              </label>
              {ocr && (
                <div className="flex gap-4 pl-6">
                  {(Object.keys(OCR_LANGS) as OcrLang[]).map((l) => (
                    <label key={l} className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={langs.includes(l)} onChange={(e) => setLangs((cur) => (e.target.checked ? [...new Set([...cur, l])] : cur.filter((x) => x !== l)))} />
                      {OCR_LANGS[l]}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {choice !== "img" && (
            <p className="text-[13px] text-zinc-500">
              {choice === "docx" && "Text and pictures are rebuilt as a normal Word document, so the layout flows rather than matching exactly; lines and shapes aren't carried over."}
              {choice === "xlsx" && "Each page becomes a sheet. Works best for tables, invoices and statements."}
              {choice === "pptx" && "Each page becomes a slide that looks the same, with its text editable."}
            </p>
          )}

          {progress && (
            <div className="flex flex-col gap-1.5" role="status">
              <div className="h-2 overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-label="Converting" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.f * 100)}>
                <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${progress.f * 100}%` }} />
              </div>
              <span className="text-[13px] text-zinc-600">{progress.note}</span>
            </div>
          )}
          {done && <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-900">{done}</p>}
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={!!progress}>{done ? "Close" : "Cancel"}</button>
          <button type="button" className="btn-primary" disabled={!source || scanned === null || !!progress || (usesOcr && ocr && !langs.length)} onClick={() => void run()}>
            {progress ? "Converting…" : `Convert to ${FORMAT_INFO[format].label}`}
          </button>
        </div>
      </div>
    </div>
  );
}
