"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { newId, type Annotation, type PageEntry, type PlacedAnnotation } from "@pdfinkly/shared";
import { boundsOf, hasRect, HtmlAnnotation, ShapeSvg, translate, FONT_CSS } from "./annotations";
import { cssToRect, makeGeom, rectToCss, round, toPdf, type PageGeom } from "./geometry";
import { useEditor } from "./store";

/* ------------------------------------------------------------ documents */

export interface DocsCtx {
  base: PDFDocumentProxy | null;
  ext: Record<string, PDFDocumentProxy>;
}
export const DocsContext = createContext<DocsCtx>({ base: null, ext: {} });

interface PageInfo {
  page: PDFPageProxy | null;
  view: [number, number, number, number];
  rotate: number;
}

export function usePageInfo(entry: PageEntry): PageInfo | null {
  const docs = useContext(DocsContext);
  const [info, setInfo] = useState<PageInfo | null>(null);
  const src = entry.source;
  const doc = src.kind === "base" ? docs.base : src.kind === "ext" ? docs.ext[src.versionId] ?? null : null;
  const index = src.kind === "blank" ? -1 : src.index;
  const blankW = src.kind === "blank" ? src.w : 0;
  const blankH = src.kind === "blank" ? src.h : 0;

  useEffect(() => {
    let cancelled = false;
    if (index === -1) {
      setInfo({ page: null, view: [0, 0, blankW, blankH], rotate: 0 });
      return;
    }
    if (!doc) return;
    doc.getPage(index + 1).then((page) => {
      if (!cancelled) setInfo({ page, view: page.view as [number, number, number, number], rotate: page.rotate });
    });
    return () => {
      cancelled = true;
    };
  }, [doc, index, blankW, blankH]);
  return info;
}

/** Render a PDF page (or a blank page) into a canvas at the given CSS size. */
export function PageCanvas({ info, g, visible, className }: { info: PageInfo; g: PageGeom; visible: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !visible) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!info.page) {
      canvas.width = Math.ceil(g.width * dpr);
      canvas.height = Math.ceil(g.height * dpr);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const vp = info.page.getViewport({ scale: g.scale * dpr, rotation: g.rotation });
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    let task: RenderTask | null = info.page.render({ canvas, viewport: vp });
    task.promise.catch(() => {}).finally(() => { task = null; });
    return () => task?.cancel();
  }, [info, g.scale, g.rotation, g.width, g.height, visible]);
  return <canvas ref={ref} className={className} style={{ width: g.width, height: g.height, display: "block", background: "#FFFFFF" }} />;
}

/* ----------------------------------------------------------- interaction */

type Drag =
  | { kind: "rect"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "line"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "ink"; pts: number[] }
  | { kind: "move"; id: string; x0: number; y0: number; x1: number; y1: number }
  | { kind: "resize"; id: string; x0: number; y0: number; x1: number; y1: number };

const MIN_DRAG = 4;

