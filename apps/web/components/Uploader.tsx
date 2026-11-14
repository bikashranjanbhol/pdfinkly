"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ApiFailure, formatBytes } from "@/lib/client/api";
import { uploadNewPdf } from "@/lib/client/pdf";
import { IconCheck, IconLock, IconUpload } from "./icons";

type Item = {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "done" | "error";
  progress: number;
  message?: string;
  fileId?: string;
  pages?: number;
  abort?: AbortController;
};

export function Uploader() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function start(files: FileList | File[]) {
    const list = Array.from(files);
    const single = list.length === 1;
    for (const file of list) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setItems((xs) => [{ key, name: file.name, size: file.size, state: "error", progress: 0, message: "This isn't a PDF. Only PDF files can be edited here." }, ...xs]);
        continue;
      }
      const abort = new AbortController();
      setItems((xs) => [{ key, name: file.name, size: file.size, state: "uploading", progress: 0, abort }, ...xs]);
      try {
        const res = await uploadNewPdf(file, (p) => patch(key, { progress: p }), abort.signal);
        patch(key, { state: "done", progress: 1, fileId: res.fileId, pages: res.pageCount });
        if (single) router.push(`/edit/${res.fileId}`);
      } catch (e) {
        let message = e instanceof Error ? e.message : "Upload failed.";
        if (e instanceof ApiFailure && e.code === "FILE_TOO_LARGE") message = e.message;
        if (/password/i.test(message)) message = "This PDF is password protected. Unlock it first, then upload it again.";
        if (/Invalid PDF|InvalidPDF/i.test(message)) message = "This file isn't a valid PDF.";
        patch(key, { state: "error", message });
      }
    }
  }

  return (
    <main className="mx-auto flex max-w-[880px] flex-col gap-6 px-6 pb-12 pt-8">
      <h1 className="font-display text-[32px] font-bold tracking-tight">Upload PDFs</h1>

      <label
        htmlFor="file-input"
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void start(e.dataTransfer.files); }}
        className={`flex cursor-pointer flex-col items-center gap-3 rounded-[18px] border-2 border-dashed px-6 py-12 text-center transition-colors ${drag ? "border-brand-700 bg-brand-100" : "border-brand-600 bg-brand-50"}`}
      >
        <span className="flex size-[60px] items-center justify-center rounded-2xl bg-white text-brand-600 shadow-sm"><IconUpload size={30} /></span>
        <span className="text-xl font-bold text-brand-900">Drop PDFs here</span>
        <span className="text-brand-800">or <span className="font-semibold underline">browse your device</span></span>
        <input ref={input} id="file-input" type="file" accept="application/pdf,.pdf" multiple className="sr-only" onChange={(e) => e.target.files && void start(e.target.files)} />
      </label>
      <p className="-mt-2 flex items-center gap-2 text-[13px] text-zinc-600">
        <IconLock size={16} />Files go straight to private storage over HTTPS. Guest files are deleted automatically.
      </p>

      {items.length > 0 && (
        <section aria-labelledby="queue" className="card">
          <h2 id="queue" className="border-b border-zinc-200 px-5 py-3.5 text-base font-semibold">{items.length} file{items.length > 1 ? "s" : ""}</h2>
          <ul aria-live="polite">
            {items.map((it) => (
              <li key={it.key} className={`flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-zinc-100 px-5 py-4 last:border-0 ${it.state === "error" ? "bg-amber-50" : ""}`}>
                {it.state === "done" && <span className="flex size-7 items-center justify-center rounded-full bg-green-100 text-green-700"><IconCheck size={16} /></span>}
                {it.state === "error" && <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-amber-100 font-bold text-amber-700">!</span>}
                <div className="min-w-0 flex-[1_1_300px]">
                  <div className="flex justify-between gap-3">
                    <span className="truncate font-semibold">{it.name}</span>
                    <span className="flex-none text-[13px] text-zinc-600">
                      {it.state === "uploading" ? `${Math.round(it.progress * 100)}% of ${formatBytes(it.size)}` : it.state === "done" ? `${it.pages} pages · ${formatBytes(it.size)}` : formatBytes(it.size)}
                    </span>
                  </div>
                  {it.state === "uploading" && (
                    <div role="progressbar" aria-label={`Uploading ${it.name}`} aria-valuenow={Math.round(it.progress * 100)} aria-valuemin={0} aria-valuemax={100} className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                      <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${it.progress * 100}%` }} />
                    </div>
                  )}
                  {it.message && <div className="text-[13px] text-amber-900">{it.message}</div>}
                </div>
                {it.state === "uploading" && <button type="button" className="btn-secondary min-h-10 text-sm" onClick={() => it.abort?.abort()}>Cancel</button>}
                {it.state === "done" && it.fileId && <Link href={`/edit/${it.fileId}`} className="btn-primary min-h-10 text-sm">Open in editor</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
