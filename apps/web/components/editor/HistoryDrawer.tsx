"use client";

import { useEffect, useState } from "react";
import type { VersionInfo } from "@pdfinkly/shared";
import { api, formatBytes, formatWhen } from "@/lib/client/api";
import { IconDownload, IconX } from "../icons";

const SOURCE: Record<VersionInfo["source"], string> = { upload: "Uploaded", edit: "Saved from editor", job: "Processed" };

export function HistoryDrawer({ fileId, currentVersionId, unsavedCount, onRestore, onDiscardDraft, onSaveNow, onClose }: {
  fileId: string;
  currentVersionId: string;
  unsavedCount: number;
  onRestore: (versionId: string) => Promise<void>;
  onDiscardDraft: () => Promise<void>;
  onSaveNow: () => void;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<VersionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<{ versions: VersionInfo[] }>(`/api/files/${fileId}`).then((r) => setVersions(r.versions));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fileId, onClose]);

  async function download(v: VersionInfo) {
    const r = await api<{ downloadUrl: string }>(`/api/files/${fileId}/versions/${v.id}`);
    window.location.href = r.downloadUrl;
  }

  return (
    <div className="fixed inset-0 z-50 bg-zinc-900/35" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-labelledby="hist-title" className="absolute inset-y-0 right-0 flex w-[400px] max-w-full flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-6 py-5">
          <div>
            <h2 id="hist-title" className="font-display text-xl font-bold">Version history</h2>
            <p className="mt-1 text-zinc-600">Restoring never deletes anything. It makes an older version current again.</p>
          </div>
          <button type="button" aria-label="Close version history" onClick={onClose} className="btn-ghost min-h-10 px-2.5"><IconX /></button>
        </div>
        <div className="flex flex-col gap-3 overflow-y-auto px-6 py-4">
          {unsavedCount > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
              <div className="font-semibold text-amber-900">Unsaved draft</div>
              <div className="text-[13px] text-amber-900">{unsavedCount} change{unsavedCount > 1 ? "s" : ""} since the current version, autosaved.</div>
              <div className="flex gap-2">
                <button type="button" className="btn-primary min-h-10 text-sm" onClick={onSaveNow}>Save as new version</button>
                <button type="button" className="btn min-h-10 border border-amber-300 bg-white text-sm text-amber-900"
                  onClick={async () => { if (confirm("Discard all unsaved edits?")) { setBusy("draft"); await onDiscardDraft(); setBusy(null); } }}>
                  Discard draft
                </button>
              </div>
            </div>
          )}
          {versions === null && <p className="text-sm text-zinc-500">Loading…</p>}
          <ol className="flex flex-col">
            {versions?.map((v) => {
              const current = v.id === currentVersionId;
              return (
                <li key={v.id} className="flex gap-3.5 border-b border-zinc-100 py-3.5 last:border-0">
                  <span className={`mt-1.5 size-3 flex-none rounded-full ${current ? "bg-brand-600 ring-4 ring-brand-100" : "bg-zinc-400"}`} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold">Version {v.versionNo}</span>
                      {current && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">CURRENT</span>}
                    </div>
                    <div className="text-[13px] text-zinc-600">{SOURCE[v.source]} · {formatWhen(v.createdAt)} · {formatBytes(v.sizeBytes)}{v.pageCount ? ` · ${v.pageCount} pages` : ""}</div>
                    <div className="mt-1 flex gap-2">
                      {!current && (
                        <button type="button" disabled={!!busy} className="btn-secondary min-h-9 text-sm"
                          onClick={async () => {
                            if (unsavedCount && !confirm("Restoring discards your unsaved edits. Continue?")) return;
                            setBusy(v.id);
                            await onRestore(v.id);
                            setBusy(null);
                          }}>
                          {busy === v.id ? "Restoring…" : "Restore"}
                        </button>
                      )}
                      <button type="button" aria-label={`Download version ${v.versionNo}`} className="btn-secondary min-h-9 px-2.5" onClick={() => void download(v)}>
                        <IconDownload size={16} />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </aside>
    </div>
  );
}