export function PageView({
  entry,
  label,
  annotations,
  scale,
  interactive,
}: {
  entry: PageEntry;
  label: string;
  annotations: PlacedAnnotation[];
  scale: number;
  interactive: boolean;
}) {
  const info = usePageInfo(entry);
  const tool = useEditor((s) => s.tool);
  const style = useEditor((s) => s.style);
  const selected = useEditor((s) => s.selected);
  const editingText = useEditor((s) => s.editingText);
  const pending = useEditor((s) => s.pendingImage);
  const { apply, select, setEditingText, setTool, setPendingImage } = useEditor.getState();

  const wrap = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const g = useMemo(
    () => (info ? makeGeom(info.view, (info.rotate + entry.rotation) % 360, scale) : null),
    [info, entry.rotation, scale],
  );

  if (!info || !g) {
    return <div ref={wrap} className="flex-none animate-pulse bg-white shadow" style={{ width: 612 * scale, height: 792 * scale }} aria-label={`${label}, loading`} />;
  }

  const point = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  const add = (annot: Annotation, edit = false) => {
    const id = newId();
    apply({ op: "annot.add", id, page: entry.ref, annot });
    select(id);
    if (edit) setEditingText(id);
    return id;
  };

  function onPointerDown(e: React.PointerEvent) {
    if (!interactive || e.button !== 0 || !g) return;
    // A click outside an open text box finishes that box; it doesn't start a new one.
    if (useEditor.getState().editingText) {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur(); // blur is synchronous and runs commit()
      if (useEditor.getState().editingText) setEditingText(null);
      return;
    }
    const [x, y] = point(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    switch (tool) {
      case "select":
        select(null);
        setEditingText(null);
        return;
      case "text": {
        e.preventDefault(); // keep the browser's mousedown from moving focus away from the new box
        const [px, py] = toPdf(g, x, y);
        const h = style.size * 1.2 + 4;
        const rect = cssToRect(g, x, y, 200 * g.scale, h * g.scale);
        add({ kind: "text", rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }, text: "", font: style.font, size: style.size, color: style.color }, true);
        void px; void py;
        return;
      }
      case "note": {
        const [px, py] = toPdf(g, x, y);
        add({ kind: "note", at: [round(px), round(py)], text: "" });
        setTool("select");
        return;
      }
      case "image":
      case "signature": {
        if (!pending) return;
        const w = pending.w * g.scale;
        const h = pending.h * g.scale;
        const rect = cssToRect(g, x - w / 2, y - h / 2, w, h);
        add({ kind: tool, rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) }, dataUrl: pending.dataUrl });
        setPendingImage(null);
        setTool("select");
        return;
      }
      case "draw":
        setDrag({ kind: "ink", pts: [x, y] });
        return;
      case "arrow":
        setDrag({ kind: "line", x0: x, y0: y, x1: x, y1: y });
        return;
      default:
        setDrag({ kind: "rect", x0: x, y0: y, x1: x, y1: y });
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const [x, y] = point(e);
    if (drag.kind === "ink") {
      const n = drag.pts.length;
      if (Math.hypot(x - drag.pts[n - 2]!, y - drag.pts[n - 1]!) >= 1.5) setDrag({ ...drag, pts: [...drag.pts, x, y] });
    } else {
      setDrag({ ...drag, x1: x, y1: y });
    }
  }

  function onPointerUp() {
    if (!drag || !g) return;
    setDrag(null);
    if (drag.kind === "ink") {
      if (drag.pts.length < 4) return;
      const pts: number[] = [];
      for (let i = 0; i + 1 < drag.pts.length; i += 2) {
        const [px, py] = toPdf(g, drag.pts[i]!, drag.pts[i + 1]!);
        pts.push(round(px), round(py));
      }
      add({ kind: "ink", strokes: [pts], width: style.width, color: style.color });
      return;
    }
    const dx = drag.x1 - drag.x0;
    const dy = drag.y1 - drag.y0;
    if (drag.kind === "move" || drag.kind === "resize") {
      const current = annotations.find((a) => a.id === drag.id);
      if (!current || (Math.abs(dx) < 1 && Math.abs(dy) < 1)) return;
      apply({ op: "annot.update", id: drag.id, annot: dragged(current.annot, drag, g) });
      return;
    }
    if (Math.hypot(dx, dy) < MIN_DRAG) return;
    if (drag.kind === "line") {
      const from = toPdf(g, drag.x0, drag.y0);
      const to = toPdf(g, drag.x1, drag.y1);
      add({ kind: "arrow", from: [round(from[0]), round(from[1])], to: [round(to[0]), round(to[1])], stroke: style.stroke, width: style.width });
      return;
    }
    const r = cssToRect(g, Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(dx), Math.abs(dy));
    const rect = { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) };
    if (tool === "highlight") add({ kind: "highlight", rect, color: style.highlight });
    else if (tool === "whiteout") add({ kind: "whiteout", rect });
    else if (tool === "ellipse") add({ kind: "ellipse", rect, stroke: style.stroke, fill: null, width: style.width });
    else add({ kind: "rect", rect, stroke: style.stroke, fill: null, width: style.width });
  }

  // Live preview of the annotation being moved or resized.
  const shown = annotations.map((p) =>
    drag && (drag.kind === "move" || drag.kind === "resize") && drag.id === p.id ? { ...p, annot: dragged(p.annot, drag, g) } : p,
  );
  const sel = shown.find((p) => p.id === selected);
  const cursor = tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";

  return (
    <div
      ref={wrap}
      role="group"
      aria-label={label}
      className="relative flex-none select-none bg-white shadow-[0_1px_4px_rgba(24,24,27,0.14)]"
      style={{ width: g.width, height: g.height, cursor, touchAction: interactive && tool !== "select" ? "none" : "auto" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <PageCanvas info={info} g={g} visible={visible} />
      <svg className="pointer-events-none absolute inset-0" width={g.width} height={g.height} aria-hidden="true">
        {shown.map((p) => <ShapeSvg key={p.id} a={p.annot} g={g} />)}
        {drag?.kind === "rect" && (
          tool === "ellipse"
            ? <ellipse cx={(drag.x0 + drag.x1) / 2} cy={(drag.y0 + drag.y1) / 2} rx={Math.abs(drag.x1 - drag.x0) / 2} ry={Math.abs(drag.y1 - drag.y0) / 2} fill="none" stroke={style.stroke} strokeWidth={style.width * g.scale} />
            : <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
                fill={tool === "highlight" ? style.highlight : tool === "whiteout" ? "#FFFFFF" : "none"} fillOpacity={tool === "highlight" ? 0.4 : 1}
                stroke={tool === "highlight" ? "none" : tool === "whiteout" ? "#A1A1AA" : style.stroke} strokeWidth={tool === "whiteout" ? 1 : style.width * g.scale} />
        )}
        {drag?.kind === "line" && <line x1={drag.x0} y1={drag.y0} x2={drag.x1} y2={drag.y1} stroke={style.stroke} strokeWidth={style.width * g.scale} strokeLinecap="round" />}
        {drag?.kind === "ink" && (
          <polyline points={drag.pts.join(" ")} fill="none" stroke={style.color} strokeWidth={style.width * g.scale} strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
      {shown.map((p) => (p.id === editingText ? null : <HtmlAnnotation key={p.id} a={p.annot} g={g} />))}

      {/* Hit boxes for selecting and moving (select tool only). */}
      {interactive && tool === "select" &&
        shown.map((p) => {
          const b = rectToCss(g, boundsOf(p.annot));
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              aria-label={`${p.annot.kind} annotation`}
              aria-pressed={p.id === selected}
              className="absolute"
              style={{ left: b.left - 4, top: b.top - 4, width: b.width + 8, height: b.height + 8, cursor: "move" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.button !== 0) return;
                (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                select(p.id);
                const [x, y] = point(e);
                setDrag({ kind: "move", id: p.id, x0: x, y0: y, x1: x, y1: y });
              }}
              onDoubleClick={() => p.annot.kind === "text" && setEditingText(p.id)}
              onKeyDown={(e) => e.key === "Enter" && p.annot.kind === "text" && setEditingText(p.id)}
            />
          );
        })}

      {sel && interactive && tool === "select" && (() => {
        const b = rectToCss(g, boundsOf(sel.annot));
        return (
          <>
            <div className="pointer-events-none absolute border-[1.5px] border-dashed border-brand-600" style={{ left: b.left - 4, top: b.top - 4, width: b.width + 8, height: b.height + 8 }} />
            {hasRect(sel.annot) && (
              <div
                role="button"
                aria-label="Resize"
                className="absolute size-3 cursor-nwse-resize rounded-sm border-[1.5px] border-brand-600 bg-white"
                style={{ left: b.left + b.width - 2, top: b.top + b.height - 2 }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                  const [x, y] = point(e);
                  setDrag({ kind: "resize", id: sel.id, x0: x, y0: y, x1: x, y1: y });
                }}
              />
            )}
          </>
        );
      })()}

      {editingText && (() => {
        const p = shown.find((x) => x.id === editingText);
        if (!p || p.annot.kind !== "text") return null;
        return <TextEditor key={p.id} placed={p} annot={p.annot} g={g} />;
      })()}
    </div>
  );
}

function dragged(a: Annotation, d: Extract<Drag, { kind: "move" | "resize" }>, g: PageGeom): Annotation {
  if (d.kind === "move") {
    const [ax, ay] = toPdf(g, d.x0, d.y0);
    const [bx, by] = toPdf(g, d.x1, d.y1);
    return translate(a, bx - ax, by - ay);
  }
  if (!hasRect(a)) return a;
  const c = rectToCss(g, a.rect);
  const r = cssToRect(g, c.left, c.top, Math.max(8, c.width + d.x1 - d.x0), Math.max(8, c.height + d.y1 - d.y0));
  return { ...a, rect: { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) } } as Annotation;
}

