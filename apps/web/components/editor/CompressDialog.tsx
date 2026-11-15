"use client";

import { useEffect, useRef, useState } from "react";
import { formatBytes } from "@/lib/client/api";
import { compressPdf, type CompressMode } from "@/lib/client/compress";
import { IconX } from "../icons";

type Choice = "recommended" | "strong" | "light" | "target";
const TARGETS = [100, 200, 500, 1024];

/** Shrink the PDF (as it is now, with unsaved edits) and download it or save it as a version. */
export function CompressDialog({ fileName, getBytes, onDownload, onSave, onClose }: {
  fileName: string;
  getBytes: () => Promise<Uint8Array>;
  onDownload: (bytes: Uint8Array) => void;
  onSave: (bytes: Uint8Array) => Promise<void>;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Uint8Array | null>(null);
  const [choice, setChoice] = useState<Choice>("recommended");
  const [targetKb, setTargetKb] = useState(200);
  const [progress, setProgress] = useState<{ f: number; note: string } | null>(null);
  const [result, setResult] = useState<{ bytes: Uint8Array; reached: boolean; images: number; mode: CompressMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getBytes().then((b) => live && setSource(b), (e) => live && setError(e instanceof Error ? e.message : "Couldn't prepare the PDF."));
    return () => { live = false; };
  }, [getBytes]);
  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !progress && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, progress]);

  async function run() {
    if (!source) return;
    setError(null);
    setResult(null);
    const mode: CompressMode = choice === "target" ? { targetBytes: targetKb * 1024 } : { preset: choice };
    setProgress({ f: 0, note: "Starting…" });
    try {
      const r = await compressPdf(source, mode, (f, note) => setProgress({ f, note }));
      setResult({ ...r, mode });
    } catch (e) {
      setError(e instanceof Error ? `Compression failed: ${e.message}` : "Compression failed.");
    } finally {
      setProgress(null);
    }
  }

  const saved = result && source ? 1 - result.bytes.length / source.length : 0;
  const name = fileName.replace(/\.pdf$/i, "") + " (compressed).pdf";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !progress && onClose()}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="compress-title" className="w-full max-w-[500px] rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 id="compress-title" className="text-lg font-semibold">Compress PDF</h2>
            <p className="text-sm text-zinc-600">{source ? <>Now <b>{formatBytes(source.length)}</b>. Images are made smaller; text stays sharp.</> : "Preparing the file…"}</p>
          </div>
          <button type="button" aria-label="Close" className="btn-ghost min-h-9 px-2" onClick={onClose} disabled={!!progress}><IconX /></button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <fieldset className="flex flex-col gap-2.5 text-sm" disabled={!!progress}>
            <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">How much</legend>
            <label className="flex items-start gap-2.5"><input type="radio" name="cmp" className="mt-1" checked={choice === "recommended"} onChange={() => setChoice("recommended")} />
              <span>Recommended<span className="block text-[13px] text-zinc-500">Good quality for screens and printing (150 dpi)</span></span></label>
            <label className="flex items-start gap-2.5"><input type="radio" name="cmp" className="mt-1" checked={choice === "strong"} onChange={() => setChoice("strong")} />
              <span>Smallest<span className="block text-[13px] text-zinc-500">For email and uploads; fine for reading on screen (100 dpi)</span></span></label>
            <label className="flex items-start gap-2.5"><input type="radio" name="cmp" className="mt-1" checked={choice === "light"} onChange={() => setChoice("light")} />
              <span>Light<span className="block text-[13px] text-zinc-500">Keeps the most detail (220 dpi)</span></span></label>
            <label className="flex items-start gap-2.5"><input type="radio" name="cmp" className="mt-1" checked={choice === "target"} onChange={() => setChoice("target")} />
              <span>Under a size<span className="block text-[13px] text-zinc-500">For forms and portals with an upload limit</span></span></label>
            {choice === "target" && (
              <div className="ml-7 flex flex-wrap items-center gap-2">
                {TARGETS.map((kb) => (
                  <button key={kb} type="button" aria-pressed={targetKb === kb} onClick={() => setTargetKb(kb)}
                    className={`rounded-full border px-3 py-1 text-[13px] ${targetKb === kb ? "border-brand-600 bg-brand-50 font-semibold text-brand-800" : "border-zinc-300"}`}>
                    {kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`}
                  </button>
                ))}
                <label className="flex items-center gap-1.5 text-[13px]">
                  <input className="field h-8 w-24" type="number" min={20} aria-label="Size limit in KB" value={targetKb} onChange={(e) => setTargetKb(Math.max(20, Math.floor(Number(e.target.value) || 0)))} /> KB
                </label>
              </div>
            )}
          </fieldset>

          {progress && (
            <div className="flex flex-col gap-1.5" role="status">
              <div className="h-2 overflow-hidden rounded-full bg-zinc-100" role="progressbar" aria-label="Compressing" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.f * 100)}>
                <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${progress.f * 100}%` }} />
              </div>
              <span className="text-[13px] text-zinc-600">{progress.note}</span>
            </div>
          )}
          {result && source && (
            <div role="status" className={`rounded-lg px-3 py-2.5 text-sm ${result.reached ? "bg-green-50 text-green-900" : "bg-amber-50 text-amber-900"}`}>
              {result.bytes.length < source.length
                ? <><b>{formatBytes(source.length)} → {formatBytes(result.bytes.length)}</b> ({Math.round(saved * 100)}% smaller).</>
                : <>This PDF is already as small as it gets ({formatBytes(source.length)}).</>}
              {!result.reached && "targetBytes" in result.mode && (
                <span className="mt-1 block">It couldn&apos;t get under {formatBytes(result.mode.targetBytes)}: {result.images === 0 ? "it's mostly text and fonts, which can't shrink further." : "this is the smallest without making the images unreadable."}</span>
              )}
            </div>
          )}
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-6 py-4">
          {result && result.bytes.length < (source?.length ?? 0) ? (
            <>
              <button type="button" className="btn-secondary" disabled={saving} onClick={() => { setSaving(true); onSave(result.bytes).then(onClose, (e) => { setSaving(false); setError(e instanceof Error ? e.message : "Couldn't save."); }); }}>
                {saving ? "Saving…" : "Save as new version"}
              </button>
              <button type="button" className="btn-primary" onClick={() => { onDownload(result.bytes); }}>Download {name.length > 28 ? "" : name}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={onClose} disabled={!!progress}>Cancel</button>
              <button type="button" className="btn-primary" disabled={!source || !!progress} onClick={() => void run()}>{progress ? "Compressing…" : "Compress"}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
