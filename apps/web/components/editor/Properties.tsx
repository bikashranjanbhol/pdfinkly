"use client";

import { newId, type Annotation, type PlacedAnnotation } from "@pdfinkly/shared";
import { describe, translate } from "./annotations";
import { useEditor } from "./store";
import { toolHint } from "./Toolbar";

const COLORS = ["#18181B", "#B91C1C", "#1D4ED8", "#15803D", "#C2410C"];
const HIGHLIGHTS = ["#FACC15", "#4ADE80", "#60A5FA", "#F472B6"];

function Swatches({ value, options, onChange, label }: { value: string; options: string[]; onChange: (c: string) => void; label: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-[13px] font-semibold text-zinc-700">{label}</legend>
      <div className="flex gap-2">
        {options.map((c) => (
          <button key={c} type="button" aria-label={c} aria-pressed={value.toUpperCase() === c}
            onClick={() => onChange(c)}
            className="size-8 rounded-full border-2 border-white"
            style={{ background: c, boxShadow: value.toUpperCase() === c ? "0 0 0 2px #2563EB" : "0 0 0 1px #D4D4D8" }} />
        ))}
      </div>
    </fieldset>
  );
}

export function Properties({ annotations }: { annotations: PlacedAnnotation[] }) {
  const tool = useEditor((s) => s.tool);
  const style = useEditor((s) => s.style);
  const selected = useEditor((s) => s.selected);
  const { apply, setStyle, select } = useEditor.getState();
  const sel = annotations.find((a) => a.id === selected);

  const update = (annot: Annotation) => sel && apply({ op: "annot.update", id: sel.id, annot });

  const colorOf = (a: Annotation) =>
    a.kind === "text" || a.kind === "ink" ? a.color : a.kind === "highlight" ? a.color : "stroke" in a ? a.stroke : null;
  function setColor(c: string) {
    if (!sel) return;
    const a = sel.annot;
    if (a.kind === "text" || a.kind === "ink" || a.kind === "highlight") update({ ...a, color: c });
    else if ("stroke" in a) update({ ...a, stroke: c });
  }

  return (
    <aside aria-label="Properties" className="flex w-full flex-col gap-5 overflow-y-auto border-l border-zinc-200 bg-white p-5 lg:w-[290px] lg:flex-none">
      <div className="rounded-[10px] bg-brand-50 px-3 py-2.5 text-[13px] text-brand-900">{toolHint(tool)}</div>

      {sel ? (
        <section aria-labelledby="sel-h" className="flex flex-col gap-4">
          <h2 id="sel-h" className="text-[15px] font-semibold">Selected: {describe(sel.annot)}</h2>
          {sel.annot.kind === "text" && (() => {
            const a = sel.annot;
            return (
              <>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Font
                  <select className="field h-10" value={a.font} onChange={(e) => update({ ...a, font: e.target.value as typeof a.font })}>
                    <option value="Helvetica">Helvetica</option>
                    <option value="TimesRoman">Times Roman</option>
                    <option value="Courier">Courier</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Size
                  <input className="field h-10" type="number" min={6} max={96} value={a.size}
                    onChange={(e) => { const n = Number(e.target.value); if (n >= 6 && n <= 96) update({ ...a, size: n }); }} />
                </label>
              </>
            );
          })()}
          {sel.annot.kind === "note" && (() => {
            const a = sel.annot;
            return (
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Note text
                <textarea key={sel.id} className="field h-28 py-2" defaultValue={a.text} onBlur={(e) => e.target.value !== a.text && update({ ...a, text: e.target.value })} />
              </label>
            );
          })()}
          {colorOf(sel.annot) && (
            <Swatches label="Color" value={colorOf(sel.annot)!} options={sel.annot.kind === "highlight" ? HIGHLIGHTS : COLORS} onChange={setColor} />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary min-h-10 flex-1 text-sm"
              onClick={() => { const id = newId(); apply({ op: "annot.add", id, page: sel.page, annot: translate(sel.annot, 12, -12) }); select(id); }}>
              Duplicate
            </button>
            <button type="button" className="btn-danger min-h-10 flex-1 text-sm" onClick={() => { apply({ op: "annot.delete", id: sel.id }); select(null); }}>
              Delete
            </button>
          </div>
        </section>
      ) : (
        <section aria-labelledby="style-h" className="flex flex-col gap-4">
          <h2 id="style-h" className="text-[15px] font-semibold">Style for new items</h2>
          {tool === "highlight" ? (
            <Swatches label="Highlight" value={style.highlight} options={HIGHLIGHTS} onChange={(c) => setStyle({ highlight: c })} />
          ) : tool === "rect" || tool === "ellipse" || tool === "arrow" ? (
            <Swatches label="Outline" value={style.stroke} options={COLORS} onChange={(c) => setStyle({ stroke: c })} />
          ) : (
            <Swatches label="Color" value={style.color} options={COLORS} onChange={(c) => setStyle({ color: c })} />
          )}
          {tool === "text" && (
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
              Font size
              <input className="field h-10" type="number" min={6} max={96} value={style.size} onChange={(e) => setStyle({ size: Number(e.target.value) || 12 })} />
            </label>
          )}
          {(tool === "draw" || tool === "rect" || tool === "ellipse" || tool === "arrow") && (
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
              Line width: {style.width} pt
              <input type="range" min={0.5} max={8} step={0.5} value={style.width} onChange={(e) => setStyle({ width: Number(e.target.value) })} />
            </label>
          )}
        </section>
      )}

      <section aria-labelledby="list-h" className="flex flex-col gap-1 border-t border-zinc-200 pt-4">
        <h2 id="list-h" className="mb-1 text-[15px] font-semibold">Your edits · {annotations.length}</h2>
        {annotations.length === 0 && <p className="text-[13px] text-zinc-500">Nothing yet. Pick a tool and click on the page.</p>}
        {annotations.map((a) => (
          <button key={a.id} type="button" onClick={() => { useEditor.getState().setTool("select"); select(a.id); }}
            className={`truncate rounded-lg px-2 py-2 text-left text-sm ${a.id === selected ? "bg-brand-50 text-brand-900" : "hover:bg-zinc-50"}`}>
            {describe(a.annot)}
          </button>
        ))}
      </section>
    </aside>
  );
}