function TextEditor({ placed, annot, g }: { placed: PlacedAnnotation; annot: Extract<Annotation, { kind: "text" }>; g: PageGeom }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const c = rectToCss(g, annot.rect);
  useEffect(() => {
    ref.current?.focus();
    // Fallback: if the click that made the box still moved focus, take it back once the pointer sequence ends.
    const t = window.setTimeout(() => { if (document.activeElement !== ref.current) ref.current?.focus(); }, 0);
    return () => window.clearTimeout(t);
  }, []);

  function commit() {
    const el = ref.current;
    const { apply, setEditingText, select } = useEditor.getState();
    setEditingText(null);
    if (!el) return;
    const text = el.value;
    if (!text.trim()) {
      apply({ op: "annot.delete", id: placed.id });
      select(null);
      return;
    }
    const r = cssToRect(g, c.left, c.top, c.width, Math.max(c.height, el.scrollHeight));
    if (text !== annot.text || Math.abs(r.h - annot.rect.h) > 0.5) {
      apply({ op: "annot.update", id: placed.id, annot: { ...annot, text, rect: { x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) } } });
    }
  }

  return (
    <textarea
      ref={ref}
      aria-label="Text"
      defaultValue={annot.text}
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
      }}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = `${Math.max(c.height, el.scrollHeight)}px`;
      }}
      className="absolute resize-none overflow-hidden border-[1.5px] border-brand-600 bg-white/90 outline-none"
      style={{ left: c.left, top: c.top, width: c.width, height: c.height, padding: 2 * g.scale, fontFamily: FONT_CSS[annot.font], fontSize: annot.size * g.scale, lineHeight: 1.2, color: annot.color }}
    />
  );
}
