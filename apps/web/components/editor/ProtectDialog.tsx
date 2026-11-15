"use client";

import { useEffect, useRef, useState } from "react";
import type { Protection } from "@/lib/client/qpdf";
import { IconX } from "../icons";

/** Choose an open password and/or permissions, then download an AES-256 protected copy. */
export function ProtectDialog({ fileName, onClose, onProtect }: { fileName: string; onClose: () => void; onProtect: (p: Protection) => Promise<void> }) {
  const [open, setOpen] = useState("");
  const [confirm, setConfirm] = useState("");
  const [owner, setOwner] = useState("");
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowEdit, setAllowEdit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => { dialog.current?.querySelector<HTMLInputElement>("input")?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const restricted = !allowPrint || !allowCopy || !allowEdit;
  const mismatch = open !== confirm;
  const nothing = !open && !restricted;
  const sameAsOpen = !!owner && owner === open;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch || nothing || sameAsOpen) return;
    setBusy(true);
    setError(null);
    try {
      await onProtect({ openPassword: open, ownerPassword: owner, allowPrint, allowCopy, allowEdit });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't protect the PDF.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="protect-title" className="w-full max-w-[480px] rounded-2xl bg-white shadow-2xl">
        <form onSubmit={(e) => void submit(e)}>
          <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
            <div>
              <h2 id="protect-title" className="text-lg font-semibold">Download with password</h2>
              <p className="text-sm text-zinc-600">A protected copy of {fileName} (AES-256). Your file here stays as it is.</p>
            </div>
            <button type="button" aria-label="Close" className="btn-ghost min-h-9 px-2" onClick={onClose} disabled={busy}><IconX /></button>
          </div>
          <div className="flex flex-col gap-4 px-6 py-5">
            <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
              Password to open
              <input className="field h-10 font-normal" type="password" autoComplete="new-password" value={open} onChange={(e) => setOpen(e.target.value)} placeholder="Leave empty to allow anyone to open it" />
            </label>
            {open && (
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Repeat the password
                <input className="field h-10 font-normal" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                {confirm && mismatch && <span className="font-normal text-red-700">The passwords don&apos;t match.</span>}
              </label>
            )}
            <fieldset className="flex flex-col gap-2 text-sm">
              <legend className="mb-1.5 text-[13px] font-semibold text-zinc-700">People who open it can</legend>
              <label className="flex items-center gap-2"><input type="checkbox" checked={allowPrint} onChange={(e) => setAllowPrint(e.target.checked)} /> Print</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} /> Copy text and images</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={allowEdit} onChange={(e) => setAllowEdit(e.target.checked)} /> Edit, comment and fill forms</label>
            </fieldset>
            {restricted && (
              <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-zinc-700">
                Password to change these permissions
                <input className="field h-10 font-normal" type="password" autoComplete="new-password" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Optional" />
                <span className="font-normal text-zinc-500">
                  {owner ? "Keep it safe: it's the only way to lift the restrictions." : "Without one, nobody (including you) can lift the restrictions later; you can always download a new copy from here."}
                </span>
                {sameAsOpen && <span className="font-normal text-red-700">Use a different password from the one to open the file.</span>}
              </label>
            )}
            <p className="text-[13px] text-zinc-500">Most PDF apps respect these permissions, but they can&apos;t stop someone who can open the file from taking a photo of it.</p>
            {nothing && <p className="text-[13px] text-zinc-600">Add a password or turn off a permission to protect the file.</p>}
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          </div>
          <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy || mismatch || nothing || sameAsOpen}>{busy ? "Protecting…" : "Download protected PDF"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
