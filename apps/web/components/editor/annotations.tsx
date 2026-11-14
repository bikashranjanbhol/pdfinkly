"use client";

import type { Annotation, Rect } from "@pdfinkly/shared";
import { rectToCss, toCss, type PageGeom } from "./geometry";

export const FONT_CSS: Record<string, string> = {
  Helvetica: "Helvetica, Arial, sans-serif",
  TimesRoman: "'Times New Roman', Times, serif",
  Courier: "'Courier New', Courier, monospace",
};

export const hasRect = (a: Annotation): a is Extract<Annotation, { rect: Rect }> => "rect" in a;

/** Bounding rect of any annotation in PDF space (for selection boxes). */
export function boundsOf(a: Annotation): Rect {
  if (hasRect(a)) return a.rect;
  if (a.kind === "line" || a.kind === "arrow") {
    const [x1, y1] = a.from;
    const [x2, y2] = a.to;
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  if (a.kind === "note") return { x: a.at[0], y: a.at[1] - 14, w: 14, h: 14 };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of a.strokes) for (let i = 0; i + 1 < s.length; i += 2) { xs.push(s[i]!); ys.push(s[i + 1]!); }
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  const r = (v: number) => Math.round(v * 100) / 100;
  if (hasRect(a)) return { ...a, rect: { ...a.rect, x: r(a.rect.x + dx), y: r(a.rect.y + dy) } } as Annotation;
  if (a.kind === "line" || a.kind === "arrow") {
    return { ...a, from: [r(a.from[0] + dx), r(a.from[1] + dy)], to: [r(a.to[0] + dx), r(a.to[1] + dy)] };
  }
  if (a.kind === "note") return { ...a, at: [r(a.at[0] + dx), r(a.at[1] + dy)] };
  return { ...a, strokes: a.strokes.map((s) => s.map((v, i) => r(v + (i % 2 === 0 ? dx : dy)))) };
}

const LABEL: Record<Annotation["kind"], string> = {
  text: "Text", highlight: "Highlight", ink: "Drawing", rect: "Rectangle", ellipse: "Ellipse", line: "Line",
  arrow: "Arrow", image: "Image", signature: "Signature", note: "Note", whiteout: "White-out",
};
export const describe = (a: Annotation) =>
  a.kind === "text" ? a.text.split("\n")[0] || "Text" : a.kind === "note" ? `Note · ${a.text.slice(0, 40) || "empty"}` : LABEL[a.kind];

/** Shapes drawn in one SVG layer (CSS px space). */
export function ShapeSvg({ a, g }: { a: Annotation; g: PageGeom }) {
  const w = (n: number) => Math.max(1, n * g.scale);
  switch (a.kind) {
    case "highlight": {
      const c = rectToCss(g, a.rect);
      return <rect x={c.left} y={c.top} width={c.width} height={c.height} fill={a.color} fillOpacity={0.4} style={{ mixBlendMode: "multiply" }} />;
    }
    case "whiteout": {
      const c = rectToCss(g, a.rect);
      return <rect x={c.left} y={c.top} width={c.width} height={c.height} fill="#FFFFFF" stroke="#D4D4D8" strokeDasharray="3 3" strokeWidth={0.5} />;
    }
    case "rect": {
      const c = rectToCss(g, a.rect);
      return <rect x={c.left} y={c.top} width={c.width} height={c.height} fill={a.fill ?? "none"} stroke={a.stroke} strokeWidth={w(a.width)} />;
    }
    case "ellipse": {
      const c = rectToCss(g, a.rect);
      return <ellipse cx={c.left + c.width / 2} cy={c.top + c.height / 2} rx={c.width / 2} ry={c.height / 2} fill={a.fill ?? "none"} stroke={a.stroke} strokeWidth={w(a.width)} />;
    }
    case "line":
    case "arrow": {
      const [x1, y1] = toCss(g, ...a.from);
      const [x2, y2] = toCss(g, ...a.to);
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.max(8, a.width * 4) * g.scale;
      const head = a.kind === "arrow"
        ? [-1, 1].map((side) => {
            const t = ang + Math.PI + side * (Math.PI / 7);
            return `M${x2} ${y2}L${x2 + len * Math.cos(t)} ${y2 + len * Math.sin(t)}`;
          }).join("")
        : "";
      return <path d={`M${x1} ${y1}L${x2} ${y2}${head}`} stroke={a.stroke} strokeWidth={w(a.width)} strokeLinecap="round" fill="none" />;
    }
    case "ink":
      return (
        <g stroke={a.color} strokeWidth={w(a.width)} strokeLinecap="round" strokeLinejoin="round" fill="none">
          {a.strokes.map((s, i) => {
            let d = "";
            for (let j = 0; j + 1 < s.length; j += 2) {
              const [x, y] = toCss(g, s[j]!, s[j + 1]!);
              d += `${j === 0 ? "M" : "L"}${x} ${y}`;
            }
            return <path key={i} d={d} />;
          })}
        </g>
      );
    default:
      return null;
  }
}

/** Content drawn as HTML: text, images, signatures, notes. */
export function HtmlAnnotation({ a, g }: { a: Annotation; g: PageGeom }) {
  if (a.kind === "text") {
    const c = rectToCss(g, a.rect);
    return (
      <div
        className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words"
        style={{ ...c, padding: 2 * g.scale, fontFamily: FONT_CSS[a.font], fontSize: a.size * g.scale, lineHeight: 1.2, color: a.color }}
      >
        {a.text}
      </div>
    );
  }
  if (a.kind === "image" || a.kind === "signature") {
    const c = rectToCss(g, a.rect);
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={a.dataUrl} alt="" draggable={false} className="pointer-events-none absolute select-none" style={c} />;
  }
  if (a.kind === "note") {
    const [x, y] = toCss(g, a.at[0], a.at[1]);
    const s = 14 * g.scale;
    return (
      <div title={a.text || "Empty note"} className="pointer-events-none absolute flex items-center justify-center rounded-[3px] border border-yellow-800/60 bg-yellow-400 shadow-sm" style={{ left: x, top: y, width: s, height: s }}>
        <svg width={s * 0.6} height={s * 0.6} viewBox="0 0 24 24" stroke="#713F12" strokeWidth={3} fill="none" aria-hidden="true"><path d="M5 8h14M5 12h14M5 16h9" /></svg>
      </div>
    );
  }
  return null;
}
