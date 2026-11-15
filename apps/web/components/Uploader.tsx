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
  state: "uploading" | "done" | "error" | "locked" | "unlocking";
  /** For a protected PDF waiting for its password. */
  file?: File;
  needsPassword?: boolean;
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
      // Protected PDFs are unlocked here (in the browser) before upload; editing needs the decrypted file.
      if (await maybeEncrypted(file)) {
        const { lockState } = await import("@/lib/client/qpdf");
        const state = await lockState(new Uint8Array(await file.arrayBuffer())).catch(() => null);
        if (state?.encrypted) {
          setItems((xs) => [{ key, name: file.name, size: file.size, state: "locked", progress: 0, file, needsPassword: state.needsPassword }, ...xs]);
          continue;
        }
      }
      await upload(key, file, single, true);
    }
  }

  async function unlock(it: Item, password: string) {
    if (!it.file) return;
    patch(it.key, { state: "unlocking", message: undefined });
    try {
      const { unlockPdf } = await import("@/lib/client/qpdf");
      const bytes = await unlockPdf(new Uint8Array(await it.file.arrayBuffer()), password);
      const file = new File([bytes as BlobPart], it.file.name, { type: "application/pdf" });
      await upload(it.key, file, true, false);
    } catch (e) {
      patch(it.key, { state: "locked", message: e instanceof Error ? e.message : "Couldn't unlock this PDF." });
    }
  }

  async function upload(key: string, file: File, open: boolean, isNew: boolean) {
      const abort = new AbortController();
      if (isNew) setItems((xs) => [{ key, name: file.name, size: file.size, state: "uploading", progress: 0, abort }, ...xs]);
      else patch(key, { state: "uploading", progress: 0, abort, size: file.size, file: undefined });
      const single = open;
      try {
        const res = await uploadNewPdf(file, (p) => patch(key, { progress: p }), abort.signal);
        patch(key, { state: "done", progress: 1, fileId: res.fileId, pages: res.pageCount });
        if (single) router.push(`/edit/${res.fileId}`);
      } catch (e) {
        let message = e instanceof Error ? e.message : "Upload failed.";
        if (e instanceof ApiFailure && e.code === "FILE_TOO_LARGE") message = e.message;
        if (/password/i.test(message)) message = "This PDF is password protected and couldn't be unlocked. Try uploading it again.";
        if (/Invalid PDF|InvalidPDF/i.test(message)) message = "This file isn't a valid PDF.";
        patch(key, { state: "error", message });
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
              <li key={it.key} className={`flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-zinc-100 px-5 py-4 last:border-0 ${it.state === "error" ? "bg-amber-50" : it.state === "locked" || it.state === "unlocking" ? "bg-zinc-50" : ""}`}>
                {it.state === "done" && <span className="flex size-7 items-center justify-center rounded-full bg-green-100 text-green-700"><IconCheck size={16} /></span>}
                {(it.state === "locked" || it.state === "unlocking") && <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-zinc-100 text-zinc-700"><IconLock size={16} /></span>}
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
                  {(it.state === "locked" || it.state === "unlocking") && (
                    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void unlock(it, String(new FormData(e.currentTarget).get("password") ?? "")); }}>
                      <span className="w-full text-[13px] text-zinc-700">
                        {it.needsPassword ? "This PDF is password protected. Enter its password to unlock it for editing." : "This PDF's permissions are locked. Enter its permissions (owner) password to unlock it for editing."}
                      </span>
                      <input name="password" type="password" autoComplete="off" required={it.needsPassword} aria-label={`Password for ${it.name}`} className="field h-10 w-56" autoFocus />
                      <button type="submit" className="btn-primary min-h-10 text-sm" disabled={it.state === "unlocking"}>{it.state === "unlocking" ? "Unlocking…" : "Unlock and upload"}</button>
                    </form>
                  )}
                  {it.message && <div role={it.state === "locked" ? "alert" : undefined} className="text-[13px] text-amber-900">{it.message}</div>}
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

/** Quick check for an /Encrypt entry (in the trailer or the xref stream), before loading qpdf. */
async function maybeEncrypted(file: File): Promise<boolean> {
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 64 * 1024)).arrayBuffer());
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer());
  const has = (b: Uint8Array) => new TextDecoder("latin1").decode(b).includes("/Encrypt");
  return has(tail) || has(head);
}
