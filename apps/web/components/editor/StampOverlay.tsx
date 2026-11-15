"use client";

import { useEffect, useState } from "react";
import { parsePageRange, startFor, watermarkCentres, type DocModel } from "@pdfinkly/shared";
import type { PageGeom } from "./geometry";

let measurer: CanvasRenderingContext2D | null = null;
/** Width of text in Helvetica (Arial on most systems) at `size`, in the same units. */
export function measureHelvetica(text: string, size: number, bold: boolean): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return text.length * size * 0.55;
  measurer.font = `${bold ? "bold " : ""}100px Helvetica, Arial, sans-serif`;
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
export function StampOverlay({ stamps, g, pageNo, pageCount }: { stamps: DocModel["stamps"]; g: PageGeom; pageNo: number; pageCount: number }) {
  const wm = stamps.watermark;
  const imgSize = useImageSize(wm?.image);
  if (!wm || !(parsePageRange(wm.pages, pageCount)?.has(pageNo))) return null;
  const W = g.width / g.scale, H = g.height / g.scale;
  // Visual y-up points → CSS px.
  const css = (x: number, y: number): [number, number] => [x * g.scale, g.height - y * g.scale];
  const els: React.ReactNode[] = [];

  if (wm.image && imgSize) {
    const w = (W * wm.size) / 100, h = (w * imgSize.h) / imgSize.w;
    watermarkCentres(wm.layout, W, H, w, h, wm.angle).forEach(([cx, cy], i) => {
      const [x, y] = css(...startFor(cx, cy, w, h, wm.angle));
      els.push(<image key={`i${i}`} href={wm.image} x={x} y={y - h * g.scale} width={w * g.scale} height={h * g.scale} opacity={wm.opacity}
        preserveAspectRatio="none" transform={`rotate(${-wm.angle} ${x} ${y})`} />);
    });
  }
  const text = wm.text.trim();
  if (text) {
    const w = measureHelvetica(text, wm.size, wm.bold), h = wm.size * 0.72;
    watermarkCentres(wm.layout, W, H, w, h, wm.angle).forEach(([cx, cy], i) => {
      const [x, y] = css(...startFor(cx, cy, w, h, wm.angle));
      els.push(<text key={`t${i}`} x={x} y={y} fill={wm.color} fillOpacity={wm.opacity} fontSize={wm.size * g.scale} fontWeight={wm.bold ? 700 : 400}
        fontFamily="Helvetica, Arial, sans-serif" style={{ whiteSpace: "pre" }} transform={`rotate(${-wm.angle} ${x} ${y})`}>{text}</text>);
    });
  }
  return (
    <svg className="pointer-events-none absolute inset-0 overflow-hidden" width={g.width} height={g.height} aria-hidden="true" data-testid="stamp-preview">
      {els}
    </svg>
  );
}
