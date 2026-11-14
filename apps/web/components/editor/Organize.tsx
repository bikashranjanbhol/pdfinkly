"use client";

import { useMemo, useRef, useState } from "react";
import { newId, type DocModel, type PageEntry } from "@pdfinkly/shared";
import { IconPlus, IconRotateL, IconRotateR, IconTrash } from "../icons";
import { makeGeom } from "./geometry";
import { PageCanvas, usePageInfo } from "./PageView";
import { useEditor } from "./store";

function Thumb({ entry, n, selected, onClick, onDragStart, onDrop, dropHint }: {
  entry: PageEntry; n: number; selected: boolean; dropHint: boolean;
  onClick: (e: React.MouseEvent) => void; onDragStart: () => void; onDrop: () => void;
}) {
  const info = usePageInfo(entry);
  const g = useMemo(() => (info ? makeGeom(info.view, (info.rotate + entry.rotation) % 360, 130 / Math.max(info.view[2] - info.view[0], info.view[3] - info.view[1])) : null), [info, entry.rotation]);
  return (
    <li className="relative flex flex-col items-center gap-2">
      {dropHint && <span aria-hidden="true" className="absolute -left-3.5 top-0 h-[150px] w-1 rounded bg-brand-600" />}
      <button
        type="button"
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onDrop(); }}
        onClick={onClick}
        aria-pressed={selected}
        aria-label={`Page ${n}`}
        className={`flex h-[150px] w-[150px] items-center justify-center rounded-[10px] ${selected ? "bg-brand-100 outline-2 outline-brand-600" : "hover:bg-zinc-200/60"}`}
      >
        {info && g ? <PageCanvas info={info} g={g} visible className="shadow" /> : <span className="h-[130px] w-[100px] animate-pulse bg-white" />}
      </button>
      <span className={`text-[13px] ${selected ? "font-bold text-brand-700" : "text-zinc-600"}`}>{n}{entry.rotation ? ` · ${entry.rotation}°` : ""}</span>
    </li>
  );
}

export function Organize({ model, onAddFromPdf, busy }: { model: DocModel; onAddFromPdf: (at: number) => void; busy: boolean }) {
  const [sel, setSel] = useState<string[]>([]);
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const lastClick = useRef<number | null>(null);
  const { apply } = useEditor.getState();
  const pages = model.pages;
  const live = sel.filter((r) => pages.some((p) => p.ref === r));
  const afterIndex = live.length ? Math.max(...live.map((r) => pages.findIndex((p) => p.ref === r))) + 1 : pages.length;

  function click(i: number, e: React.MouseEvent) {
    const ref = pages[i]!.ref;
    if (e.shiftKey && lastClick.current !== null) {
      const [a, b] = [Math.min(lastClick.current, i), Math.max(lastClick.current, i)];
      setSel(pages.slice(a, b + 1).map((p) => p.ref));
    } else if (e.metaKey || e.ctrlKey) {
      setSel((s) => (s.includes(ref) ? s.filter((x) => x !== ref) : [...s, ref]));
    } else {
      setSel((s) => (s.length === 1 && s[0] === ref ? [] : [ref]));
    }
    lastClick.current = i;
  }

  const rotate = (deg: 90 | 270) => apply(...live.map((page) => ({ op: "page.rotate" as const, page, degrees: deg })));
  function remove() {
    if (live.length >= pages.length) {
      alert("A PDF needs at least one page.");
      return;
    }
    apply(...live.map((page) => ({ op: "page.delete" as const, page })));
    setSel([]);
  }
  function insertBlank() {
    const ref = `b:${newId()}`;
    apply({ op: "page.insertBlank", at: afterIndex, page: ref, size: { w: 595.28, h: 841.89 } });
    setSel([ref]);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="toolbar" aria-label="Page tools" className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2">
        <span className="rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-700">
          {live.length ? `${live.length} page${live.length > 1 ? "s" : ""} selected` : "Click pages to select · Shift or Ctrl for more"}
        </span>
        <button type="button" disabled={!live.length} onClick={() => rotate(270)} className="btn-secondary min-h-10 text-sm"><IconRotateL size={18} />Rotate left</button>
        <button type="button" disabled={!live.length} onClick={() => rotate(90)} className="btn-secondary min-h-10 text-sm"><IconRotateR size={18} />Rotate right</button>
        <button type="button" disabled={!live.length} onClick={remove} className="btn-danger min-h-10 text-sm"><IconTrash size={18} />Delete</button>
        <span className="mx-1 h-7 w-px bg-zinc-200" />
        <button type="button" onClick={insertBlank} className="btn-secondary min-h-10 text-sm">Insert blank page</button>
        <button type="button" disabled={busy} onClick={() => onAddFromPdf(afterIndex)} className="btn-primary min-h-10 text-sm">
          <IconPlus size={18} />{busy ? "Adding…" : "Add pages from another PDF"}
        </button>
        <span className="ml-auto text-sm text-zinc-600">{pages.length} pages · drag to reorder</span>
      </div>
      <div className="flex-1 overflow-auto p-8">
        <ol aria-label="Pages" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-6 gap-y-7" onDragEnd={() => { setDragRef(null); setHover(null); }}>
          {pages.map((p, i) => (
            <div key={p.ref} onDragEnter={() => dragRef && setHover(i)}>
              <Thumb
                entry={p}
                n={i + 1}
                selected={live.includes(p.ref)}
                dropHint={hover === i && dragRef !== p.ref}
                onClick={(e) => click(i, e)}
                onDragStart={() => setDragRef(p.ref)}
                onDrop={() => {
                  if (dragRef && dragRef !== p.ref) {
                    const from = pages.findIndex((x) => x.ref === dragRef);
                    apply({ op: "page.move", page: dragRef, toIndex: from < i ? i - 1 : i });
                  }
                  setDragRef(null);
                  setHover(null);
                }}
              />
            </div>
          ))}
        </ol>
      </div>
    </div>
  );
}
