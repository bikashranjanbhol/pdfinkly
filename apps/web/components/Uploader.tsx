"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiFailure, formatBytes } from "@/lib/client/api";
import { uploadNewPdf } from "@/lib/client/pdf";
import { IconCheck, IconLock, IconUpload, IconCamera } from "./icons";

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

type Picture = { key: string; file: File; url: string };

export function Uploader() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [pageSize, setPageSize] = useState<"a4" | "letter" | "fit">("a4");
  const [margin, setMargin] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  useEffect(() => () => pictures.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const isPicture = (f: File) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);

  async function start(files: FileList | File[]) {
    const all = Array.from(files);
    // Pictures go to the "make a PDF" panel; PDFs upload straight away.
    const pics = all.filter(isPicture);
    if (pics.length) {
      setBuildError(null);
      setPictures((cur) => [...cur, ...pics.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, url: URL.createObjectURL(file) }))]);
    }
    const list = all.filter((f) => !isPicture(f));
    const single = list.length === 1 && !pics.length;
    for (const file of list) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
        setItems((xs) => [{ key, name: file.name, size: file.size, state: "error", progress: 0, message: "This isn't a PDF or a picture." }, ...xs]);
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

  function move(i: number, by: number) {
    setPictures((cur) => {
      const next = [...cur];
      const [p] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(next.length, i + by)), 0, p!);
      return next;
    });
  }

  async function buildPdf() {
    setBuilding(true);
    setBuildError(null);
    try {
      const { prepareImage } = await import("@/lib/client/images");
      const { imagesToPdf } = await import("@pdfinkly/shared/export");
      const prepared = [];
      for (const p of pictures) prepared.push(await prepareImage(p.file));
      const first = pictures[0]!.file.name.replace(/\.[^.]+$/, "");
      const name = pictures.length === 1 ? `${first}.pdf` : `${first} and ${pictures.length - 1} more.pdf`;
      const bytes = await imagesToPdf(prepared, { pageSize, margin: margin ? 28 : 0, title: name.replace(/\.pdf$/, "") });
      const file = new File([bytes as BlobPart], name, { type: "application/pdf" });
      pictures.forEach((p) => URL.revokeObjectURL(p.url));
      setPictures([]);
      await upload(`${name}-${Math.random()}`, file, true, true);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : "Couldn't make the PDF.");
    } finally {
      setBuilding(false);
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
        <span className="text-xl font-bold text-brand-900">Drop PDFs or pictures here</span>
        <span className="text-brand-800">or <span className="font-semibold underline">browse your device</span></span>
        <input ref={input} id="file-input" type="file" accept="application/pdf,.pdf,image/*" multiple className="sr-only" onChange={(e) => e.target.files && void start(e.target.files)} />
      </label>
      <p className="-mt-2 flex items-center gap-2 text-[13px] text-zinc-600">
        <IconLock size={16} />Files go straight to private storage over HTTPS. Guest files are deleted automatically.
      </p>
      <Link href="/scan" className="card -mt-2 flex items-center gap-3 px-4 py-3 text-[15px] text-ink hover:border-brand-600">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600"><IconCamera /></span>
        <span><span className="font-semibold">Scan a paper document</span> <span className="text-zinc-600">with your phone camera: we crop, straighten and clean it up.</span></span>
      </Link>

      {pictures.length > 0 && (
        <section aria-labelledby="pics" className="card flex flex-col gap-4 p-5">
          <div>
            <h2 id="pics" className="text-base font-semibold">Make a PDF from {pictures.length === 1 ? "1 picture" : `${pictures.length} pictures`}</h2>
            <p className="text-[13px] text-zinc-600">
              One page per picture, in this order. Done in your browser before upload. Photos of documents?{" "}
              <Link href="/scan" className="font-semibold text-brand-700">Scan them</Link> to crop, straighten and clean them up.
            </p>
          </div>
          <ol className="flex flex-wrap gap-3">
            {pictures.map((p, i) => (
              <li key={p.key} className="flex w-28 flex-col items-center gap-1.5 rounded-xl border border-zinc-200 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={p.file.name} className="h-24 w-full rounded object-contain" />
                <span className="w-full truncate text-center text-[11px] text-zinc-600">{i + 1}. {p.file.name}</span>
                <div className="flex gap-1">
                  <button type="button" className="btn-ghost min-h-7 px-1.5 text-xs" aria-label={`Move ${p.file.name} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>←</button>
                  <button type="button" className="btn-ghost min-h-7 px-1.5 text-xs" aria-label={`Move ${p.file.name} later`} disabled={i === pictures.length - 1} onClick={() => move(i, 1)}>→</button>
                  <button type="button" className="btn-ghost min-h-7 px-1.5 text-xs text-red-700" aria-label={`Remove ${p.file.name}`}
                    onClick={() => { URL.revokeObjectURL(p.url); setPictures((cur) => cur.filter((x) => x.key !== p.key)); }}>✕</button>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
              Page size
              <select className="field h-10 font-normal" value={pageSize} onChange={(e) => setPageSize(e.target.value as typeof pageSize)}>
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
                <option value="fit">Same as the picture</option>
              </select>
            </label>
            {pageSize !== "fit" && (
              <label className="flex h-10 items-center gap-2 text-sm"><input type="checkbox" checked={margin} onChange={(e) => setMargin(e.target.checked)} /> White margin</label>
            )}
            <button type="button" className="btn-primary ml-auto min-h-10" disabled={building} onClick={() => void buildPdf()}>
              {building ? "Making the PDF…" : `Make PDF${pictures.length > 1 ? ` (${pictures.length} pages)` : ""}`}
            </button>
          </div>
          {buildError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{buildError}</p>}
        </section>
      )}

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
