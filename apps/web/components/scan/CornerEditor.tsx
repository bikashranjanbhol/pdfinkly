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
 * The result (straightened, in the chosen look) is shown beside the photo,
 * or one tap away on a phone, and updates as corners and look change.
 */
export function CornerEditor({
  pageNo,
  preview,
  quad: initial,
  detected,
  found,
  filter: initialFilter,
  showLook = true,
  allFilter,
  renderPreview,
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
  /** The look chosen for all pages (what "Same as all" means). */
  allFilter: ScanFilter;
  /** Straighten and clean up with these corners and look, small, for the result preview. */
  renderPreview: (quad: Quad, filter: ScanFilter) => Promise<Blob>;
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
  const look = filter ?? allFilter;

  // Wide screens show photo and result side by side; phones switch between them.
  const [wide, setWide] = useState(false);
  const [pane, setPane] = useState<"corners" | "result">("corners");
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // The result: re-rendered (small) shortly after the corners or look change, once dragging stops.
  const [result, setResult] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (drag !== null || !sane) return;
    const n = ++seq.current;
    setUpdating(true);
    const t = setTimeout(() => {
      renderPreview(quad, look)
        .then((blob) => {
          if (n !== seq.current) return;
          setResult((old) => {
            if (old) URL.revokeObjectURL(old);
            return URL.createObjectURL(blob);
          });
        })
        .catch(() => undefined)
        .finally(() => n === seq.current && setUpdating(false));
    }, 250);
    return () => clearTimeout(t);
    // renderPreview is stable enough for this; re-run only when what's shown would change.
  }, [quad, look, drag, sane]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { setResult((old) => { if (old) URL.revokeObjectURL(old); return null; }); }, []);

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

      {!wide && (
        <div role="group" aria-label="Show" className="mx-4 mb-2 flex self-start rounded-lg bg-white/10 p-1 text-sm">
          {(["corners", "result"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={pane === v} onClick={() => setPane(v)} className={`rounded-md px-4 py-1.5 font-medium ${pane === v ? "bg-white text-zinc-900" : "text-zinc-200"}`}>
              {v === "corners" ? "Corners" : "Result"}
            </button>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
      <div ref={area} className={`relative min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden ${!wide && pane === "result" ? "hidden" : "flex"}`}>
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
      {(wide || pane === "result") && (
        <section aria-label="Result" className={`relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 p-4 ${wide ? "border-l border-white/10" : ""}`}>
          {wide && <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Result</span>}
          <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
            {result ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={result} alt={`Result for page ${pageNo}`} className={`max-h-full max-w-full bg-white object-contain shadow-2xl transition-opacity ${updating ? "opacity-60" : ""}`} />
            ) : (
              <span className="text-sm text-zinc-400">{sane ? "Preparing the result…" : "Fix the corners to see the result."}</span>
            )}
            {updating && result && <span role="status" className="absolute rounded-lg bg-black/70 px-3 py-1.5 text-sm">Updating…</span>}
          </div>
        </section>
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
          {showLook && (
            <div role="radiogroup" aria-label="Look" className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
              {[{ id: null, label: "Same as all" } as { id: ScanFilter | null; label: string }, ...FILTERS].map((f) => (
                <button
                  key={f.id ?? "all"}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.id}
                  onClick={() => { setFilter(f.id); if (!wide) setPane("result"); }}
                  className={`rounded-full border px-3 py-1.5 text-sm ${filter === f.id ? "border-white bg-white text-zinc-900" : "border-white/30 hover:border-white/60"}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
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
