"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_QUAD, type Quad, type ScanFilter } from "@pdfinkly/shared/scan";
import { analysePhoto, renderPage, type Rendered } from "@/lib/client/scan";
import { api, ApiFailure, putWithProgress, saveBytes } from "@/lib/client/api";
import { IconBack, IconCamera, IconCrop, IconDownload, IconImage, IconPlus, IconRotateR, IconShare, IconTrash } from "../icons";
import { CornerEditor } from "./CornerEditor";
import { FILTERS } from "./filters";
import { PhoneLink, type ReceivedPage } from "./PhoneLink";
import { PageViewer } from "./PageViewer";

const FULL: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

interface Page {
  id: string;
  file: File;
  status: "analysing" | "rendering" | "ready" | "error";
  error?: string;
  photo?: { width: number; height: number };
  preview?: string;
  quad: Quad;
  detected: Quad;
  found: boolean;
  turns: number;
  /** This page's own look; null follows the look chosen for all pages. */
  filter: ScanFilter | null;
  out?: Rendered;
  thumb?: string;
  /** Screen-sized preview in the look being shown. */
  view?: string;
  v: number;
  /** Arrived from a phone (already straightened). */
  fromPhone?: boolean;
}

const LIMITS = [
  { kb: 0, label: "No limit" },
  { kb: 100, label: "Under 100 KB" },
  { kb: 200, label: "Under 200 KB" },
  { kb: 500, label: "Under 500 KB" },
  { kb: 1024, label: "Under 1 MB" },
  { kb: 2048, label: "Under 2 MB" },
];

const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif|bmp|gif)$/i.test(f.name);
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const defaultName = () => {
  const d = new Date();
  return `Scan ${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} ${d.getFullYear()}`;
};

/**
 * Photos of documents → straightened, cleaned-up pages → a PDF. Everything
 * happens in the browser; nothing is uploaded unless "Save and edit" is used.
 *
 * With `handoff` (a phone that opened a computer's QR code), pages are sent to
 * that computer instead: straightened but in their original colours, so the
 * computer chooses the look.
 */
