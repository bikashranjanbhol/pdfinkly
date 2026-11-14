"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiFailure, formatWhen } from "@/lib/client/api";
import { IconX } from "../icons";

interface ShareItem { id: string; hint: string; expiresAt: string | null; revokedAt: string | null; createdAt: string }

export function ShareDialog({ fileId, fileName, isGuest, hasUnsaved, onClose }: {
  fileId: string; fileName: string; isGuest: boolean; hasUnsaved: boolean; onClose: () => void;
}) {
  const [items, setItems] = useState<ShareItem[] | null>(null);
  const [expires, setExpires] = useState<"7" | "1" | "30" | "never">("7");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<{ items: ShareItem[] }>(`/api/files/${fileId}/shares`).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(() => {
    if (!isGuest) void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>(`/api/files/${fileId}/shares`, {
        method: "POST",
        json: { permission: "view", expiresInDays: expires === "never" ? null : Number(expires) },
      });
      setCreated(r.url);
      setCopied(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't create the link.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api(`/api/shares/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="share-title" className="w-full max-w-[560px] rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-5">
          <div className="min-w-0">
            <h2 id="share-title" className="truncate font-display text-xl font-bold">Share {fileName}</h2>
            <p className="mt-1 text-zinc-600">Anyone with the link can view and download the current saved version. You can revoke a link any time.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="btn-ghost min-h-10 px-2.5"><IconX /></button>
        </div>

        {isGuest ? (
          <div className="flex flex-col items-start gap-3 px-6 py-6">
            <p>Sign in to create share links. Your file comes with you.</p>
            <Link href="/signin" className="btn-primary">Sign in</Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-6 py-5">
            {hasUnsaved && (
              <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                You have unsaved edits. Links show the last saved version, so save first if you want them included.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-1 flex-col gap-1.5 text-[13px] font-semibold">
                Link expires
                <select className="field font-normal" value={expires} onChange={(e) => setExpires(e.target.value as typeof expires)}>
                  <option value="7">In 7 days</option>
                  <option value="1">In 24 hours</option>
                  <option value="30">In 30 days</option>
                  <option value="never">Never</option>
                </select>
              </label>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void create()}>{busy ? "Creating…" : "Create link"}</button>
            </div>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {created && (
              <div className="flex flex-col gap-2.5 rounded-xl border border-green-200 bg-green-50 p-3.5">
                <span className="font-semibold text-green-800">Link created</span>
                <div className="flex gap-2">
                  <label htmlFor="share-link" className="sr-only">Share link</label>
                  <input id="share-link" readOnly value={created} className="field min-w-0 flex-1 font-mono text-[13px]" onFocus={(e) => e.target.select()} />
                  <button type="button" className="btn-secondary" onClick={async () => { await navigator.clipboard.writeText(created); setCopied(true); }}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <span className="text-[13px] text-green-800">Copy it now. For your security the full link is only shown once.</span>
              </div>
            )}
            <section aria-labelledby="links-h">
              <h3 id="links-h" className="mb-1.5 text-sm font-semibold">Links for this file</h3>
              {items === null && <p className="text-sm text-zinc-500">Loading…</p>}
              {items?.length === 0 && <p className="text-sm text-zinc-500">No links yet.</p>}
              {items?.map((s) => {
                const expired = s.expiresAt && new Date(s.expiresAt) < new Date();
                const dead = !!s.revokedAt || !!expired;
                return (
                  <div key={s.id} className="flex items-center gap-3 border-t border-zinc-100 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className={`font-semibold ${dead ? "text-zinc-500 line-through" : ""}`}>View link · …{s.hint}</div>
                      <div className="text-[13px] text-zinc-600">
                        Created {formatWhen(s.createdAt)} · {s.revokedAt ? "revoked" : expired ? "expired" : s.expiresAt ? `expires ${formatWhen(s.expiresAt)}` : "never expires"}
                      </div>
                    </div>
                    {!dead && <button type="button" className="btn-danger min-h-10 text-sm" onClick={() => void revoke(s.id)}>Revoke</button>}
                  </div>
                );
              })}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
