"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { deriveModel, newId, OperationsSchema, type FileSummary, type Operation } from "@pdfinkly/shared";
import { api, ApiFailure, saveBytes } from "@/lib/client/api";
import { fetchBytes, openPdf, uploadNewPdf, uploadNewVersion } from "@/lib/client/pdf";
import { IconBack, IconCheck, IconDownload, IconHistory, IconShare } from "../icons";
import { Mark } from "../Logo";
import { runExport } from "./exportClient";
import { makeGeom } from "./geometry";
import { HistoryDrawer } from "./HistoryDrawer";
import { Organize } from "./Organize";
import { DocsContext, PageCanvas, PageView, usePageInfo } from "./PageView";
import { Properties } from "./Properties";
import { ShareDialog } from "./ShareDialog";
import { SignatureDialog } from "./SignatureDialog";
import { readFormFields, SignPanel, type FormField } from "./SignPanel";
import { effectiveOps, useEditor, type Mode } from "./store";
import { Toolbar } from "./Toolbar";

interface Loaded {
  file: FileSummary;
  currentVersionId: string;
  baseVersionId: string;
  baseBytes: Uint8Array;
  base: PDFDocumentProxy;
  ext: Record<string, PDFDocumentProxy>;
  extBytes: Record<string, Uint8Array>;
  downloadUrl: string;
  fields: FormField[];
}

interface FileInfo {
  file: FileSummary;
  currentVersion: { id: string } | null;
  viewUrl: string | null;
  downloadUrl: string | null;
}

function friendlyLoadError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "PasswordException") return "This PDF is password protected. Unlock it first, then upload it again.";
  if (name === "InvalidPDFException") return "This file looks damaged and can't be opened.";
  if (e instanceof ApiFailure && e.code === "NOT_FOUND") return "This file doesn't exist or isn't yours.";
  if (e instanceof ApiFailure && e.code === "UNAUTHENTICATED") return "Sign in to open this file.";
  return e instanceof Error ? e.message : "Couldn't open this file.";
}

