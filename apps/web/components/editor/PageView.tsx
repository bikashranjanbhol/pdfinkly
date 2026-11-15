"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { describeFont, FACE_METRICS, matchFont, newId, OCR_FONT_NAME, type Annotation, type PageEntry, type PlacedAnnotation, type Rect } from "@pdfinkly/shared";
import { boundsOf, FACE_CSS, hasRect, HtmlAnnotation, ShapeSvg, translate, FONT_CSS } from "./annotations";
import { sampleColors, textBlocks, type TextBlock } from "./textBlocks";
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
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [hoverBlock, setHoverBlock] = useState<string | null>(null);
  const pageProxy = info?.page ?? null;
  const wantsBlocks = interactive && tool === "edittext" && !!pageProxy;

  useEffect(() => {
    if (!wantsBlocks || !pageProxy) return;
    let cancelled = false;
    textBlocks(pageProxy).then((b) => { if (!cancelled) setBlocks(b); });
    return () => { cancelled = true; };
  }, [wantsBlocks, pageProxy]);

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

  // Only text that reads upright on screen is editable in place.
  const upright = blocks?.filter((b) => b.rotation === g.rotation) ?? null;
  // When none does, the turn (clockwise) that would make most of the page's text upright.
  const sidewaysTurn = (() => {
    if (!blocks?.length || upright?.length) return null;
    const count = new Map<number, number>();
    for (const b of blocks) count.set(b.rotation, (count.get(b.rotation) ?? 0) + b.text.length);
    const [rot] = [...count].sort((a, b) => b[1] - a[1])[0]!;
    const turn = (rot - g.rotation + 360) % 360;
    return turn === 90 || turn === 180 || turn === 270 ? (turn as 90 | 180 | 270) : null;
  })();

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

  /** Turn a paragraph of the PDF's own text into an editable "replace" annotation. */
  function startEdit(block: TextBlock) {
    if (!g) return;
    const canvas = wrap.current?.querySelector("canvas") ?? null;
    const colors = canvas ? sampleColors(canvas, rectToCss(g, block.rect), g.width) : { fg: "#000000", bg: "#FFFFFF" };
    if (!editableScript(block.text)) return;
    // OCR text's font is unknown (its glyphless font even looks monospaced to PDF.js): use a neutral sans.
    const m = block.font.raw === OCR_FONT_NAME
      ? { face: "Helvetica" as const, bold: false, italic: false }
      : matchFont(block.font.raw, { serif: block.font.serif, mono: block.font.mono });
    const id = add({
      kind: "replace",
      rect: block.rect,
      cover: block.cover,
      text: block.text,
      original: block.text,
      face: m.face,
      bold: m.bold,
      italic: m.italic,
      size: block.size,
      color: colors.fg,
      bg: colors.bg,
      lineHeight: block.lineHeight,
      firstBaseline: block.firstBaseline,
      srcFont: block.font.raw.slice(0, 200),
      ...(block.rotation ? { rotation: block.rotation } : {}),
    }, true);
    freshReplace.add(id);
    setHoverBlock(null);
  }

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
      case "edittext":
        select(null);
        return;
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
    else if (tool === "redact") add({ kind: "redact", rect });
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
        {shown.map((p) => <ShapeSvg key={p.id} a={p.id === editingText && p.annot.kind === "replace" ? { ...p.annot, text: "" } : p.annot} g={g} />)}
        {drag?.kind === "rect" && (
          tool === "ellipse"
            ? <ellipse cx={(drag.x0 + drag.x1) / 2} cy={(drag.y0 + drag.y1) / 2} rx={Math.abs(drag.x1 - drag.x0) / 2} ry={Math.abs(drag.y1 - drag.y0) / 2} fill="none" stroke={style.stroke} strokeWidth={style.width * g.scale} />
            : <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
                fill={tool === "highlight" ? style.highlight : tool === "whiteout" ? "#FFFFFF" : tool === "redact" ? "#18181B" : "none"} fillOpacity={tool === "highlight" ? 0.4 : tool === "redact" ? 0.35 : 1}
                stroke={tool === "highlight" ? "none" : tool === "whiteout" ? "#A1A1AA" : tool === "redact" ? "#DC2626" : style.stroke} strokeWidth={tool === "whiteout" || tool === "redact" ? 1.5 : style.width * g.scale} />
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
              onDoubleClick={() => (p.annot.kind === "text" || p.annot.kind === "replace") && setEditingText(p.id)}
              onKeyDown={(e) => e.key === "Enter" && (p.annot.kind === "text" || p.annot.kind === "replace") && setEditingText(p.id)}
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

      {interactive && tool === "edittext" && !editingText && (
        <>
          {upright?.filter((b) => !shown.some((p) => p.annot.kind === "replace" && overlaps(p.annot.cover, b.cover))).map((b) => {
            const c = rectToCss(g, b.rect);
            const hot = hoverBlock === b.key;
            const editable = editableScript(b.text);
            return (
              <div
                key={b.key}
                role="button"
                tabIndex={0}
                aria-label={`Edit text: ${b.text.slice(0, 60)} (${describeFont(b.font.raw, b.size, b.font)})`}
                aria-disabled={!editable || undefined}
                className={`absolute rounded-[2px] ${editable ? "cursor-text" : "cursor-not-allowed"} ${hot ? (editable ? "outline outline-[1.5px] outline-brand-600" : "outline outline-[1.5px] outline-zinc-400") : "outline-dashed outline-1 outline-brand-600/25"}`}
                style={{ left: c.left - 2, top: c.top - 2, width: c.width + 4, height: c.height + 4 }}
                onPointerEnter={() => setHoverBlock(b.key)}
                onPointerLeave={() => setHoverBlock((k) => (k === b.key ? null : k))}
                onFocus={() => setHoverBlock(b.key)}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                onClick={() => startEdit(b)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), startEdit(b))}
              >
                {hot && <FontChip block={b} editable={editable} />}
              </div>
            );
          })}
          {shown.filter((p) => p.annot.kind === "replace" && (p.annot.rotation ?? 0) === g.rotation).map((p) => {
            const c = rectToCss(g, boundsOf(p.annot));
            return (
              <div key={p.id} role="button" tabIndex={0} aria-label="Edit this text again"
                className="absolute cursor-text rounded-[2px] outline outline-1 outline-emerald-600/60 hover:outline-[1.5px] hover:outline-emerald-600"
                style={{ left: c.left - 2, top: c.top - 2, width: c.width + 4, height: c.height + 4 }}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                onClick={() => { select(p.id); setEditingText(p.id); }}
                onKeyDown={(e) => e.key === "Enter" && (select(p.id), setEditingText(p.id))} />
            );
          })}
          {wantsBlocks && blocks === null && (
            <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-zinc-900/80 px-2 py-1 text-xs text-white">Finding text…</div>
          )}
          {sidewaysTurn !== null && (
            <div className="absolute inset-x-0 top-3 z-10 mx-auto flex w-fit max-w-[90%] flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg bg-zinc-900/90 px-3 py-2 text-center text-[13px] text-white">
              <span>{sidewaysTurn === 180 ? "The text on this page is upside down." : "The text on this page runs sideways."} Turn the page to edit it.</span>
              <button type="button" className="rounded-md bg-white px-2.5 py-1 text-[13px] font-semibold text-ink" onPointerDown={(e) => e.stopPropagation()}
                onClick={() => apply({ op: "page.rotate", page: entry.ref, degrees: sidewaysTurn })}>Turn page upright</button>
            </div>
          )}
          {blocks !== null && blocks.length === 0 && (
            <div className="absolute inset-x-0 top-3 z-10 mx-auto flex w-fit max-w-[90%] flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg bg-zinc-900/90 px-3 py-2 text-center text-[13px] text-white">
              <span>No text on this page. If it&apos;s a scan, the text is part of an image.</span>
              <button type="button" className="rounded-md bg-white px-2.5 py-1 text-[13px] font-semibold text-ink" onPointerDown={(e) => e.stopPropagation()}
                onClick={() => useEditor.getState().requestOcr()}>Recognise text</button>
            </div>
          )}
        </>
      )}

      {editingText && (() => {
        const p = shown.find((x) => x.id === editingText);
        if (!p) return null;
        if (p.annot.kind === "text") return <TextEditor key={p.id} placed={p} annot={p.annot} g={g} />;
        if (p.annot.kind === "replace") return <ReplaceEditor key={p.id} placed={p} annot={p.annot} g={g} />;
        return null;
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

/** Edits created by the current click; if the user leaves the text unchanged they're dropped again. */
const freshReplace = new Set<string>();

const overlaps = (a: Rect[], b: Rect[]) =>
  a.some((r) => b.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h));

/**
 * Edited text is redrawn with Latin fonts; scripts that need shaping (Devanagari and
 * other Indic scripts, Arabic, Hebrew, Thai) can't be redrawn correctly yet.
 */
const editableScript = (text: string) => !/[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0E7F]/.test(text);

function FontChip({ block, editable }: { block: TextBlock; editable: boolean }) {
  const m = matchFont(block.font.raw, block.font);
  const ocr = block.font.raw === OCR_FONT_NAME;
  const detail = !editable
    ? "editing Hindi and other non-Latin scripts isn't supported yet"
    : `${ocr ? "from a scan" : !block.font.embedded ? "not embedded" : m.subset ? "embedded (partial)" : "embedded"} · click to edit`;
  return (
    <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-1.5 flex w-max max-w-[320px] flex-col rounded-lg bg-zinc-900 px-2.5 py-1.5 text-left text-xs leading-snug text-white shadow-lg">
      <span className="font-semibold">{ocr ? `Recognised text (OCR) · ~${Math.round(block.size)} pt` : describeFont(block.font.raw, block.size, block.font)}</span>
      <span className="text-zinc-300">{detail}</span>
    </div>
  );
}

type ReplaceAnnot = Extract<Annotation, { kind: "replace" }>;

function ReplaceEditor({ placed, annot, g }: { placed: PlacedAnnotation; annot: ReplaceAnnot; g: PageGeom }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const c = rectToCss(g, annot.rect);
  const m = FACE_METRICS[annot.face];
  const S = annot.size * g.scale;
  const L = annot.lineHeight * g.scale;
  // Put the textarea's first baseline exactly on the original first baseline.
  const baselineInLine = (L - (m.ascent + m.descent) * S) / 2 + m.ascent * S;
  const top = c.top + annot.firstBaseline * g.scale - baselineInLine;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = `${el.scrollHeight}px`;
    const t = window.setTimeout(() => { if (document.activeElement !== el) el.focus(); }, 0);
    return () => window.clearTimeout(t);
  }, []);

  function commit() {
    const el = ref.current;
    const { apply, setEditingText, select } = useEditor.getState();
    setEditingText(null);
    if (!el) return;
    const text = el.value.replace(/\r\n?/g, "\n");
    if (freshReplace.has(placed.id) && text === annot.original) {
      // Opened and closed without changes: nothing to save.
      apply({ op: "annot.delete", id: placed.id });
      select(null);
    } else if (text !== annot.text) {
      apply({ op: "annot.update", id: placed.id, annot: { ...annot, text } });
    }
    freshReplace.delete(placed.id);
  }

  return (
    <textarea
      ref={ref}
      aria-label="Edit text"
      defaultValue={annot.text}
      spellCheck
      onBlur={commit}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur();
      }}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      }}
      className="absolute z-20 resize-none overflow-hidden rounded-[2px] p-0 outline outline-[1.5px] outline-offset-2 outline-brand-600"
      style={{
        left: c.left, top, width: c.width + 2, minHeight: c.height,
        background: annot.bg, color: annot.color, fontFamily: FACE_CSS[annot.face], fontSize: S,
        fontWeight: annot.bold ? 700 : 400, fontStyle: annot.italic ? "italic" : "normal",
        lineHeight: `${L}px`, whiteSpace: "pre-wrap", border: "none",
      }}
    />
  );
}
