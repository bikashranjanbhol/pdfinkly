"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanFilter } from "@pdfinkly/shared/scan";
import { IconBack, IconCamera, IconCheck, IconCrop, IconRotateR, IconTrash, IconX, IconZoom } from "../icons";
import { FILTERS } from "./filters";

export interface ViewerPage {
  id: string;
  view?: string;
  status: "analysing" | "rendering" | "ready" | "error";
  error?: string;
  filter: ScanFilter | null;
  canAdjust: boolean;
}

/**
 * A page at full size, as it will look: swipe or use the arrows to go through
 * the pages; fix one without leaving. Opened by tapping a page, and straight
 * after taking a photo (then it offers Retake / Take next photo).
 */
export function PageViewer({
  pages,
  index,
  review,
  showLook,
  onIndex,
  onClose,
  onAdjust,
  onRotate,
  onRemove,
  onFilter,
  onRetake,
  onNext,
  inactive = false,
}: {
  pages: ViewerPage[];
  index: number;
  /** Just taken with the camera: offer Retake and Take next photo. */
  review: boolean;
  showLook: boolean;
  onIndex: (i: number) => void;
  onClose: () => void;
  onAdjust: (id: string) => void;
  onRotate: (id: string) => void;
  onRemove: (id: string) => void;
  onFilter: (id: string, f: ScanFilter | null) => void;
  onRetake: (id: string) => void;
  onNext: () => void;
  /** Another dialog is open on top: don't react to keys. */
  inactive?: boolean;
}) {
  const page = pages[index];
  const [zoom, setZoom] = useState(false);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const n = pages.length;

  useEffect(() => closeBtn.current?.focus(), []);
  useEffect(() => setZoom(false), [index]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inactive) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && index < n - 1) onIndex(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, n, onClose, onIndex, inactive]);

  if (!page) return null;
  const busy = page.status === "analysing" || page.status === "rendering";
  const tool = "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-3 text-xs font-medium hover:bg-white/10 disabled:opacity-40";

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="viewer-title" className="fixed inset-0 z-50 flex flex-col bg-zinc-900 text-white">
      <div className="flex items-center gap-3 px-4 py-3">
        <h2 id="viewer-title" className="text-lg font-semibold">{review ? "Here's your scan" : `Page ${index + 1} of ${n}`}</h2>
        {review && <span className="text-sm text-zinc-300">Page {index + 1}</span>}
        <button type="button" aria-label={zoom ? "Fit to screen" : "Zoom in"} aria-pressed={zoom} className="ml-auto rounded-lg p-2 hover:bg-white/10" onClick={() => setZoom((z) => !z)}>
          <IconZoom />
        </button>
        <button ref={closeBtn} type="button" aria-label="Close preview" className="rounded-lg p-2 hover:bg-white/10" onClick={onClose}><IconX /></button>
      </div>

      <div
        className={`relative min-h-0 flex-1 ${zoom ? "overflow-auto" : "flex items-center justify-center overflow-hidden p-3"}`}
        onPointerDown={(e) => { if (!zoom) swipe.current = { x: e.clientX, y: e.clientY }; }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || zoom) return;
          const dx = e.clientX - s.x, dy = e.clientY - s.y;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if (dx < 0 && index < n - 1) onIndex(index + 1);
            if (dx > 0 && index > 0) onIndex(index - 1);
          }
        }}
      >
        {page.view ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={page.view}
            alt={`Preview of page ${index + 1}`}
            draggable={false}
            onDoubleClick={() => setZoom((z) => !z)}
            className={`select-none bg-white shadow-2xl ${zoom ? "mx-auto max-w-none" : "max-h-full max-w-full object-contain"} ${busy ? "opacity-40" : ""}`}
          />
        ) : (
          <span className="text-zinc-400">{page.status === "error" ? page.error : "Preparing the page…"}</span>
        )}
        {busy && (
          <span role="status" className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/70 px-4 py-2 text-sm">
            {page.status === "analysing" ? "Finding the page…" : "Cleaning up…"}
          </span>
        )}
        {!zoom && index > 0 && (
          <button type="button" aria-label="Previous page" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-3 hover:bg-black/70" onClick={() => onIndex(index - 1)}>
            <IconBack />
          </button>
        )}
        {!zoom && index < n - 1 && (
          <button type="button" aria-label="Next page" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-3 hover:bg-black/70" onClick={() => onIndex(index + 1)}>
            <IconBack className="rotate-180" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-white/10 px-4 py-3">
        {showLook && (
          <div role="radiogroup" aria-label="Look for this page" className="flex flex-wrap justify-center gap-2">
            {[{ id: null, label: "Same as all" } as { id: ScanFilter | null; label: string }, ...FILTERS].map((f) => (
              <button
                key={f.id ?? "all"}
                type="button"
                role="radio"
                aria-checked={page.filter === f.id}
                disabled={busy}
                onClick={() => onFilter(page.id, f.id)}
                className={`rounded-full border px-3 py-1.5 text-sm ${page.filter === f.id ? "border-white bg-white text-zinc-900" : "border-white/30 hover:border-white/60"}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-1">
          <button type="button" className={tool} disabled={!page.canAdjust || busy} onClick={() => onAdjust(page.id)}><IconCrop size={20} />Adjust</button>
          <button type="button" className={tool} disabled={busy || page.status === "error"} onClick={() => onRotate(page.id)}><IconRotateR size={20} />Rotate</button>
          {review ? (
            <button type="button" className={tool} onClick={() => onRetake(page.id)}><IconCamera size={20} />Retake</button>
          ) : (
            <button type="button" className={`${tool} text-red-300`} onClick={() => onRemove(page.id)}><IconTrash size={20} />Remove</button>
          )}
        </div>
        {review && (
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1 whitespace-nowrap border-white/30 bg-transparent px-3 text-white hover:bg-white/10" onClick={onClose}>
              <IconCheck /> Done
            </button>
            <button type="button" className="btn-primary flex-[1.4] whitespace-nowrap px-3" onClick={onNext}>
              <IconCamera /> Take next photo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
