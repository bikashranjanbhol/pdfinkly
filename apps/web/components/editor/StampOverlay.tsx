"use client";

import { useEffect, useState } from "react";
import { batesNumber, fillSlot, parsePageRange, slotStart, stampDate, startFor, watermarkCentres, type DocModel } from "@pdfinkly/shared";
import type { PageGeom } from "./geometry";

const CSS_FONT = { Helvetica: "Helvetica, Arial, sans-serif", TimesRoman: "'Times New Roman', Times, serif", Courier: "'Courier New', Courier, monospace" } as const;

let measurer: CanvasRenderingContext2D | null = null;
/** Width of text in a standard font at `size`, in the same units. */
export function measureText(text: string, size: number, bold: boolean, font: keyof typeof CSS_FONT = "Helvetica"): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * size * 0.55;
  measurer.font = `${bold ? "bold " : ""}100px ${CSS_FONT[font]}`;
  return (measurer.measureText(text).width / 100) * size;
}

function useImageSize(src: string | undefined) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!src) { setSize(null); return; }
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
  }, [src]);
  return size;
}

/** Preview of the page stamps (watermark, …) as they'll be drawn on export. */
export function StampOverlay({ stamps, g, pageNo, pageCount, fileName = "" }: { stamps: DocModel["stamps"]; g: PageGeom; pageNo: number; pageCount: number; fileName?: string }) {
  const wm = stamps.watermark;
  const imgSize = useImageSize(wm?.image);
  const W = g.width / g.scale, H = g.height / g.scale;
  // Visual y-up points → CSS px.
  const css = (x: number, y: number): [number, number] => [x * g.scale, g.height - y * g.scale];
  const els: React.ReactNode[] = [];

  const hf = stamps.headerFooter;
  if (hf) {
    const which = [...(parsePageRange(hf.pages, pageCount) ?? [])].sort((a, b) => a - b);
    const k = which.indexOf(pageNo);
    if (k >= 0) {
      const v = { page: hf.startAt + k, pages: hf.startAt + which.length - 1, date: stampDate(), file: fileName };
      for (const top of [true, false]) {
        (top ? hf.top : hf.bottom).forEach((t, slot) => {
          const text = fillSlot(t, v).trim();
          if (!text) return;
          const w = measureText(text, hf.size, false, hf.font);
          const [x, y] = css(...slotStart(slot, top, W, H, w, hf.size, hf.margin));
          els.push(<text key={`hf${top}${slot}`} x={x} y={y} fill={hf.color} fontSize={hf.size * g.scale} fontFamily={CSS_FONT[hf.font]} style={{ whiteSpace: "pre" }}>{text}</text>);
        });
      }
    }
  }

  const bates = stamps.bates;
  if (bates) {
    const which = [...(parsePageRange(bates.pages, pageCount) ?? [])].sort((a, b) => a - b);
    const k = which.indexOf(pageNo);
    if (k >= 0) {
      const text = batesNumber(bates, k);
      const w = measureText(text, bates.size, false, bates.font);
      const [x, y] = css(...slotStart(bates.slot, bates.top, W, H, w, bates.size, bates.margin));
      els.push(<text key="bates" x={x} y={y} fill={bates.color} fontSize={bates.size * g.scale} fontFamily={CSS_FONT[bates.font]} style={{ whiteSpace: "pre" }}>{text}</text>);
    }
  }

  if (wm && parsePageRange(wm.pages, pageCount)?.has(pageNo) && wm.image && imgSize) {
    const w = (W * wm.size) / 100, h = (w * imgSize.h) / imgSize.w;
    watermarkCentres(wm.layout, W, H, w, h, wm.angle).forEach(([cx, cy], i) => {
      const [x, y] = css(...startFor(cx, cy, w, h, wm.angle));
      els.push(<image key={`i${i}`} href={wm.image} x={x} y={y - h * g.scale} width={w * g.scale} height={h * g.scale} opacity={wm.opacity}
        preserveAspectRatio="none" transform={`rotate(${-wm.angle} ${x} ${y})`} />);
    });
  }
  const text = wm && parsePageRange(wm.pages, pageCount)?.has(pageNo) ? wm.text.trim() : "";
  if (wm && text) {
    const w = measureText(text, wm.size, wm.bold), h = wm.size * 0.72;
    watermarkCentres(wm.layout, W, H, w, h, wm.angle).forEach(([cx, cy], i) => {
      const [x, y] = css(...startFor(cx, cy, w, h, wm.angle));
      els.push(<text key={`t${i}`} x={x} y={y} fill={wm.color} fillOpacity={wm.opacity} fontSize={wm.size * g.scale} fontWeight={wm.bold ? 700 : 400}
        fontFamily="Helvetica, Arial, sans-serif" style={{ whiteSpace: "pre" }} transform={`rotate(${-wm.angle} ${x} ${y})`}>{text}</text>);
    });
  }
  if (!els.length) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 overflow-hidden" width={g.width} height={g.height} aria-hidden="true" data-testid="stamp-preview">
      {els}
    </svg>
  );
}
