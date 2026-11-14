"use client";

import { useEffect, useRef, useState } from "react";
import { IconX } from "../icons";
import { toPngOrJpegDataUrl } from "./Toolbar";

export interface SavedSignature { id: string; dataUrl: string; w: number; h: number }
const KEY = "pdfinkly.signatures";

/** Saved signatures live on this device only (localStorage). */
export function loadSaved(): SavedSignature[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as SavedSignature[];
  } catch {
    return [];
  }
}
export function storeSaved(list: SavedSignature[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* storage full or blocked */
  }
  window.dispatchEvent(new Event(SAVED_EVENT));
}
/** Fired after the saved list changes, so open panels can refresh. */
export const SAVED_EVENT = "pdfinkly:signatures";

/** Trim transparent edges so the placed signature has no empty margin. */
function trimCanvas(src: HTMLCanvasElement): { dataUrl: string; w: number; h: number } | null {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3]! > 10) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL("image/png"), w: out.width, h: out.height };
}

export function SignatureDialog({ onClose, onDone }: { onClose: () => void; onDone: (sig: SavedSignature) => void }) {
  const [tab, setTab] = useState<"draw" | "type" | "upload">("draw");
  const [typed, setTyped] = useState("");
  const [ink, setInk] = useState("#1E3A8A");
  const [save, setSave] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const uploaded = useRef<{ dataUrl: string; w: number; h: number } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ctx = () => {
    const c = canvas.current!.getContext("2d")!;
    c.lineWidth = 3;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.strokeStyle = ink;
    return c;
  };
  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.current!.width, ((e.clientY - r.top) / r.height) * canvas.current!.height] as const;
  };

  async function finish() {
    setError(null);
    let out: { dataUrl: string; w: number; h: number } | null = null;
    if (tab === "draw") out = trimCanvas(canvas.current!);
    else if (tab === "type") {
      if (!typed.trim()) return setError("Type your name first.");
      const c = document.createElement("canvas");
      c.width = 900;
      c.height = 220;
      const x = c.getContext("2d")!;
      await document.fonts.load("64px Caveat").catch(() => {});
      x.font = "64px Caveat, 'Brush Script MT', cursive";
      x.fillStyle = ink;
      x.textBaseline = "middle";
      x.fillText(typed.trim(), 20, 110);
      out = trimCanvas(c);
    } else out = uploaded.current;
    if (!out) return setError(tab === "upload" ? "Choose an image first." : "Draw your signature first.");
    // Place at ~160 pt wide, keeping the aspect ratio.
    const k = 160 / out.w;
    const sig = { id: crypto.randomUUID(), dataUrl: out.dataUrl, w: 160, h: Math.max(20, Math.round(out.h * k)) };
    if (save) storeSaved([sig, ...loadSaved()]);
    onDone(sig);
  }

  const tabBtn = (id: typeof tab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={`-mb-px border-b-2 px-3 py-2.5 ${tab === id ? "border-brand-600 font-semibold text-brand-700" : "border-transparent text-zinc-600"}`}>
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap" />
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sig-title" className="w-full max-w-[560px] rounded-2xl bg-white shadow-2xl outline-none">
        <div className="flex items-center justify-between px-6 pt-5">
          <h2 id="sig-title" className="font-display text-xl font-bold">Create your signature</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="btn-ghost min-h-10 px-2.5"><IconX /></button>
        </div>
        <div role="tablist" aria-label="Signature method" className="flex gap-1 border-b border-zinc-200 px-6 pt-3">
          {tabBtn("draw", "Draw")}{tabBtn("type", "Type")}{tabBtn("upload", "Upload image")}
        </div>
        <div className="flex flex-col gap-3.5 px-6 py-5">
          {tab === "draw" && (
            <div className="relative">
              <canvas
                ref={canvas}
                width={1000}
                height={360}
                aria-label="Signature drawing area"
                className="h-[180px] w-full touch-none rounded-xl border border-zinc-300 bg-zinc-50"
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const c = ctx(); const [x, y] = pos(e); c.beginPath(); c.moveTo(x, y); }}
                onPointerMove={(e) => { if (!drawing.current) return; const c = ctx(); const [x, y] = pos(e); c.lineTo(x, y); c.stroke(); }}
                onPointerUp={() => { drawing.current = false; }}
              />
              <button type="button" className="absolute right-2 top-2 rounded-md px-2 py-1 text-sm font-semibold text-brand-700" onClick={() => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); }}>
                Clear
              </button>
            </div>
          )}
          {tab === "type" && (
            <>
              <label className="text-[13px] font-semibold" htmlFor="typed">Your name</label>
              <input id="typed" className="field" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="name" />
              <div className="flex h-[100px] items-center justify-center rounded-xl border border-zinc-300 bg-zinc-50 text-5xl" style={{ fontFamily: "Caveat, 'Brush Script MT', cursive", color: ink }}>
                {typed || "Your name"}
              </div>
            </>
          )}
          {tab === "upload" && (
            <label className="flex h-[180px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-400 text-zinc-600">
              <span className="font-semibold text-ink">{uploaded.current ? "Image ready · choose another" : "Choose a photo of your signature"}</span>
              <span className="text-[13px]">PNG or JPG on a white or transparent background</span>
              <input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const dataUrl = await toPngOrJpegDataUrl(f);
                const img = new Image();
                img.src = dataUrl;
                await img.decode();
                uploaded.current = { dataUrl, w: img.naturalWidth, h: img.naturalHeight };
                setError(null);
                setTab("upload");
              }} />
            </label>
          )}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {tab !== "upload" ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-zinc-600">Ink</span>
                {["#1E3A8A", "#18181B"].map((c) => (
                  <button key={c} type="button" aria-label={c === "#18181B" ? "Black ink" : "Dark blue ink"} aria-pressed={ink === c} onClick={() => setInk(c)}
                    className="size-7 rounded-full border-2 border-white" style={{ background: c, boxShadow: ink === c ? "0 0 0 2px #2563EB" : "0 0 0 1px #D4D4D8" }} />
                ))}
              </div>
            ) : <span />}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} className="size-4" />Save on this device</label>
          </div>
        </div>
        <div className="flex justify-end gap-2.5 border-t border-zinc-200 px-6 py-4">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => void finish()}>Use signature</button>
        </div>
      </div>
    </div>
  );
}
