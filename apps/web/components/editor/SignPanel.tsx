"use client";

import { useEffect, useState } from "react";
import type { DocModel } from "@pdfinkly/shared";
import { loadSaved, SAVED_EVENT, storeSaved, type SavedSignature } from "./SignatureDialog";
import { useEditor } from "./store";

export interface FormField {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "other";
  value: string | boolean;
  options?: string[];
}

/** Read the PDF's form fields with pdf-lib (client side, from the base bytes). */
export async function readFormFields(bytes: Uint8Array): Promise<FormField[]> {
  const { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = await import("pdf-lib");
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getForm().getFields().map((f): FormField => {
      const name = f.getName();
      if (f instanceof PDFTextField) return { name, type: "text", value: f.getText() ?? "" };
      if (f instanceof PDFCheckBox) return { name, type: "checkbox", value: f.isChecked() };
      if (f instanceof PDFDropdown || f instanceof PDFOptionList) return { name, type: "dropdown", value: f.getSelected()[0] ?? "", options: f.getOptions() };
      if (f instanceof PDFRadioGroup) return { name, type: "radio", value: f.getSelected() ?? "", options: f.getOptions() };
      return { name, type: "other", value: "" };
    }).filter((f) => f.type !== "other");
  } catch {
    return [];
  }
}

export function SignPanel({ fields, model, onCreateSignature }: { fields: FormField[]; model: DocModel; onCreateSignature: () => void }) {
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const { apply, setTool, setPendingImage } = useEditor.getState();
  useEffect(() => {
    const refresh = () => setSaved(loadSaved());
    refresh();
    window.addEventListener(SAVED_EVENT, refresh);
    return () => window.removeEventListener(SAVED_EVENT, refresh);
  }, []);

  const value = (f: FormField) => (f.name in model.form ? model.form[f.name]! : f.value);
  const set = (f: FormField, v: string | boolean) => v !== value(f) && apply({ op: "form.set", field: f.name, value: v });

  return (
    <aside aria-label="Fill and sign" className="flex w-full flex-col gap-5 overflow-y-auto border-r border-zinc-200 bg-white p-5 lg:w-[310px] lg:flex-none">
      <div>
        <h2 className="text-base font-semibold">Fill and sign</h2>
        <p className="mt-1 text-[13px] text-zinc-600">
          {fields.length ? `This PDF has ${fields.length} form field${fields.length > 1 ? "s" : ""}. Values are written into the PDF when you save or download.` : "No fillable fields found. Use the Text tool to type on the page."}
        </p>
      </div>
      {fields.map((f) => {
        const id = `ff-${f.name}`;
        const v = value(f);
        if (f.type === "checkbox") {
          return (
            <label key={f.name} className="flex items-center gap-2.5 text-sm">
              <input type="checkbox" className="size-[18px]" checked={v === true || v === "true"} onChange={(e) => set(f, e.target.checked)} />
              {f.name}
            </label>
          );
        }
        if (f.type === "dropdown" || f.type === "radio") {
          return (
            <label key={f.name} htmlFor={id} className="flex flex-col gap-1.5 text-[13px] font-semibold">
              {f.name}
              <select id={id} className="field h-10 font-normal" value={String(v)} onChange={(e) => set(f, e.target.value)}>
                <option value="">Choose…</option>
                {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          );
        }
        return (
          <label key={f.name} htmlFor={id} className="flex flex-col gap-1.5 text-[13px] font-semibold">
            {f.name}
            <input id={id} className={`field h-10 font-normal ${v ? "" : "border-amber-400 bg-amber-50"}`} defaultValue={String(v)} placeholder="Not filled yet"
              onBlur={(e) => set(f, e.target.value)} />
          </label>
        );
      })}

      <section aria-labelledby="sigs-h" className="flex flex-col gap-2.5 border-t border-zinc-200 pt-4">
        <h3 id="sigs-h" className="text-[13px] font-semibold">Signature</h3>
        {saved.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <button type="button" onClick={() => { setTool("signature"); setPendingImage({ dataUrl: s.dataUrl, w: s.w, h: s.h }); }}
              className="flex h-16 flex-1 items-center justify-center rounded-[10px] border border-zinc-200 hover:border-brand-600" aria-label="Place this signature">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.dataUrl} alt="" className="max-h-12 max-w-[200px]" />
            </button>
            <button type="button" aria-label="Forget this signature" className="btn-ghost min-h-10 px-2.5 text-zinc-500"
              onClick={() => { const next = saved.filter((x) => x.id !== s.id); storeSaved(next); setSaved(next); }}>×</button>
          </div>
        ))}
        <button type="button" onClick={onCreateSignature} className="btn h-11 border-[1.5px] border-dashed border-brand-600 bg-brand-50 text-brand-700">
          {saved.length ? "New signature" : "Add signature"}
        </button>
        <p className="text-[12px] text-zinc-500">Saved signatures stay on this device only.</p>
      </section>
    </aside>
  );
}