export function Scanner({ handoff }: { handoff?: string } = {}) {
  const phoneMode = !!handoff;
  const router = useRouter();
  const [pages, setPages] = useState<Page[]>([]);
  const pagesRef = useRef<Page[]>([]);
  const commit = (fn: (ps: Page[]) => Page[]) => {
    pagesRef.current = fn(pagesRef.current);
    setPages(pagesRef.current);
  };
  const patch = (id: string, p: Partial<Page>) => commit((ps) => ps.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const [filter, setFilterState] = useState<ScanFilter>("auto");
  const filterRef = useRef<ScanFilter>("auto");
  const [editing, setEditing] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: string; review: boolean } | null>(null);
  /** A photo just taken with the camera: show it once it's ready (after fixing corners, if needed). */
  const reviewId = useRef<string | null>(null);
  const [pageSize, setPageSize] = useState<"a4" | "letter" | "fit">("a4");
  const [limit, setLimit] = useState(0);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState<null | "download" | "save" | "send">(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const saved = useRef(false);
  const [phone, setPhone] = useState(false);
  const [canUsePhone, setCanUsePhone] = useState(false);
  const [linkDead, setLinkDead] = useState(false);

  useEffect(() => {
    // Offer "Use your phone" on computers (a mouse or trackpad), not on phones themselves.
    if (!phoneMode) setCanUsePhone(window.matchMedia("(pointer: fine)").matches);
    else
      api(`/api/scan/phone/${handoff}`, { method: "POST" }).catch((e) => {
        if (e instanceof ApiFailure && e.status === 404) setLinkDead(true);
      });
  }, [phoneMode, handoff]);

  // Don't lose scans by accident.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pagesRef.current.length && !saved.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(
    () => () => {
      for (const p of pagesRef.current) {
        if (p.preview) URL.revokeObjectURL(p.preview);
        if (p.thumb) URL.revokeObjectURL(p.thumb);
        if (p.view) URL.revokeObjectURL(p.view);
      }
    },
    [],
  );

  async function renderOne(id: string) {
    const p = pagesRef.current.find((x) => x.id === id);
    if (!p?.photo) return;
    const v = p.v + 1;
    patch(id, { v, status: "rendering" });
    try {
      const look = p.filter ?? filterRef.current;
      const out = phoneMode
        ? await renderPage(p.file, p.quad, "original", p.turns, p.photo, look) // the computer applies the look
        : await renderPage(p.file, p.quad, look, p.turns, p.photo);
      const cur = pagesRef.current.find((x) => x.id === id);
      if (!cur || cur.v !== v) return; // changed again meanwhile, or removed
      if (cur.thumb) URL.revokeObjectURL(cur.thumb);
      if (cur.view) URL.revokeObjectURL(cur.view);
      patch(id, { status: "ready", out, thumb: URL.createObjectURL(out.thumb), view: URL.createObjectURL(out.view), error: undefined });
    } catch (e) {
      patch(id, { status: "error", error: e instanceof Error ? e.message : "Couldn't process this photo." });
    }
  }

  async function addFiles(list: FileList | File[], fromCamera: boolean) {
    setError(null);
    setNotice(null);
    saved.current = false;
    const files = [...list];
    const photos = files.filter(isImage);
    if (photos.length < files.length) setError("Only photos and pictures can be scanned. To open a PDF, use Upload.");
    const added: Page[] = photos.map((file) => ({
      id: crypto.randomUUID(), file, status: "analysing", quad: DEFAULT_QUAD, detected: DEFAULT_QUAD,
      found: false, turns: 0, filter: null, v: 0,
    }));
    commit((ps) => [...ps, ...added]);
    for (const p of added) {
      try {
        const a = await analysePhoto(p.file);
        if (!pagesRef.current.some((x) => x.id === p.id)) continue;
        patch(p.id, { quad: a.quad, detected: a.quad, found: a.found, photo: { width: a.width, height: a.height }, preview: URL.createObjectURL(a.preview) });
        // A single photo from the camera: show how it came out (if the page wasn't found, fix the corners first).
        if (fromCamera && added.length === 1) {
          reviewId.current = p.id;
          if (a.found) setViewing({ id: p.id, review: true });
          else setEditing(p.id);
        }
        await renderOne(p.id);
      } catch (e) {
        patch(p.id, { status: "error", error: e instanceof Error ? e.message : "Couldn't read this photo." });
      }
    }
  }

  function addReceived(list: ReceivedPage[]) {
    saved.current = false;
    const added: Page[] = list.map((r) => ({
      id: crypto.randomUUID(),
      file: new File([r.blob], "phone page.jpg", { type: "image/jpeg" }),
      status: "rendering", photo: { width: r.width, height: r.height }, preview: URL.createObjectURL(r.blob),
      quad: FULL, detected: FULL, found: true, turns: 0, filter: null, v: 0, fromPhone: true,
    }));
    commit((ps) => [...ps, ...added]);
    for (const p of added) void renderOne(p.id);
  }

  async function send() {
    setBusy("send");
    setError(null);
    setNotice(null);
    const list = pagesRef.current.filter((p) => p.status === "ready" && p.out);
    let sent = 0;
    try {
      for (const p of list) {
        setProgress(`Sending page ${sent + 1} of ${list.length}…`);
        const { pageId, upload } = await api<{ pageId: string; upload: Parameters<typeof putWithProgress>[0] }>(`/api/scan/phone/${handoff}/pages`, {
          method: "POST",
          json: { width: p.out!.width, height: p.out!.height, sizeBytes: p.out!.jpeg.size },
        });
        await putWithProgress(upload, p.out!.jpeg);
        await api(`/api/scan/phone/${handoff}/pages/${pageId}/complete`, { method: "POST" });
        remove(p.id);
        sent++;
      }
      saved.current = true;
      setNotice(`Sent ${sent} ${sent === 1 ? "page" : "pages"}. They're on your computer now. Take more, or carry on there.`);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setLinkDead(true);
      else setError(`${sent ? `Sent ${sent} of ${list.length} pages. ` : ""}${e instanceof Error ? e.message : "Sending failed."} Tap Send to try again.`);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  function setFilter(f: ScanFilter) {
    setFilterState(f);
    filterRef.current = f;
    for (const p of pagesRef.current) if (p.filter === null && p.photo) void renderOne(p.id);
  }

  function remove(id: string) {
    const p = pagesRef.current.find((x) => x.id === id);
    if (p?.preview) URL.revokeObjectURL(p.preview);
    if (p?.thumb) URL.revokeObjectURL(p.thumb);
    if (p?.view) URL.revokeObjectURL(p.view);
    commit((ps) => ps.filter((x) => x.id !== id));
  }

  function moveBy(i: number, by: number) {
    commit((ps) => {
      const next = [...ps];
      const [p] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(next.length, i + by)), 0, p!);
      return next;
    });
  }

  const ready = pages.length > 0 && pages.every((p) => p.status === "ready");
  const working = pages.some((p) => p.status === "analysing" || p.status === "rendering");
  const fileName = `${(name.trim() || defaultName()).replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;

  async function makePdf(): Promise<Uint8Array> {
    setProgress("Making the PDF…");
    const { imagesToPdf } = await import("@pdfinkly/shared/export");
    const images = await Promise.all(
      pagesRef.current.map(async (p) => ({ bytes: new Uint8Array(await p.out!.jpeg.arrayBuffer()), type: "jpg" as const, width: p.out!.width, height: p.out!.height })),
    );
    let bytes = await imagesToPdf(images, { pageSize, margin: 0, fitLongSide: 841.89, title: fileName.replace(/\.pdf$/, "") });
    if (limit && bytes.length > limit * 1024) {
      const { compressPdf } = await import("@/lib/client/compress");
      const r = await compressPdf(bytes, { targetBytes: limit * 1024 }, (f, note) => setProgress(`Making it smaller… ${Math.round(f * 100)}%${note ? ` · ${note}` : ""}`));
      bytes = r.bytes;
      if (!r.reached) {
        setNotice(`It couldn't get under ${fmtSize(limit * 1024)} without becoming unreadable; this is the smallest (${fmtSize(bytes.length)}). Black & white, or fewer pages, gives smaller files.`);
      }
    }
    return bytes;
  }

  async function finish(kind: "download" | "save") {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const bytes = await makePdf();
      if (kind === "download") {
        saveBytes(bytes, fileName);
        saved.current = true;
        setNotice((n) => n ?? `Downloaded ${fileName} (${pagesRef.current.length} ${pagesRef.current.length === 1 ? "page" : "pages"}, ${fmtSize(bytes.length)}).`);
      } else {
        setProgress("Saving…");
        const { uploadNewPdf } = await import("@/lib/client/pdf");
        const res = await uploadNewPdf(new File([bytes as BlobPart], fileName, { type: "application/pdf" }));
        saved.current = true;
        router.push(`/edit/${res.fileId}`);
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make the PDF.");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const editPage = pages.find((p) => p.id === editing);
  const pickers = (compact: boolean) => (
    <div className={`flex flex-wrap gap-3 ${compact ? "" : "justify-center"}`}>
      <label htmlFor="scan-camera" className={`btn-primary cursor-pointer ${compact ? "" : "min-h-14 px-6 text-base"}`}>
        <IconCamera /> {pages.length ? "Take another photo" : "Take a photo"}
      </label>
      <label htmlFor="scan-photos" className={`btn-secondary cursor-pointer ${compact ? "" : "min-h-14 px-6 text-base"}`}>
        <IconImage /> {pages.length ? "Add photos" : "Choose photos"}
      </label>
      {canUsePhone && !phone && (
        <button type="button" className={`btn-secondary ${compact ? "" : "min-h-14 px-6 text-base"}`} onClick={() => setPhone(true)}>
          <IconShare /> Use your phone
        </button>
      )}
    </div>
  );

  return (
    <main
      className={`mx-auto flex max-w-[960px] flex-col gap-6 px-4 pb-16 pt-6 sm:px-6 ${drag ? "outline-dashed outline-2 outline-brand-600" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles(e.dataTransfer.files, false); }}
    >
      <input
        id="scan-camera" type="file" accept="image/*" capture="environment" className="sr-only"
        onChange={(e) => { if (e.target.files?.length) void addFiles(e.target.files, true); e.target.value = ""; }}
      />
      <input
        id="scan-photos" type="file" accept="image/*" multiple className="sr-only"
        onChange={(e) => { if (e.target.files?.length) void addFiles(e.target.files, false); e.target.value = ""; }}
      />

      <div>
        <h1 className="font-display text-[32px] font-bold tracking-tight">{phoneMode ? "Scan for your computer" : "Scan documents"}</h1>
        <p className="mt-1 text-zinc-600">
          {phoneMode
            ? "Take a photo of each page, then send them. They'll appear on your computer, where you finish the PDF."
            : "Photograph a document, or use photos you have. We find the page, straighten it and make it look scanned."}
        </p>
      </div>

      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
      {linkDead && (
        <p role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This link has expired or was closed on your computer. Make a new QR code there (Scan → Use your phone) and scan it again.
        </p>
      )}
      {phoneMode && notice && pages.length === 0 && <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900">{notice}</p>}

      {phone && <PhoneLink onPages={addReceived} onClose={() => setPhone(false)} />}

      {pages.length === 0 ? (
        <section aria-label="Start scanning" className="flex flex-col items-center gap-6 rounded-2xl border-2 border-dashed border-zinc-300 bg-white px-6 py-12 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-600"><IconCamera size={32} /></span>
          {pickers(false)}
          <ul className="flex max-w-[520px] flex-col gap-1.5 text-left text-sm text-zinc-600">
            <li>• Lay the page flat on a darker surface, in good light, with all four corners in the photo.</li>
            <li>• Several pages? Take one photo per page, or choose them all at once.</li>
            <li>
              {phoneMode
                ? "• Your photos are processed on this phone. Only the finished pages are sent to your computer."
                : "• Your photos are processed on this device. Nothing is uploaded unless you save."}
            </li>
          </ul>
        </section>
      ) : (
        <>
          {!phoneMode && <section aria-labelledby="look-h" className="flex flex-col gap-2">
            <h2 id="look-h" className="text-sm font-semibold text-zinc-600">Look</h2>
            <div role="radiogroup" aria-labelledby="look-h" className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.id}
                  title={f.hint}
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full border px-4 py-2 text-sm font-semibold ${filter === f.id ? "border-brand-600 bg-brand-50 text-brand-700" : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400"}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="text-[13px] text-zinc-600">{FILTERS.find((f) => f.id === filter)!.hint}.</p>
          </section>}

          <section aria-label="Pages">
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
              {pages.map((p, i) => (
                <li key={p.id} aria-label={`Page ${i + 1}`} className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-2">
                  <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-lg bg-zinc-100">
                    {p.thumb && (
                      <button type="button" aria-label={`Preview page ${i + 1}`} className="flex size-full items-center justify-center" onClick={() => setViewing({ id: p.id, review: false })}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.thumb} alt={`Scanned page ${i + 1}`} className={`max-h-full max-w-full shadow ${p.status === "rendering" ? "opacity-50" : ""}`} />
                      </button>
                    )}
                    {(p.status === "analysing" || p.status === "rendering") && (
                      <span role="status" className="absolute inset-x-2 bottom-2 rounded-md bg-white/90 px-2 py-1 text-center text-xs font-medium text-zinc-700">
                        {p.status === "analysing" ? "Finding the page…" : "Cleaning up…"}
                      </span>
                    )}
                    {p.status === "error" && <span role="alert" className="p-3 text-center text-sm text-red-700">{p.error}</span>}
                    {p.status === "ready" && !p.found && (
                      <span className="absolute inset-x-2 top-2 rounded-md bg-amber-100 px-2 py-1 text-center text-xs font-medium text-amber-900">
                        Edges not found: adjust
                      </span>
                    )}
                    <span className="absolute left-2 top-2 rounded-full bg-ink/80 px-2 py-0.5 text-xs font-bold text-white" aria-hidden="true">{i + 1}</span>
                    {p.fromPhone && <span className="absolute bottom-2 right-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-zinc-700">From phone</span>}
                  </div>
                  <div className="grid grid-cols-5">
                    <button type="button" aria-label={`Adjust page ${i + 1}`} title="Adjust corners and look" className="btn-ghost min-h-10 min-w-0 px-0" disabled={!p.preview} onClick={() => setEditing(p.id)}><IconCrop size={18} /></button>
                    <button type="button" aria-label={`Rotate page ${i + 1}`} title="Rotate" className="btn-ghost min-h-10 min-w-0 px-0" disabled={!p.photo} onClick={() => { patch(p.id, { turns: (p.turns + 1) % 4 }); void renderOne(p.id); }}><IconRotateR size={18} /></button>
                    <button type="button" aria-label={`Move page ${i + 1} earlier`} title="Move earlier" className="btn-ghost min-h-10 min-w-0 px-0" disabled={i === 0} onClick={() => moveBy(i, -1)}><IconBack size={18} /></button>
                    <button type="button" aria-label={`Move page ${i + 1} later`} title="Move later" className="btn-ghost min-h-10 min-w-0 px-0" disabled={i === pages.length - 1} onClick={() => moveBy(i, 1)}><IconBack size={18} className="rotate-180" /></button>
                    <button type="button" aria-label={`Remove page ${i + 1}`} title="Remove" className="btn-ghost min-h-10 min-w-0 px-0 text-red-700" onClick={() => remove(p.id)}><IconTrash size={18} /></button>
                  </div>
                </li>
              ))}
              <li className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 p-3 text-center">
                <IconPlus size={24} className="text-zinc-500" />
                <label htmlFor="scan-camera" className="btn-secondary w-full cursor-pointer text-sm">Take another photo</label>
                <label htmlFor="scan-photos" className="btn-ghost w-full cursor-pointer text-sm">Add photos</label>
                {canUsePhone && !phone && (
                  <button type="button" className="btn-ghost w-full text-sm" onClick={() => setPhone(true)}>Use your phone</button>
                )}
              </li>
            </ol>
          </section>

          {phoneMode ? (
            <section aria-labelledby="send-h" className="card flex flex-col gap-3 p-5">
              <h2 id="send-h" className="text-lg font-semibold">Send to your computer</h2>
              {progress && <p role="status" className="text-sm text-zinc-600">{progress}</p>}
              <button type="button" className="btn-primary min-h-12 text-base" disabled={!ready || !!busy || linkDead} onClick={() => void send()}>
                {busy === "send" ? "Sending…" : `Send to computer (${pages.length} ${pages.length === 1 ? "page" : "pages"})`}
              </button>
              <p className="text-[13px] text-zinc-600">{working ? "Finishing the pages…" : "Your computer chooses the look and makes the PDF."}</p>
            </section>
          ) : (
            <section aria-labelledby="finish-h" className="card flex flex-col gap-4 p-5">
              <h2 id="finish-h" className="text-lg font-semibold">Make the PDF</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  File name
                  <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Page size
                  <select className="field" value={pageSize} onChange={(e) => setPageSize(e.target.value as typeof pageSize)}>
                    <option value="a4">A4</option>
                    <option value="letter">Letter</option>
                    <option value="fit">Same shape as the scan</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  File size
                  <select className="field" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
                    {LIMITS.map((l) => <option key={l.kb} value={l.kb}>{l.label}</option>)}
                  </select>
                </label>
              </div>
              {progress && <p role="status" className="text-sm text-zinc-600">{progress}</p>}
              {notice && <p role="status" className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-900">{notice}</p>}
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" className="btn-primary" disabled={!ready || !!busy} onClick={() => void finish("download")}>
                  <IconDownload /> {busy === "download" ? "Working…" : "Download PDF"}
                </button>
                <button type="button" className="btn-secondary" disabled={!ready || !!busy} onClick={() => void finish("save")}>
                  {busy === "save" ? "Saving…" : "Save and edit"}
                </button>
                <span className="text-[13px] text-zinc-600">
                  {working
                    ? "Finishing the pages…"
                    : `${pages.length} ${pages.length === 1 ? "page" : "pages"}. "Save and edit" keeps it in My files, where you can sign it, OCR it or redact it.`}
                </span>
              </div>
            </section>
          )}
        </>
      )}

      {viewing && pages.some((p) => p.id === viewing.id) && (
        <PageViewer
          pages={pages.map((p) => ({ id: p.id, view: p.view, status: p.status, error: p.error, filter: p.filter, canAdjust: !!p.preview }))}
          index={pages.findIndex((p) => p.id === viewing.id)}
          review={viewing.review}
          showLook={!phoneMode}
          inactive={!!editing}
          onIndex={(i) => setViewing({ id: pages[i]!.id, review: false })}
          onClose={() => { setViewing(null); reviewId.current = null; }}
          onAdjust={(id) => setEditing(id)}
          onRotate={(id) => {
            const p = pagesRef.current.find((x) => x.id === id);
            if (!p) return;
            patch(id, { turns: (p.turns + 1) % 4 });
            void renderOne(id);
          }}
          onRemove={(id) => {
            const i = pagesRef.current.findIndex((x) => x.id === id);
            remove(id);
            const next = pagesRef.current[Math.min(i, pagesRef.current.length - 1)];
            setViewing(next ? { id: next.id, review: false } : null);
          }}
          onFilter={(id, f) => { patch(id, { filter: f }); void renderOne(id); }}
          onRetake={(id) => {
            remove(id);
            setViewing(null);
            document.getElementById("scan-camera")?.click();
          }}
          onNext={() => {
            setViewing(null);
            document.getElementById("scan-camera")?.click();
          }}
        />
      )}

      {editPage?.preview && (
        <CornerEditor
          pageNo={pages.indexOf(editPage) + 1}
          preview={editPage.preview}
          quad={editPage.quad}
          detected={editPage.detected}
          found={editPage.found}
          filter={editPage.filter}
          showLook={!phoneMode}
          allFilter={filter}
          renderPreview={async (quad, look) => {
            const r = phoneMode
              ? await renderPage(editPage.file, quad, "original", editPage.turns, editPage.photo!, look, 1000)
              : await renderPage(editPage.file, quad, look, editPage.turns, editPage.photo!, undefined, 1000);
            return r.view;
          }}
          onClose={() => setEditing(null)}
          onApply={(quad, f) => {
            patch(editPage.id, { quad, filter: f, found: true });
            setEditing(null);
            if (reviewId.current === editPage.id && !viewing) setViewing({ id: editPage.id, review: true });
            void renderOne(editPage.id);
          }}
        />
      )}
    </main>
  );
}
