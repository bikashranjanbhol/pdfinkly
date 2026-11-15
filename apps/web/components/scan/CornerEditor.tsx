"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_QUAD, quadIsSane, type Pt, type Quad, type ScanFilter } from "@pdfinkly/shared/scan";
import { IconX } from "../icons";
import { FILTERS } from "./filters";

const NAMES = ["Top-left", "Top-right", "Bottom-right", "Bottom-left"] as const;
const FULL: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/**
 * Drag the four corners onto the page's corners. A magnifier shows what's
 * under your finger; arrow keys move a focused corner (Shift for bigger steps).
 */
export function CornerEditor({
  pageNo,
  preview,
  quad: initial,
  detected,
  found,
  filter: initialFilter,
  showLook = true,
  onApply,
  onClose,
}: {
  pageNo: number;
  preview: string;
  quad: Quad;
  detected: Quad;
  found: boolean;
  /** This page's own look, or null to follow the one chosen for all pages. */
  filter: ScanFilter | null;
  showLook?: boolean;
  onApply: (quad: Quad, filter: ScanFilter | null) => void;
  onClose: () => void;
}) {
  const [quad, setQuad] = useState<Quad>(initial);
  const [filter, setFilter] = useState<ScanFilter | null>(initialFilter);
  const [drag, setDrag] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const sane = quadIsSane(quad);

  // Size the photo to fit the space it has, keeping its proportions.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => {
      const im = img.current;
      if (!im?.naturalWidth) return;
      const r = el.getBoundingClientRect();
      const s = Math.min((r.width - 32) / im.naturalWidth, (r.height - 32) / im.naturalHeight);
      setFit({ w: Math.max(50, im.naturalWidth * s), h: Math.max(50, im.naturalHeight * s) });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    img.current?.addEventListener("load", measure);
    measure();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const move = (i: number, p: Pt) =>
    setQuad((q) => q.map((c, j) => (j === i ? { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) } : c)) as Quad);

  const toLocal = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const loupe = drag !== null && fit ? quad[drag]! : null;
  const Z = 3, LS = 128; // magnification, loupe size
  const loupeLeft = loupe && loupe.x < 0.5 && loupe.y < 0.35;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="corners-title" className="fixed inset-0 z-50 flex flex-col bg-zinc-900 text-white">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <h2 id="corners-title" className="text-lg font-semibold">Adjust page {pageNo}</h2>
          <span className="text-sm text-zinc-300">{found ? "Drag the corners onto the page's corners." : "We couldn't find the page edges. Drag the corners onto the page's corners."}</span>
        </div>
        <button type="button" aria-label="Close" className="ml-auto rounded-lg p-2 hover:bg-white/10" onClick={onClose}><IconX /></button>
      </div>

      <div ref={area} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div ref={box} className="relative touch-none select-none" style={fit ? { width: fit.w, height: fit.h } : { visibility: "hidden" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={img} src={preview} alt={`Photo for page ${pageNo}`} className="block h-full w-full" draggable={false} />
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
            <path d={`M0 0H1V1H0Z M${quad.map((p) => `${p.x} ${p.y}`).join(" L")} Z`} fill="rgba(0,0,0,0.45)" fillRule="evenodd" />
            <polygon points={quad.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={sane ? "#3b82f6" : "#ef4444"} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </svg>
          {quad.map((p, i) => (
            <button
              key={i}
              type="button"
              aria-label={`${NAMES[i]} corner`}
              title="Drag, or use the arrow keys"
              className="group absolute size-11 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-none"
              style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, touchAction: "none" }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(i); }}
              onPointerMove={(e) => { if (drag === i) move(i, toLocal(e)); }}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => {
                const step = e.shiftKey ? 0.02 : 0.004;
                const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
                if (!d) return;
                e.preventDefault();
                move(i, { x: p.x + d[0]!, y: p.y + d[1]! });
              }}
            >
              <span className={`absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow ${drag === i ? "bg-brand-600" : "bg-brand-600/70"} ring-brand-100 group-focus-visible:ring-4`} />
            </button>
          ))}
        </div>
        {loupe && fit && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute top-3 overflow-hidden rounded-full border-2 border-white shadow-xl ${loupeLeft ? "right-3" : "left-3"}`}
            style={{
              width: LS, height: LS,
              backgroundImage: `url(${preview})`,
              backgroundSize: `${fit.w * Z}px ${fit.h * Z}px`,
              backgroundPosition: `${LS / 2 - loupe.x * fit.w * Z}px ${LS / 2 - loupe.y * fit.h * Z}px`,
            }}
          >
            <span className="absolute left-1/2 top-0 h-full w-px bg-brand-600" />
            <span className="absolute left-0 top-1/2 h-px w-full bg-brand-600" />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-white/10 bg-zinc-900 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => setQuad(found ? detected : DEFAULT_QUAD)}>
            Find edges again
          </button>
          <button type="button" className="rounded-lg border border-white/20 px-3 py-2 text-sm hover:bg-white/10" onClick={() => setQuad(FULL)}>
            Whole photo
          </button>
          {showLook && <label className="ml-auto flex items-center gap-2 text-sm">
            Look
            <select
              className="rounded-lg border border-white/20 bg-zinc-800 px-2 py-2 text-sm"
              value={filter ?? ""}
              onChange={(e) => setFilter((e.target.value || null) as ScanFilter | null)}
            >
              <option value="">Same as all pages</option>
              {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>}
        </div>
        {!sane && <p role="alert" className="text-sm text-red-300">The corners cross over or are too squashed. Move them onto the page&apos;s four corners.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg px-4 py-2.5 text-[15px] font-semibold hover:bg-white/10" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!sane} onClick={() => onApply(quad, filter)}>Apply</button>
        </div>
      </div>
    </div>
  );
}
