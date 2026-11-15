"use client";

import { useRef } from "react";
import {
  IconArrow, IconEllipse, IconEraser, IconHighlight, IconImage, IconNote, IconPen, IconRect, IconRedo,
  IconEditText, IconSelect, IconSign, IconText, IconUndo,
} from "../icons";
import { useEditor, type Tool } from "./store";

const TOOLS: { id: Tool; label: string; Icon: (p: { size?: number }) => React.JSX.Element; hint: string; modes: ("edit" | "sign")[] }[] = [
  { id: "select", label: "Select", Icon: IconSelect, hint: "Click an item to select it. Drag to move; use the corner to resize.", modes: ["edit", "sign"] },
  { id: "edittext", label: "Edit text", Icon: IconEditText, hint: "Hover over the PDF's own text to see its font, then click to edit it. The original text is removed from the file when you save.", modes: ["edit"] },
  { id: "text", label: "Add text", Icon: IconText, hint: "Click on the page to add a text box.", modes: ["edit", "sign"] },
  { id: "highlight", label: "Highlight", Icon: IconHighlight, hint: "Drag over text to highlight it.", modes: ["edit"] },
  { id: "draw", label: "Draw", Icon: IconPen, hint: "Draw freehand on the page.", modes: ["edit"] },
  { id: "rect", label: "Box", Icon: IconRect, hint: "Drag to draw a rectangle.", modes: ["edit"] },
  { id: "ellipse", label: "Circle", Icon: IconEllipse, hint: "Drag to draw an ellipse.", modes: ["edit"] },
  { id: "arrow", label: "Arrow", Icon: IconArrow, hint: "Drag to draw an arrow.", modes: ["edit"] },
  { id: "image", label: "Image", Icon: IconImage, hint: "Choose an image, then click where it should go.", modes: ["edit"] },
  { id: "note", label: "Note", Icon: IconNote, hint: "Click to pin a note, then type it in the side panel.", modes: ["edit"] },
  { id: "signature", label: "Sign", Icon: IconSign, hint: "Pick or create a signature, then click where it goes.", modes: ["edit", "sign"] },
  { id: "whiteout", label: "Cover", Icon: IconEraser, hint: "Covers content with a white box. Text underneath can still be copied, so don't use it to hide secrets.", modes: ["edit"] },
];

export const toolHint = (t: Tool) => TOOLS.find((x) => x.id === t)?.hint ?? "";

export function Toolbar({ onNeedSignature, pageLabel }: { onNeedSignature: () => void; pageLabel: string }) {
  const tool = useEditor((s) => s.tool);
  const mode = useEditor((s) => s.mode);
  const zoom = useEditor((s) => s.zoom);
  const canUndo = useEditor((s) => s.cursor > 0);
  const canRedo = useEditor((s) => s.cursor < s.ops.length);
  const { setTool, undo, redo, setZoom, setPendingImage } = useEditor.getState();
  const imageInput = useRef<HTMLInputElement>(null);

  function pick(t: Tool) {
    if (t === "image") {
      imageInput.current?.click();
      return;
    }
    if (t === "signature") {
      onNeedSignature();
      return;
    }
    setTool(t);
  }

  async function onImage(file: File) {
    if (file.size > 1.5 * 1024 * 1024) {
      alert("Please choose an image under 1.5 MB.");
      return;
    }
    const dataUrl = await toPngOrJpegDataUrl(file);
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const k = Math.min(1, 200 / Math.max(img.naturalWidth, img.naturalHeight));
    setTool("image");
    setPendingImage({ dataUrl, w: Math.round(img.naturalWidth * k), h: Math.round(img.naturalHeight * k) });
  }

  return (
    <div role="toolbar" aria-label="Editing tools" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white px-4 py-1.5">
      <div className="flex flex-wrap gap-0.5">
        {TOOLS.filter((t) => t.modes.includes(mode as "edit" | "sign")).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => pick(id)}
            aria-pressed={tool === id}
            className={`flex h-[52px] min-w-14 flex-col items-center justify-center gap-0.5 rounded-[10px] px-1.5 ${tool === id ? "bg-brand-50 text-brand-700" : "text-zinc-700 hover:bg-zinc-100"}`}
          >
            <Icon size={20} />
            <span className="text-[11px] font-semibold">{label}</span>
          </button>
        ))}
      </div>
      <input ref={imageInput} type="file" accept="image/png,image/jpeg" className="sr-only" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onImage(f); }} />
      <span className="h-8 w-px bg-zinc-200" />
      <div className="flex gap-0.5">
        <button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo} className="btn-ghost min-h-10 px-2.5"><IconUndo /></button>
        <button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo} className="btn-ghost min-h-10 px-2.5"><IconRedo /></button>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center rounded-[10px] border border-zinc-200">
          <button type="button" aria-label="Zoom out" className="size-9 text-lg text-zinc-700" onClick={() => setZoom(zoom - 0.1)}>−</button>
          <span className="min-w-[52px] text-center text-sm font-semibold">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" className="size-9 text-lg text-zinc-700" onClick={() => setZoom(zoom + 0.1)}>+</button>
        </div>
        <span className="text-sm text-zinc-600">{pageLabel}</span>
      </div>
    </div>
  );
}

/** Keep PNG/JPEG as-is; convert anything else (e.g. WebP) to PNG through a canvas. */
export async function toPngOrJpegDataUrl(file: File | Blob): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  if (/^data:image\/(png|jpeg);base64,/.test(dataUrl)) return dataUrl;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return c.toDataURL("image/png");
}
