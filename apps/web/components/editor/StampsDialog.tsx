"use client";

import { useEffect, useRef, useState } from "react";
import { parsePageRange, type DocModel, type PageEntry, type Watermark } from "@pdfinkly/shared";
import { IconX } from "../icons";
import { PageView } from "./PageView";
import { useEditor } from "./store";
import { toPngOrJpegDataUrl } from "./Toolbar";

const COLORS = ["#DC2626", "#18181B", "#71717A", "#1D4ED8", "#15803D"];

export const DEFAULT_WATERMARK: Watermark = {
  kind: "watermark", text: "CONFIDENTIAL", size: 60, bold: true, color: "#DC2626", opacity: 0.25, angle: 45,
  layout: "center", layer: "over", pages: "",
};

type Tab = "watermark";

/** Watermark (and, later, page numbers and Bates) for the whole document, with a live preview. */
export function StampsDialog({ model, onClose }: { model: DocModel; onClose: () => void }) {
  const [tab] = useState<Tab>("watermark");
  const existing = model.stamps.watermark;
  const [wm, setWm] = useState<Watermark>(existing ?? DEFAULT_WATERMARK);
  const [rangeMode, setRangeMode] = useState<"all" | "some">(existing?.pages ? "some" : "all");
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Watermark>) => setWm((w) => ({ ...w, ...patch }));

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = model.pages.length;
  const pages = rangeMode === "all" ? "" : wm.pages;
  const which = parsePageRange(pages, total);
  const rangeError = rangeMode === "some" && (!wm.pages.trim() || !which || which.size === 0) ? `Enter pages between 1 and ${total}, like 1-3, 6` : null;
  const previewNo = which && which.size ? Math.min(...which) : 1;
  const previewEntry: PageEntry | undefined = model.pages[previewNo - 1];
  const draft: Watermark = { ...wm, pages };
  const empty = !wm.text.trim() && !wm.image;

  async function pickImage(file: File) {
    if (file.size > 1.5 * 1024 * 1024) { setError("Please choose an image under 1.5 MB."); return; }
    setError(null);
    set({ image: await toPngOrJpegDataUrl(file), size: wm.image ? wm.size : 40 });
  }

  function apply() {
    if (rangeError || empty) return;
    useEditor.getState().apply({ op: "stamp.set", key: "watermark", stamp: draft });
    onClose();
  }

  const previewScale = 0.42;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="stamps-title" className="flex max-h-[92vh] w-full max-w-[860px] flex-col rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 id="stamps-title" className="text-lg font-semibold">Page stamps</h2>
            <p className="text-sm text-zinc-600">Added to every chosen page when you save or download.</p>
          </div>
          <button type="button" aria-label="Close" className="btn-ghost min-h-9 px-2" onClick={onClose}><IconX /></button>
        </div>
        <div role="tablist" aria-label="Stamp type" className="flex gap-1 border-b border-zinc-200 px-6">
          <button type="button" role="tab" aria-selected={tab === "watermark"} className="border-b-2 border-brand-600 px-3 py-2.5 text-sm font-semibold text-brand-700">Watermark</button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto px-6 py-5 md:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
              Text
              <input className="field h-10 font-normal" value={wm.text} maxLength={200} placeholder="e.g. CONFIDENTIAL, DRAFT, COPY" onChange={(e) => set({ text: e.target.value })} />
            </label>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {wm.image ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={wm.image} alt="Watermark image" className="h-10 max-w-24 rounded border border-zinc-200 object-contain" />
                  <button type="button" className="btn-ghost min-h-9 px-2 text-sm" onClick={() => imageInput.current?.click()}>Change image</button>
                  <button type="button" className="btn-ghost min-h-9 px-2 text-sm text-red-700" onClick={() => set({ image: undefined, size: 60 })}>Remove image</button>
                </>
              ) : (
                <button type="button" className="btn-secondary min-h-9 px-3 text-sm" onClick={() => imageInput.current?.click()}>Add a logo or image</button>
              )}
              <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="Watermark image"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void pickImage(f); }} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                {wm.image && !wm.text.trim() ? `Image width: ${wm.size}% of page` : `Size: ${wm.size} pt`}
                <input type="range" min={wm.image && !wm.text.trim() ? 5 : 8} max={wm.image && !wm.text.trim() ? 100 : 144} value={wm.size} onChange={(e) => set({ size: Number(e.target.value) })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Opacity: {Math.round(wm.opacity * 100)}%
                <input type="range" min={5} max={100} step={5} value={Math.round(wm.opacity * 100)} onChange={(e) => set({ opacity: Number(e.target.value) / 100 })} />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Angle
                <select className="field h-10 font-normal" value={wm.angle} onChange={(e) => set({ angle: Number(e.target.value) })}>
                  <option value={45}>Diagonal up (45°)</option>
                  <option value={-45}>Diagonal down (−45°)</option>
                  <option value={0}>Horizontal</option>
                  <option value={90}>Vertical</option>
                </select>
              </label>
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Colour</legend>
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={wm.color === c} onClick={() => set({ color: c })}
                      className={`size-8 rounded-full border-2 ${wm.color === c ? "border-brand-600 ring-2 ring-brand-200" : "border-white ring-1 ring-zinc-300"}`} style={{ background: c }} />
                  ))}
                </div>
              </fieldset>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={wm.bold} onChange={(e) => set({ bold: e.target.checked })} /> Bold text
            </label>

            <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Layout</legend>
              <label className="flex items-center gap-2"><input type="radio" name="wm-layout" checked={wm.layout === "center"} onChange={() => set({ layout: "center" })} /> Once, in the middle</label>
              <label className="flex items-center gap-2"><input type="radio" name="wm-layout" checked={wm.layout === "tile"} onChange={() => set({ layout: "tile" })} /> Repeated across the page</label>
            </fieldset>
            <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Position</legend>
              <label className="flex items-center gap-2"><input type="radio" name="wm-layer" checked={wm.layer === "over"} onChange={() => set({ layer: "over" })} /> On top of the content</label>
              <label className="flex items-center gap-2"><input type="radio" name="wm-layer" checked={wm.layer === "under"} onChange={() => set({ layer: "under" })} /> Behind the content</label>
              {wm.layer === "under" && <p className="w-full text-[13px] text-zinc-500">Behind scanned pages and full-page images it won&apos;t show; use “On top” for those.</p>}
            </fieldset>
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Pages</legend>
              <label className="flex items-center gap-2"><input type="radio" name="wm-pages" checked={rangeMode === "all"} onChange={() => setRangeMode("all")} /> {total === 1 ? "The page" : `All ${total} pages`}</label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2"><input type="radio" name="wm-pages" checked={rangeMode === "some"} onChange={() => setRangeMode("some")} /> Only pages</label>
                <input className="field h-9 w-40 font-normal" aria-label="Page numbers" placeholder="1-3, 6" value={wm.pages}
                  onFocus={() => setRangeMode("some")} onChange={(e) => set({ pages: e.target.value.replace(/[^\d\s,-]/g, "") })} />
              </div>
              {rangeError && <p className="text-[13px] text-red-700">{rangeError}</p>}
            </fieldset>
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          </div>

          <div className="flex flex-col items-center gap-2">
            <span className="text-[13px] font-semibold text-zinc-600">Preview · page {previewNo}</span>
            {previewEntry && (
              <div className="pointer-events-none overflow-hidden rounded border border-zinc-200 shadow-sm">
                <PageView entry={previewEntry} label={`Preview of page ${previewNo}`} scale={previewScale} interactive={false}
                  annotations={model.annotations.filter((a) => a.page === previewEntry.ref)}
                  stamps={{ ...model.stamps, watermark: draft }} pageNo={previewNo} pageCount={total} />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-6 py-4">
          <div>
            {existing && (
              <button type="button" className="btn-ghost min-h-10 px-3 text-sm text-red-700"
                onClick={() => { useEditor.getState().apply({ op: "stamp.set", key: "watermark", stamp: null }); onClose(); }}>
                Remove watermark
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={!!rangeError || empty} onClick={apply}>{existing ? "Update watermark" : "Add watermark"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
