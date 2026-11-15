"use client";

import { useEffect, useRef, useState } from "react";
import { batesNumber, parsePageRange, type Bates, type DocModel, type HeaderFooter, type PageEntry, type Stamps, type Watermark } from "@pdfinkly/shared";
import { IconX } from "../icons";
import Link from "next/link";
import { isLocked, usePlan } from "@/lib/client/plan";
import { ProBadge } from "../billing/ProBadge";
import { PageView } from "./PageView";
import { useEditor } from "./store";
import { toPngOrJpegDataUrl } from "./Toolbar";

const COLORS = ["#DC2626", "#18181B", "#71717A", "#1D4ED8", "#15803D"];

export const DEFAULT_WATERMARK: Watermark = {
  kind: "watermark", text: "CONFIDENTIAL", size: 60, bold: true, color: "#DC2626", opacity: 0.25, angle: 45,
  layout: "center", layer: "over", pages: "",
};

export const DEFAULT_HEADER_FOOTER: HeaderFooter = {
  kind: "headerFooter", top: ["", "", ""], bottom: ["", "Page {page} of {pages}", ""], font: "Helvetica", size: 10,
  color: "#3F3F46", margin: 28, startAt: 1, pages: "",
};

const NUMBER_FORMATS = [
  { label: "1", value: "{page}" },
  { label: "Page 1", value: "Page {page}" },
  { label: "Page 1 of 9", value: "Page {page} of {pages}" },
  { label: "1 / 9", value: "{page} / {pages}" },
];
const SLOT_NAMES = ["left", "centre", "right"] as const;

export const DEFAULT_BATES: Bates = {
  kind: "bates", prefix: "", suffix: "", start: 1, digits: 6, top: false, slot: 2, font: "Helvetica", size: 9,
  color: "#18181B", margin: 20, pages: "",
};

type Tab = "watermark" | "headerFooter" | "bates";

/** "All pages" / "Only pages …" with validation; returns the effective range string and any error. */
function usePages(initial: string, total: number) {
  const [mode, setMode] = useState<"all" | "some">(initial ? "some" : "all");
  const [text, setText] = useState(initial);
  const range = mode === "all" ? "" : text;
  const which = parsePageRange(range, total);
  const error = mode === "some" && (!text.trim() || !which || which.size === 0) ? `Enter pages between 1 and ${total}, like 1-3, 6` : null;
  return { mode, setMode, text, setText, range, which, error };
}

function PagesField({ name, total, p, hint }: { name: string; total: number; p: ReturnType<typeof usePages>; hint?: string }) {
  return (
    <fieldset className="flex flex-col gap-2 text-sm">
      <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Pages</legend>
      <label className="flex items-center gap-2"><input type="radio" name={`${name}-pages`} checked={p.mode === "all"} onChange={() => p.setMode("all")} /> {total === 1 ? "The page" : `All ${total} pages`}</label>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2"><input type="radio" name={`${name}-pages`} checked={p.mode === "some"} onChange={() => p.setMode("some")} /> Only pages</label>
        <input className="field h-9 w-40 font-normal" aria-label="Page range" placeholder="1-3, 6" value={p.text}
          onFocus={() => p.setMode("some")} onChange={(e) => p.setText(e.target.value.replace(/[^\d\s,-]/g, ""))} />
      </div>
      {hint && <p className="text-[13px] text-zinc-500">{hint}</p>}
      {p.error && <p className="text-[13px] text-red-700">{p.error}</p>}
    </fieldset>
  );
}