export function Editor({ fileId, isGuest }: { fileId: string; isGuest: boolean }) {
  const [doc, setDoc] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "export" | "save" | "merge">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "share" | "history" | "signature">(null);
  const [renaming, setRenaming] = useState(false);
  const savingVersion = useRef(false);
  const mergeInput = useRef<HTMLInputElement>(null);
  const mergeAt = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const ops = useEditor((s) => s.ops);
  const cursor = useEditor((s) => s.cursor);
  const mode = useEditor((s) => s.mode);
  const zoom = useEditor((s) => s.zoom);
  const saveState = useEditor((s) => s.saveState);
  const revision = useEditor((s) => s.revision);
  const conflict = useEditor((s) => s.conflictServer);

  const eff = useMemo(() => effectiveOps({ ops, cursor }), [ops, cursor]);
  const model = useMemo(() => (doc ? deriveModel(doc.base.numPages, eff) : null), [doc, eff]);

  /* ------------------------------------------------------------ loading */
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const info = await api<FileInfo>(`/api/files/${fileId}`);
      if (!info.currentVersion || !info.viewUrl || !info.downloadUrl) throw new Error("This file hasn't finished uploading.");
      const draft = await api<{ baseVersionId: string; operations: unknown; revision: number } | undefined>(`/api/files/${fileId}/draft`);
      let baseVersionId = info.currentVersion.id;
      let viewUrl = info.viewUrl;
      if (draft && draft.baseVersionId !== baseVersionId) {
        const v = await api<{ viewUrl: string }>(`/api/files/${fileId}/versions/${draft.baseVersionId}`);
        baseVersionId = draft.baseVersionId;
        viewUrl = v.viewUrl;
      }
      const parsed = OperationsSchema.safeParse(draft?.operations ?? []);
      const draftOps: Operation[] = parsed.success ? parsed.data : [];
      const baseBytes = await fetchBytes(viewUrl);
      const base = await openPdf(baseBytes);
      const ext: Record<string, PDFDocumentProxy> = {};
      const extBytes: Record<string, Uint8Array> = {};
      for (const op of draftOps) {
        if (op.op !== "page.insertFrom" || ext[op.versionId]) continue;
        try {
          const v = await api<{ viewUrl: string }>(`/api/files/${op.fileId}/versions/${op.versionId}`);
          extBytes[op.versionId] = await fetchBytes(v.viewUrl);
          ext[op.versionId] = await openPdf(extBytes[op.versionId]!);
        } catch {
          setNotice("A PDF you merged in is no longer available, so its pages were left out.");
        }
      }
      const usable = draftOps.filter((op) => op.op !== "page.insertFrom" || ext[op.versionId]);
      const fields = await readFormFields(baseBytes);
      useEditor.getState().reset(usable, draft?.revision ?? 0);

      // Fit the first page to the available width.
      const first = await base.getPage(1);
      const w = first.view[2]! - first.view[0]!;
      const avail = Math.max(320, window.innerWidth - (window.innerWidth >= 1024 ? 168 + 290 + 64 : 32));
      useEditor.getState().setZoom(Math.min(1.5, avail / w));

      setDoc((prev) => {
        void prev?.base.loadingTask.destroy();
        Object.values(prev?.ext ?? {}).forEach((d) => void d.loadingTask.destroy());
        return { file: info.file, currentVersionId: info.currentVersion!.id, baseVersionId, baseBytes, base, ext, extBytes, downloadUrl: info.downloadUrl!, fields };
      });
    } catch (e) {
      setLoadError(friendlyLoadError(e));
    }
  }, [fileId]);

  useEffect(() => {
    useEditor.getState().setMode("edit");
    void load();
  }, [load]);

  /* ----------------------------------------------------------- autosave */
  const saveDraft = useCallback(async () => {
    if (!doc || savingVersion.current) return;
    const s = useEditor.getState();
    const current = effectiveOps(s);
    s.setSave("saving");
    try {
      if (current.length === 0 && s.revision === 0) {
        s.setSave("saved");
        return;
      }
      if (current.length === 0) {
        await api(`/api/files/${fileId}/draft`, { method: "DELETE" });
        useEditor.getState().setSave(useEditor.getState().saveState === "saving" ? "saved" : "dirty", { revision: 0 });
        return;
      }
      const r = await api<{ revision: number }>(`/api/files/${fileId}/draft`, {
        method: "PUT",
        json: { baseVersionId: doc.baseVersionId, operations: current, revision: s.revision },
      });
      const now = useEditor.getState();
      now.setSave(now.saveState === "saving" ? "saved" : "dirty", { revision: r.revision });
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "DRAFT_CONFLICT") {
        const server = (e.details as { server?: { operations: Operation[]; revision: number } | null })?.server ?? null;
        useEditor.getState().setSave("conflict", { conflictServer: server ?? { operations: [], revision: 0 } });
      } else {
        useEditor.getState().setSave("error");
      }
    }
  }, [doc, fileId]);

  useEffect(() => {
    if (!doc || saveState !== "dirty") return;
    const t = setTimeout(() => void saveDraft(), 1000);
    return () => clearTimeout(t);
  }, [doc, ops, cursor, saveState, revision, saveDraft]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState().saveState;
      if (s === "dirty" || s === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  /* ----------------------------------------------------------- keyboard */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]") || dialog) return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo(); else s.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        s.redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selected) {
        e.preventDefault();
        s.apply({ op: "annot.delete", id: s.selected });
        s.select(null);
      } else if (e.key === "Escape") {
        s.setTool("select");
        s.setPendingImage(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  /* ------------------------------------------------------------ actions */
  async function exportBytes(): Promise<Uint8Array> {
    return runExport({ base: doc!.baseBytes, ops: effectiveOps(useEditor.getState()), external: doc!.extBytes });
  }

  async function download() {
    if (!doc) return;
    const current = effectiveOps(useEditor.getState());
    if (current.length === 0 && doc.baseVersionId === doc.currentVersionId) {
      saveBytes(doc.baseBytes, doc.file.name); // already in memory
      return;
    }
    setBusy("export");
    try {
      saveBytes(await exportBytes(), doc.file.name);
    } catch (e) {
      setNotice(e instanceof Error ? `Couldn't create the PDF: ${e.message}` : "Couldn't create the PDF.");
    } finally {
      setBusy(null);
    }
  }

  async function saveVersion() {
    if (!doc || !model) return;
    const current = effectiveOps(useEditor.getState());
    if (current.length === 0) {
      setNotice("Nothing to save yet. Your file is already up to date.");
      return;
    }
    savingVersion.current = true;
    setBusy("save");
    try {
      const bytes = await exportBytes();
      await uploadNewVersion(fileId, bytes, doc.baseVersionId, model.pages.length);
      useEditor.getState().reset([], 0);
      await load();
      setNotice("Saved as a new version.");
    } catch (e) {
      setNotice(e instanceof ApiFailure ? e.message : e instanceof Error ? `Couldn't save: ${e.message}` : "Couldn't save.");
    } finally {
      savingVersion.current = false;
      setBusy(null);
    }
  }

  async function addFromPdf(file: File) {
    if (!doc) return;
    setBusy("merge");
    try {
      const up = await uploadNewPdf(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await openPdf(bytes);
      setDoc({ ...doc, ext: { ...doc.ext, [up.versionId]: pdf }, extBytes: { ...doc.extBytes, [up.versionId]: bytes } });
      const tag = newId();
      useEditor.getState().apply({
        op: "page.insertFrom",
        at: mergeAt.current,
        fileId: up.fileId,
        versionId: up.versionId,
        pageCount: up.pageCount,
        pages: Array.from({ length: up.pageCount }, (_, i) => `x:${tag}:${i + 1}`),
      });
      setNotice(`Added ${up.pageCount} page${up.pageCount > 1 ? "s" : ""} from ${file.name}.`);
    } catch (e) {
      setNotice(e instanceof Error ? `Couldn't add that PDF: ${e.message}` : "Couldn't add that PDF.");
    } finally {
      setBusy(null);
    }
  }

  async function rename(name: string) {
    setRenaming(false);
    if (!doc || !name.trim() || name === doc.file.name) return;
    const r = await api<{ file: FileSummary }>(`/api/files/${fileId}`, { method: "PATCH", json: { name } });
    setDoc({ ...doc, file: { ...doc.file, name: r.file.name } });
  }

  function resolveConflict(keepMine: boolean) {
    const s = useEditor.getState();
    const server = s.conflictServer;
    if (!server) return;
    if (keepMine) {
      s.setSave("dirty", { revision: server.revision, conflictServer: null });
    } else {
      const parsed = OperationsSchema.safeParse(server.operations);
      s.reset(parsed.success ? parsed.data : [], server.revision);
    }
  }

  /* ------------------------------------------------------------- render */
  if (loadError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-ground p-6 text-center">
        <Mark size={48} />
        <p role="alert" className="max-w-md text-lg">{loadError}</p>
        <div className="flex gap-3">
          <Link href="/files" className="btn-secondary">My files</Link>
          <button type="button" className="btn-primary" onClick={() => void load()}>Try again</button>
        </div>
      </div>
    );
  }
  if (!doc || !model) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ground" aria-busy="true">
        <div className="flex flex-col items-center gap-3 text-zinc-600"><Mark size={44} className="animate-pulse" />Opening your PDF…</div>
      </div>
    );
  }

  const unsaved = eff.length;
  const statusText =
    saveState === "saving" ? "Saving draft…" :
    saveState === "dirty" ? "Unsaved changes" :
    saveState === "error" ? "Couldn't autosave. Retrying when you edit." :
    saveState === "conflict" ? "Edited in another tab" :
    unsaved ? `Draft saved · ${unsaved} change${unsaved > 1 ? "s" : ""}` : "All changes saved";
  const tab = (m: Mode, label: string) => (
    <button type="button" onClick={() => useEditor.getState().setMode(m)} aria-pressed={mode === m}
      className={`inline-flex h-9 items-center rounded-lg px-3.5 font-semibold ${mode === m ? "bg-white text-ink shadow-sm" : "text-zinc-600"}`}>
      {label}
    </button>
  );

  return (
    <DocsContext.Provider value={{ base: doc.base, ext: doc.ext }}>
      <div className="flex h-dvh flex-col bg-zinc-100 text-sm">
        <header className="border-b border-zinc-200 bg-white">
          <div className="flex min-h-16 flex-wrap items-center gap-x-5 gap-y-3 px-4 py-2.5">
            <div className="flex min-w-0 flex-[1_1_280px] items-center gap-2.5">
              <Link href="/files" aria-label="Back to my files" className="btn-ghost min-h-10 px-2"><IconBack /></Link>
              <Mark size={28} />
              <div className="min-w-0">
                {renaming ? (
                  <input autoFocus aria-label="File name" defaultValue={doc.file.name} className="field h-8 text-[15px] font-semibold"
                    onBlur={(e) => void rename(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(false); }} />
                ) : (
                  <button type="button" onClick={() => setRenaming(true)} title="Rename" className="block max-w-full truncate text-left text-[15px] font-semibold">{doc.file.name}</button>
                )}
                <div aria-live="polite" className={`flex items-center gap-1 text-xs ${saveState === "error" || saveState === "conflict" ? "text-red-700" : unsaved ? "text-zinc-600" : "text-green-700"}`}>
                  {saveState !== "error" && saveState !== "conflict" && !unsaved && <IconCheck size={12} />}{statusText}
                </div>
              </div>
            </div>
            <nav aria-label="Editor mode" className="flex gap-0.5 rounded-[10px] bg-zinc-100 p-[3px]">
              {tab("edit", "Edit")}{tab("organize", "Organize pages")}{tab("sign", "Fill and sign")}
            </nav>
            <div className="flex flex-[1_1_280px] items-center justify-end gap-2">
              <button type="button" className="btn-secondary min-h-10 px-3 text-sm" onClick={() => setDialog("history")}><IconHistory size={18} />History</button>
              <button type="button" className="btn-secondary min-h-10 px-3 text-sm" onClick={() => setDialog("share")}><IconShare size={18} />Share</button>
              <button type="button" aria-label="Download PDF" title="Download PDF" disabled={!!busy} className="btn-secondary min-h-10 px-2.5" onClick={() => void download()}>
                <IconDownload size={18} />
              </button>
              <button type="button" disabled={!!busy || unsaved === 0} className="btn-primary min-h-10 text-sm" onClick={() => void saveVersion()}>
                {busy === "save" ? "Saving…" : "Save version"}
              </button>
            </div>
          </div>
        </header>

        {conflict && (
          <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-amber-900">
            <span className="font-semibold">This file was changed in another tab or device.</span>
            <button type="button" className="btn-secondary min-h-9 text-sm" onClick={() => resolveConflict(false)}>Load the latest</button>
            <button type="button" className="btn-ghost min-h-9 text-sm" onClick={() => resolveConflict(true)}>Keep my changes</button>
          </div>
        )}
        {notice && (
          <div role="status" className="flex items-center gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2 text-brand-900">
            <span className="flex-1">{notice}</span>
            <button type="button" aria-label="Dismiss" className="btn-ghost min-h-8 px-2" onClick={() => setNotice(null)}>×</button>
          </div>
        )}
        {busy === "export" && <div role="status" className="bg-brand-600 px-4 py-1 text-center text-xs text-white">Preparing your PDF…</div>}

        {mode !== "organize" && <Toolbar onNeedSignature={() => setDialog("signature")} pageLabel={`${model.pages.length} page${model.pages.length > 1 ? "s" : ""}`} />}

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {mode === "sign" && <SignPanel fields={doc.fields} model={model} onCreateSignature={() => setDialog("signature")} />}
          {mode === "edit" && <Thumbnails pages={model.pages} onJump={(ref) => document.getElementById(`page-${ref}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} />}
          {mode === "organize" ? (
            <Organize model={model} busy={busy === "merge"} onAddFromPdf={(at) => { mergeAt.current = at; mergeInput.current?.click(); }} />
          ) : (
            <main ref={scroller} aria-label="Pages" className="min-h-0 min-w-0 flex-1 overflow-auto">
              <div className="flex flex-col items-center gap-6 px-4 py-7">
                {model.pages.map((p, i) => (
                  <div key={p.ref} id={`page-${p.ref}`} className="flex flex-col items-center gap-1.5">
                    <PageView entry={p} label={`Page ${i + 1}`} scale={zoom} interactive annotations={model.annotations.filter((a) => a.page === p.ref)} />
                    <span className="text-xs text-zinc-500">{i + 1}</span>
                  </div>
                ))}
              </div>
            </main>
          )}
          {mode === "edit" && <Properties annotations={model.annotations} />}
        </div>

        <input ref={mergeInput} type="file" accept="application/pdf,.pdf" className="sr-only" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void addFromPdf(f); }} />

        {dialog === "share" && <ShareDialog fileId={fileId} fileName={doc.file.name} isGuest={isGuest} hasUnsaved={unsaved > 0} onClose={() => setDialog(null)} />}
        {dialog === "history" && (
          <HistoryDrawer
            fileId={fileId}
            currentVersionId={doc.currentVersionId}
            unsavedCount={unsaved}
            onClose={() => setDialog(null)}
            onSaveNow={() => { setDialog(null); void saveVersion(); }}
            onDiscardDraft={async () => { await api(`/api/files/${fileId}/draft`, { method: "DELETE" }); useEditor.getState().reset([], 0); setDialog(null); await load(); }}
            onRestore={async (versionId) => { await api(`/api/files/${fileId}/restore`, { method: "POST", json: { versionId } }); useEditor.getState().reset([], 0); setDialog(null); await load(); setNotice("Restored. That version is current again."); }}
          />
        )}
        {dialog === "signature" && (
          <SignatureDialog
            onClose={() => setDialog(null)}
            onDone={(sig) => {
              setDialog(null);
              const s = useEditor.getState();
              s.setTool("signature");
              s.setPendingImage({ dataUrl: sig.dataUrl, w: sig.w, h: sig.h });
            }}
          />
        )}
      </div>
    </DocsContext.Provider>
  );
}

function Thumb({ entry, n, onJump }: { entry: import("@pdfinkly/shared").PageEntry; n: number; onJump: () => void }) {
  const info = usePageInfo(entry);
  const g = useMemo(() => (info ? makeGeom(info.view, (info.rotate + entry.rotation) % 360, 100 / (info.view[2] - info.view[0])) : null), [info, entry.rotation]);
  return (
    <button type="button" onClick={onJump} className="flex flex-col items-center gap-1.5 text-xs text-zinc-600 hover:text-ink" aria-label={`Go to page ${n}`}>
      {info && g ? <PageCanvas info={info} g={g} visible className="rounded-[3px] border border-zinc-200" /> : <span className="h-[129px] w-[100px] bg-white" />}
      {n}
    </button>
  );
}

function Thumbnails({ pages, onJump }: { pages: import("@pdfinkly/shared").PageEntry[]; onJump: (ref: string) => void }) {
  return (
    <aside aria-label="Pages" className="hidden w-[168px] flex-none flex-col items-center gap-3.5 overflow-y-auto border-r border-zinc-200 bg-white p-4 md:flex">
      {pages.map((p, i) => <Thumb key={p.ref} entry={p} n={i + 1} onJump={() => onJump(p.ref)} />)}
    </aside>
  );
}
