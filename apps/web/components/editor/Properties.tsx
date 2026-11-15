"use client";

import { describeFont, matchFont, newId, type Annotation, type Face, type PlacedAnnotation } from "@pdfinkly/shared";
import { describe, translate } from "./annotations";
import { useEditor } from "./store";
import { toolHint } from "./Toolbar";

const FACE_LABEL: Record<Face, string> = {
  Carlito: "Carlito (Calibri-compatible)",
  Caladea: "Caladea (Cambria-compatible)",
  Helvetica: "Helvetica / Arial",
  TimesRoman: "Times",
  Courier: "Courier",
};
const METRIC_TWIN: Partial<Record<Face, string>> = { Carlito: "Calibri", Caladea: "Cambria", Helvetica: "Arial", TimesRoman: "Times" };

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
    a.kind === "text" || a.kind === "ink" || a.kind === "replace" ? a.color : a.kind === "highlight" ? a.color : "stroke" in a ? a.stroke : null;
  function setColor(c: string) {
    if (!sel) return;
    const a = sel.annot;
    if (a.kind === "text" || a.kind === "ink" || a.kind === "highlight" || a.kind === "replace") update({ ...a, color: c });
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
          {sel.annot.kind === "replace" && (() => {
            const a = sel.annot;
            const orig = matchFont(a.srcFont);
            const substituted = orig.face !== a.face || orig.family.toLowerCase().replace(/\s/g, "") !== a.face.toLowerCase();
            return (
              <>
                <div className="rounded-[10px] border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-[13px]">
                  <div className="text-zinc-500">Font in the PDF</div>
                  <div className="font-semibold text-ink">{describeFont(a.srcFont, a.size)}</div>
                  <div className="text-zinc-500">{orig.subset ? "Embedded (only the characters used)" : "Embedded or standard font"}</div>
                  {substituted && (
                    <p className="mt-1.5 text-zinc-600">Redrawn with <b>{FACE_LABEL[a.face]}</b>{METRIC_TWIN[a.face] && orig.family.toLowerCase().includes(METRIC_TWIN[a.face]!.toLowerCase()) ? ", which has identical letter widths" : ", the closest available match"}.</p>
                  )}
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Typeface
                  <select className="field h-10" value={a.face} onChange={(e) => update({ ...a, face: e.target.value as Face })}>
                    {(Object.keys(FACE_LABEL) as Face[]).map((f) => <option key={f} value={f}>{FACE_LABEL[f]}</option>)}
                  </select>
                </label>
                <div className="flex gap-2" role="group" aria-label="Style">
                  <button type="button" aria-pressed={a.bold} onClick={() => update({ ...a, bold: !a.bold })}
                    className={`min-h-10 flex-1 rounded-[10px] border text-sm font-bold ${a.bold ? "border-brand-600 bg-brand-50 text-brand-800" : "border-zinc-300"}`}>Bold</button>
                  <button type="button" aria-pressed={a.italic} onClick={() => update({ ...a, italic: !a.italic })}
                    className={`min-h-10 flex-1 rounded-[10px] border text-sm italic ${a.italic ? "border-brand-600 bg-brand-50 text-brand-800" : "border-zinc-300"}`}>Italic</button>
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                  Size (pt)
                  <input className="field h-10" type="number" min={2} max={200} step={0.5} value={a.size}
                    onChange={(e) => { const n = Number(e.target.value); if (n >= 2 && n <= 200) update({ ...a, size: n, lineHeight: Math.round(a.lineHeight * (n / a.size) * 100) / 100 }); }} />
                </label>
                <button type="button" className="btn-secondary min-h-10 text-sm" onClick={() => useEditor.getState().setEditingText(sel.id)}>Edit the words</button>
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
            <Swatches label="Color" value={colorOf(sel.annot)!}
              options={sel.annot.kind === "highlight" ? HIGHLIGHTS : COLORS.includes(colorOf(sel.annot)!.toUpperCase()) ? COLORS : [colorOf(sel.annot)!.toUpperCase(), ...COLORS.slice(0, 4)]}
              onChange={setColor} />
          )}
          {sel.annot.kind === "replace" ? (
            <button type="button" className="btn-danger min-h-10 text-sm" onClick={() => { apply({ op: "annot.delete", id: sel.id }); select(null); }}>
              Restore original text
            </button>
          ) : <div className="flex gap-2">
            <button type="button" className="btn-secondary min-h-10 flex-1 text-sm"
              onClick={() => { const id = newId(); apply({ op: "annot.add", id, page: sel.page, annot: translate(sel.annot, 12, -12) }); select(id); }}>
              Duplicate
            </button>
            <button type="button" className="btn-danger min-h-10 flex-1 text-sm" onClick={() => { apply({ op: "annot.delete", id: sel.id }); select(null); }}>
              Delete
            </button>
          </div>}
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
