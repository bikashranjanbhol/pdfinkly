"use client";

import { useState } from "react";
import { saveUrlAs } from "@/lib/client/api";

/** Downloads a signed storage URL under the file's real name. */
export function DownloadButton({ url, name, className = "btn-primary" }: { url: string; name: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={className} disabled={busy} aria-busy={busy}
      onClick={async () => { setBusy(true); try { await saveUrlAs(url, name); } finally { setBusy(false); } }}>
      {busy ? "Downloading…" : "Download"}
    </button>
  );
}