/** Watermark, page numbers and headers/footers for the whole document, with a live preview. */
export function StampsDialog({ model, fileName, onClose, initialTab = "watermark" }: { model: DocModel; fileName: string; onClose: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const batesLocked = isLocked(usePlan(), "bates");
  const total = model.pages.length;
  const dialog = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const [wm, setWm] = useState<Watermark>(model.stamps.watermark ?? DEFAULT_WATERMARK);
  const wmPages = usePages(model.stamps.watermark?.pages ?? "", total);
  const setW = (patch: Partial<Watermark>) => setWm((w) => ({ ...w, ...patch }));

  const [hf, setHf] = useState<HeaderFooter>(model.stamps.headerFooter ?? DEFAULT_HEADER_FOOTER);
  const hfPages = usePages(model.stamps.headerFooter?.pages ?? "", total);
  const setH = (patch: Partial<HeaderFooter>) => setHf((h) => ({ ...h, ...patch }));
  const setSlot = (top: boolean, i: number, v: string) =>
    setHf((h) => { const row = [...(top ? h.top : h.bottom)] as HeaderFooter["top"]; row[i] = v; return { ...h, [top ? "top" : "bottom"]: row }; });

  const [bates, setBates] = useState<Bates>(model.stamps.bates ?? DEFAULT_BATES);
  const batesPages = usePages(model.stamps.bates?.pages ?? "", total);
  const setB = (patch: Partial<Bates>) => setBates((b) => ({ ...b, ...patch }));

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const wmDraft: Watermark = { ...wm, pages: wmPages.range };
  const hfDraft: HeaderFooter = { ...hf, pages: hfPages.range };
  const batesDraft: Bates = { ...bates, pages: batesPages.range };
  const active = tab === "watermark"
    ? { draft: wmDraft, pages: wmPages, empty: !wm.text.trim() && !wm.image, existing: model.stamps.watermark, noun: "watermark" }
    : tab === "headerFooter"
      ? { draft: hfDraft, pages: hfPages, empty: ![...hf.top, ...hf.bottom].some((t) => t.trim()), existing: model.stamps.headerFooter, noun: "page numbers and headers" }
      : { draft: batesDraft, pages: batesPages, empty: false, existing: model.stamps.bates, noun: "Bates numbers" };
  const batesCount = batesPages.which?.size ?? 0;
  // A header/footer slot in the same place would overlap.
  const batesClash = !!model.stamps.headerFooter && !!(bates.top ? hf.top : hf.bottom)[bates.slot]?.trim();
  const previewNo = active.pages.which && active.pages.which.size ? Math.min(...active.pages.which) : 1;
  const previewEntry: PageEntry | undefined = model.pages[previewNo - 1];
  const previewStamps: Stamps = { ...model.stamps, [tab]: active.draft };

  // Page numbers shortcut: which slot holds {page}, and in which format.
  const numberSlot = (() => {
    for (const top of [true, false]) {
      const i = (top ? hf.top : hf.bottom).findIndex((t) => t.includes("{page}"));
      if (i >= 0) return { top, i, value: (top ? hf.top : hf.bottom)[i]! };
    }
    return null;
  })();
  function setNumbers(position: string, format: string) {
    setHf((h) => {
      const top = [...h.top] as HeaderFooter["top"], bottom = [...h.bottom] as HeaderFooter["bottom"];
      for (const row of [top, bottom]) row.forEach((t, i) => { if (t.includes("{page}")) row[i] = ""; });
      if (position !== "none") {
        const [where, slot] = position.split("-") as ["top" | "bottom", string];
        (where === "top" ? top : bottom)[Number(slot)] = format;
      }
      return { ...h, top, bottom };
    });
  }
  const numberPosition = numberSlot ? `${numberSlot.top ? "top" : "bottom"}-${numberSlot.i}` : "none";
  const numberFormat = NUMBER_FORMATS.find((f) => f.value === numberSlot?.value)?.value ?? numberSlot?.value ?? NUMBER_FORMATS[2]!.value;

  async function pickImage(file: File) {
    if (file.size > 1.5 * 1024 * 1024) { setError("Please choose an image under 1.5 MB."); return; }
    setError(null);
    setW({ image: await toPngOrJpegDataUrl(file), size: wm.image ? wm.size : 40 });
  }

  const locked = tab === "bates" && batesLocked;
  function apply() {
    if (active.pages.error || active.empty || locked) return;
    useEditor.getState().apply({ op: "stamp.set", key: tab, stamp: active.draft });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="stamps-title" className="flex max-h-[92vh] w-full max-w-[880px] flex-col rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 id="stamps-title" className="text-lg font-semibold">Page stamps</h2>
            <p className="text-sm text-zinc-600">Added to every chosen page when you save or download.</p>
          </div>
          <button type="button" aria-label="Close" className="btn-ghost min-h-9 px-2" onClick={onClose}><IconX /></button>
        </div>
        <div role="tablist" aria-label="Stamp type" className="flex gap-1 border-b border-zinc-200 px-6">
          {([["watermark", "Watermark"], ["headerFooter", "Page numbers & headers"], ["bates", "Bates numbering"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-semibold ${tab === id ? "border-brand-600 text-brand-700" : "border-transparent text-zinc-600 hover:text-ink"}`}>
              {label}{model.stamps[id] ? " •" : ""}
              {id === "bates" && batesLocked && <ProBadge className="ml-1.5 align-middle" />}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto px-6 py-5 md:grid-cols-[1fr_auto]">
          {tab === "watermark" ? (
            <div role="tabpanel" aria-label="Watermark" className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Text
                <input className="field h-10 font-normal" value={wm.text} maxLength={200} placeholder="e.g. CONFIDENTIAL, DRAFT, COPY" onChange={(e) => setW({ text: e.target.value })} />
              </label>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {wm.image ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={wm.image} alt="Watermark image" className="h-10 max-w-24 rounded border border-zinc-200 object-contain" />
                    <button type="button" className="btn-ghost min-h-9 px-2 text-sm" onClick={() => imageInput.current?.click()}>Change image</button>
                    <button type="button" className="btn-ghost min-h-9 px-2 text-sm text-red-700" onClick={() => setW({ image: undefined, size: 60 })}>Remove image</button>
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
                  <input type="range" min={wm.image && !wm.text.trim() ? 5 : 8} max={wm.image && !wm.text.trim() ? 100 : 144} value={wm.size} onChange={(e) => setW({ size: Number(e.target.value) })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Opacity: {Math.round(wm.opacity * 100)}%
                  <input type="range" min={5} max={100} step={5} value={Math.round(wm.opacity * 100)} onChange={(e) => setW({ opacity: Number(e.target.value) / 100 })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Angle
                  <select className="field h-10 font-normal" value={wm.angle} onChange={(e) => setW({ angle: Number(e.target.value) })}>
                    <option value={45}>Diagonal up (45°)</option>
                    <option value={-45}>Diagonal down (−45°)</option>
                    <option value={0}>Horizontal</option>
                    <option value={90}>Vertical</option>
                  </select>
                </label>
                <Swatch value={wm.color} onChange={(color) => setW({ color })} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={wm.bold} onChange={(e) => setW({ bold: e.target.checked })} /> Bold text
              </label>
              <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Layout</legend>
                <label className="flex items-center gap-2"><input type="radio" name="wm-layout" checked={wm.layout === "center"} onChange={() => setW({ layout: "center" })} /> Once, in the middle</label>
                <label className="flex items-center gap-2"><input type="radio" name="wm-layout" checked={wm.layout === "tile"} onChange={() => setW({ layout: "tile" })} /> Repeated across the page</label>
              </fieldset>
              <fieldset className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Position</legend>
                <label className="flex items-center gap-2"><input type="radio" name="wm-layer" checked={wm.layer === "over"} onChange={() => setW({ layer: "over" })} /> On top of the content</label>
                <label className="flex items-center gap-2"><input type="radio" name="wm-layer" checked={wm.layer === "under"} onChange={() => setW({ layer: "under" })} /> Behind the content</label>
                {wm.layer === "under" && <p className="w-full text-[13px] text-zinc-500">Behind scanned pages and full-page images it won&apos;t show; use “On top” for those.</p>}
              </fieldset>
              <PagesField name="wm" total={total} p={wmPages} />
              {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            </div>
          ) : tab === "bates" ? (
            <div role="tabpanel" aria-label="Bates numbering" className="flex flex-col gap-4">
              <p className="text-[13px] text-zinc-600">A unique, running number on every page, used to reference pages in legal and audit documents.</p>
              {batesLocked && (
                <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Bates numbering is part of Pro. You can try the settings and preview here.{" "}
                  <Link href="/pricing" target="_blank" className="font-semibold text-brand-700">See Pro plans</Link>
                </p>
              )}
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Prefix
                  <input className="field h-10 font-normal" value={bates.prefix} maxLength={40} placeholder="e.g. ACME-" onChange={(e) => setB({ prefix: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Suffix
                  <input className="field h-10 font-normal" value={bates.suffix} maxLength={40} placeholder="optional" onChange={(e) => setB({ suffix: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Start at
                  <input className="field h-10 font-normal" type="number" min={0} value={bates.start} onChange={(e) => setB({ start: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Digits
                  <input className="field h-10 font-normal" type="number" min={1} max={12} value={bates.digits} onChange={(e) => setB({ digits: Math.min(12, Math.max(1, Math.floor(Number(e.target.value) || 6))) })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Position
                  <select className="field h-10 font-normal" aria-label="Bates position" value={`${bates.top ? "top" : "bottom"}-${bates.slot}`}
                    onChange={(e) => { const [w, i] = e.target.value.split("-"); setB({ top: w === "top", slot: Number(i) as Bates["slot"] }); }}>
                    <option value="bottom-2">Bottom right</option>
                    <option value="bottom-1">Bottom centre</option>
                    <option value="bottom-0">Bottom left</option>
                    <option value="top-2">Top right</option>
                    <option value="top-1">Top centre</option>
                    <option value="top-0">Top left</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Size (pt)
                  <input className="field h-10 font-normal" type="number" min={5} max={36} value={bates.size} onChange={(e) => setB({ size: Math.min(36, Math.max(5, Number(e.target.value) || 9)) })} />
                </label>
              </div>
              <p role="status" className="rounded-lg bg-zinc-50 px-3 py-2 text-[13px] text-zinc-700">
                {batesCount > 0
                  ? <>This document: <b>{batesNumber(bates, 0)}</b>{batesCount > 1 && <> to <b>{batesNumber(bates, batesCount - 1)}</b></>}. The next document can start at {bates.start + batesCount}.</>
                  : "Choose the pages to number."}
              </p>
              {batesClash && <p className="text-[13px] text-amber-800">Your header or footer already has text in this position; pick another so they don&apos;t overlap.</p>}
              <PagesField name="bates" total={total} p={batesPages} />
            </div>
          ) : (
            <div role="tabpanel" aria-label="Page numbers and headers" className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Page numbers
                  <select className="field h-10 font-normal" aria-label="Page numbers" value={numberPosition} onChange={(e) => setNumbers(e.target.value, numberFormat)}>
                    <option value="none">None</option>
                    <option value="bottom-1">Bottom centre</option>
                    <option value="bottom-2">Bottom right</option>
                    <option value="bottom-0">Bottom left</option>
                    <option value="top-1">Top centre</option>
                    <option value="top-2">Top right</option>
                    <option value="top-0">Top left</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Format
                  <select className="field h-10 font-normal" aria-label="Number format" value={numberFormat} disabled={!numberSlot} onChange={(e) => setNumbers(numberPosition, e.target.value)}>
                    {NUMBER_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    {numberSlot && !NUMBER_FORMATS.some((f) => f.value === numberSlot.value) && <option value={numberSlot.value}>Custom</option>}
                  </select>
                </label>
              </div>
              {(["top", "bottom"] as const).map((where) => (
                <fieldset key={where} className="flex flex-col gap-1.5">
                  <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">{where === "top" ? "Header" : "Footer"}</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {SLOT_NAMES.map((slot, i) => (
                      <input key={slot} className="field h-10 text-sm" aria-label={`${where === "top" ? "Header" : "Footer"} ${slot}`} placeholder={slot[0]!.toUpperCase() + slot.slice(1)}
                        value={(where === "top" ? hf.top : hf.bottom)[i]} maxLength={200} onChange={(e) => setSlot(where === "top", i, e.target.value)} />
                    ))}
                  </div>
                </fieldset>
              ))}
              <p className="text-[13px] text-zinc-500">Use <code>{"{page}"}</code>, <code>{"{pages}"}</code>, <code>{"{date}"}</code> or <code>{"{file}"}</code> in any box.</p>
              <div className="grid grid-cols-3 gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Font
                  <select className="field h-10 font-normal" value={hf.font} onChange={(e) => setH({ font: e.target.value as HeaderFooter["font"] })}>
                    <option value="Helvetica">Helvetica</option>
                    <option value="TimesRoman">Times</option>
                    <option value="Courier">Courier</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Size (pt)
                  <input className="field h-10 font-normal" type="number" min={5} max={36} value={hf.size} onChange={(e) => setH({ size: Math.min(36, Math.max(5, Number(e.target.value) || 10)) })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Margin (pt)
                  <input className="field h-10 font-normal" type="number" min={4} max={144} value={hf.margin} onChange={(e) => setH({ margin: Math.min(144, Math.max(4, Number(e.target.value) || 28)) })} />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  First number
                  <input className="field h-10 font-normal" type="number" min={0} value={hf.startAt} onChange={(e) => setH({ startAt: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                </label>
                <div className="col-span-2"><Swatch value={hf.color} onChange={(color) => setH({ color })} colors={["#3F3F46", "#18181B", "#1D4ED8", "#B91C1C", "#71717A"]} /></div>
              </div>
              <PagesField name="hf" total={total} p={hfPages} hint={total > 1 ? "To leave out a cover page, choose pages 2- and set the first number." : undefined} />
            </div>
          )}

          <div className="flex flex-col items-center gap-2">
            <span className="text-[13px] font-semibold text-zinc-600">Preview · page {previewNo}</span>
            {previewEntry && (
              <div className="pointer-events-none overflow-hidden rounded border border-zinc-200 shadow-sm">
                <PageView entry={previewEntry} label={`Preview of page ${previewNo}`} scale={0.42} interactive={false}
                  annotations={model.annotations.filter((a) => a.page === previewEntry.ref)}
                  stamps={previewStamps} pageNo={previewNo} pageCount={total} fileName={fileName} />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-6 py-4">
          <div>
            {active.existing && (
              <button type="button" className="btn-ghost min-h-10 px-3 text-sm text-red-700"
                onClick={() => { useEditor.getState().apply({ op: "stamp.set", key: tab, stamp: null }); onClose(); }}>
                Remove {active.noun}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn-primary" disabled={!!active.pages.error || active.empty || locked} onClick={apply}>
              {tab === "watermark" ? (active.existing ? "Update watermark" : "Add watermark") : tab === "bates" ? (active.existing ? "Update numbers" : "Add Bates numbers") : (active.existing ? "Update" : "Add to pages")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Swatch({ value, onChange, colors = COLORS }: { value: string; onChange: (c: string) => void; colors?: string[] }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">Colour</legend>
      <div className="flex gap-2">
        {colors.map((c) => (
          <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={value === c} onClick={() => onChange(c)}
            className={`size-8 rounded-full border-2 ${value === c ? "border-brand-600 ring-2 ring-brand-200" : "border-white ring-1 ring-zinc-300"}`} style={{ background: c }} />
        ))}
      </div>
    </fieldset>
  );
}
