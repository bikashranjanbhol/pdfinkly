"use client";

import Link from "next/link";
import { useEffect } from "react";
import { IconCheck, IconX } from "../icons";

/** "This needs Pro" — shown when a Free user opens a Pro tool or runs out of monthly jobs. */
export function UpgradeDialog({ title, message, onClose }: { title: string; message: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="upgrade-title" className="w-full max-w-[440px] rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <h2 id="upgrade-title" className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-zinc-600">{message}</p>
          </div>
          <button type="button" aria-label="Close" className="btn-ghost min-h-9 px-2" onClick={onClose}><IconX /></button>
        </div>
        <ul className="flex flex-col gap-2 px-6 py-4 text-[15px]">
          {["Unlimited conversions and compression", "Redaction with Aadhaar and PAN detection", "Password protection and Bates numbering", "Files up to 200 MB, kept until you delete them"].map((t) => (
            <li key={t} className="flex gap-2.5"><IconCheck size={18} className="mt-0.5 flex-none text-green-700" />{t}</li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-6 py-4">
          <button type="button" className="btn-secondary" onClick={onClose}>Not now</button>
          <Link href="/pricing" target="_blank" className="btn-primary">See Pro plans</Link>
        </div>
      </div>
    </div>
  );
}
