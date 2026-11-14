"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FileSummary } from "@pdfinkly/shared";
import { api, formatBytes, formatWhen } from "@/lib/client/api";
import { IconFile, IconTrash, IconUpload } from "./icons";

function expiresLabel(iso: string | null): string | null {
  if (!iso) return null;
  const hours = Math.round((new Date(iso).getTime() - Date.now()) / 3600_000);
  if (hours <= 0) return "Expiring";
  return hours < 48 ? `Expires in ${hours} h` : `Expires in ${Math.round(hours / 24)} days`;
}

export function FileList() {
  const [items, setItems] = useState<FileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: FileSummary[] }>("/api/files")).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your files.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(f: FileSummary) {
    if (!confirm(`Delete “${f.name}”? Share links to it stop working.`)) return;
    await api(`/api/files/${f.id}`, { method: "DELETE" });
    setItems((xs) => xs?.filter((x) => x.id !== f.id) ?? null);
  }

  return (
    <main className="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 pb-12 pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[32px] font-bold tracking-tight">My files</h1>
          <p className="mt-1 text-zinc-600">Everything you&apos;ve uploaded or saved. Open a file to edit it.</p>
        </div>
        <Link href="/upload" className="btn-primary"><IconUpload size={18} />Upload PDF</Link>
      </div>

      {error && <p role="alert" className="rounded-[10px] border border-red-200 bg-red-50 px-4 py-3 text-red-800">{error}</p>}

      {items === null && !error && <div className="card h-40 animate-pulse" aria-label="Loading files" />}

      {items?.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-zinc-300 bg-white px-6 py-14 text-center">
          <span className="flex size-14 items-center justify-center rounded-[14px] bg-brand-50 text-brand-600"><IconFile size={28} /></span>
          <div className="text-lg font-semibold">No files yet</div>
          <div className="max-w-[380px] text-zinc-600">Upload a PDF to start editing. Your edits stay in your browser until you save.</div>
          <Link href="/upload" className="btn-primary mt-1">Upload PDF</Link>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-[13px] text-zinc-600">
                <th scope="col" className="border-b border-zinc-200 px-5 py-3 font-semibold">Name</th>
                <th scope="col" className="border-b border-zinc-200 px-3 py-3 font-semibold">Pages</th>
                <th scope="col" className="border-b border-zinc-200 px-3 py-3 font-semibold">Size</th>
                <th scope="col" className="border-b border-zinc-200 px-3 py-3 font-semibold">Modified</th>
                <th scope="col" className="border-b border-zinc-200 px-3 py-3 font-semibold">Status</th>
                <th scope="col" className="border-b border-zinc-200 px-5 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => {
                const exp = expiresLabel(f.expiresAt);
                return (
                  <tr key={f.id} className="hover:bg-zinc-50">
                    <td className="border-b border-zinc-100 px-5 py-3">
                      <Link href={`/edit/${f.id}`} className="flex items-center gap-3 font-semibold text-ink">
                        <span className="flex h-10 w-8 flex-none items-end justify-center rounded border border-zinc-200 pb-1">
                          <span className="rounded-sm bg-red-600 px-1 text-[8px] font-bold text-white">PDF</span>
                        </span>
                        <span className="truncate">{f.name}</span>
                      </Link>
                    </td>
                    <td className="border-b border-zinc-100 px-3 py-3 text-zinc-600">{f.pageCount ?? "–"}</td>
                    <td className="border-b border-zinc-100 px-3 py-3 text-zinc-600">{formatBytes(f.sizeBytes)}</td>
                    <td className="border-b border-zinc-100 px-3 py-3 text-zinc-600">{formatWhen(f.updatedAt)}</td>
                    <td className="border-b border-zinc-100 px-3 py-3">
                      {f.status === "failed" ? (
                        <span className="pill bg-red-100 text-red-800">Failed</span>
                      ) : f.hasDraft ? (
                        <span className="pill bg-zinc-100 text-zinc-700">Unsaved draft</span>
                      ) : exp ? (
                        <span className="pill bg-amber-100 text-amber-900">{exp}</span>
                      ) : (
                        <span className="pill bg-green-100 text-green-800">Ready</span>
                      )}
                    </td>
                    <td className="border-b border-zinc-100 px-5 py-2 text-right">
                      <button type="button" onClick={() => remove(f)} aria-label={`Delete ${f.name}`} className="btn-ghost min-h-10 px-2.5 text-zinc-500 hover:text-red-700">
                        <IconTrash size={18} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
