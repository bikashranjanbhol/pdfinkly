"use client";

import { useState } from "react";
import { newId, PII_LABEL, type PiiKind, type PlacedAnnotation, type Rect } from "@pdfinkly/shared";
import { looksScanned } from "@/lib/client/ocr";
import { findOnPage } from "@/lib/client/redaction";
import type { OcrPageRef } from "./OcrDialog";
import { useEditor } from "./store";

const KINDS: PiiKind[] = ["aadhaar", "pan", "phone", "email", "bank", "ifsc"];

interface Found { page: string; pageLabel: string; kind: PiiKind; text: string; rect: Rect }

const centreIn = (a: Rect, b: Rect) => a.x + a.w / 2 > b.x && a.x + a.w / 2 < b.x + b.w && a.y + a.h / 2 > b.y && a.y + a.h / 2 < b.y + b.h;

/** Find personal data (or any words) across the document and mark it for redaction. */
export function RedactPanel({ pages, annotations }: { pages: OcrPageRef[]; annotations: PlacedAnnotation[] }) {
  const [kinds, setKinds] = useState<PiiKind[]>(KINDS);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<Found[] | null>(null);
  const [scans, setScans] = useState(0);
  const marks = annotations.filter((a) => a.annot.kind === "redact");

  async function find() {
    setBusy(true);
    try {
      const all: Found[] = [];
      let noText = 0;
      const want: PiiKind[] = [...kinds, ...(query.trim() ? (["custom"] as const) : [])];
      for (const p of pages) {
        const page = await p.load();
        if (!page) continue;
        if (await looksScanned(page)) { noText++; continue; }
        for (const m of await findOnPage(page, want, query)) all.push({ page: p.ref, pageLabel: p.label, kind: m.kind, text: m.text, rect: m.rect });
      }
      setScans(noText);
      setFound(all);
    } finally {
      setBusy(false);
    }
  }

  const fresh = (found ?? []).filter((f) => !marks.some((m) => m.page === f.page && m.annot.kind === "redact" && centreIn(f.rect, m.annot.rect)));
  const counts = fresh.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});

  function markAll() {
    if (!fresh.length) return;
    useEditor.getState().apply(...fresh.map((f) => ({
      op: "annot.add" as const, id: newId(), page: f.page,
      annot: { kind: "redact" as const, rect: f.rect, label: f.kind === "custom" ? undefined : PII_LABEL[f.kind], text: f.text.slice(0, 200) },
    })));
  }

  return (
    <section aria-labelledby="redact-h" className="flex flex-col gap-4">
      <h2 id="redact-h" className="text-[15px] font-semibold">Find and redact</h2>
      <fieldset className="grid grid-cols-2 gap-x-3 gap-y-2">
        <legend className="mb-2 text-[13px] font-semibold text-zinc-700">Personal data</legend>
        {KINDS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds((cur) => (e.target.checked ? [...cur, k] : cur.filter((x) => x !== k)))} />
            {PII_LABEL[k]}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
        Words or numbers
        <input className="field h-10 font-normal" value={query} placeholder="e.g. a name or a case number" onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void find()} />
      </label>
      <button type="button" className="btn-secondary min-h-10 text-sm" disabled={busy || (!kinds.length && !query.trim())} onClick={() => void find()}>
        {busy ? "Searching…" : "Find"}
      </button>

      {found && (
        <div role="status" className="flex flex-col gap-2 rounded-[10px] bg-zinc-50 px-3 py-2.5 text-[13px]">
          {fresh.length ? (
            <>
              <p className="font-semibold">Found {fresh.length}: {Object.entries(counts).map(([k, n]) => `${PII_LABEL[k as PiiKind]} ${n}`).join(", ")}</p>
              <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-zinc-700">
                {fresh.slice(0, 50).map((f, i) => <li key={i} className="truncate">{f.pageLabel} · {f.text}</li>)}
              </ul>
              <button type="button" className="btn-primary min-h-10 text-sm" onClick={markAll}>Mark {fresh.length === 1 ? "it" : `all ${fresh.length}`} for redaction</button>
            </>
          ) : (
            <p>{found.length ? "Everything found is already marked." : "Nothing found."}</p>
          )}
          {scans > 0 && (
            <p className="text-amber-900">
              {scans === 1 ? "1 page has" : `${scans} pages have`} no text (scanned), so {scans === 1 ? "it wasn't" : "they weren't"} searched.{" "}
              <button type="button" className="font-semibold underline" onClick={() => useEditor.getState().requestOcr()}>Recognise text</button> first, then search again.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-zinc-200 pt-4 text-[13px] text-zinc-600">
        <p><span className="font-semibold text-ink">{marks.length} area{marks.length === 1 ? "" : "s"} marked.</span> When you save a version or download, everything under a mark (text, images, drawings, form fields, links) is deleted from the file and covered in black. You can still check and remove marks until then.</p>
        {marks.length > 0 && (
          <button type="button" className="btn-ghost min-h-9 self-start px-2 text-sm text-red-700"
            onClick={() => useEditor.getState().apply(...marks.map((m) => ({ op: "annot.delete" as const, id: m.id })))}>
            Remove all marks
          </button>
        )}
      </div>
    </section>
  );
}
