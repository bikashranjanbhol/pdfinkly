"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "@/lib/client/api";
import { IconCopy, IconX } from "../icons";

interface Status {
  live: boolean;
  phoneConnected: boolean;
  expiresAt: string;
  pages: { id: string; seq: number; width: number; height: number; url: string }[];
}

export interface ReceivedPage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * "Use your phone": a QR code with a one-time link. Pages sent from the phone
 * are downloaded here as they arrive (then deleted from the server).
 */
export function PhoneLink({ onPages, onClose }: { onPages: (pages: ReceivedPage[]) => void; onClose: () => void }) {
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [received, setReceived] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const seen = useRef(new Set<string>());
  const onPagesRef = useRef(onPages);
  onPagesRef.current = onPages;

  // Make a link and its QR code.
  useEffect(() => {
    let live = true;
    setLink(null);
    setSvg(null);
    setStatus(null);
    setError(null);
    (async () => {
      try {
        const r = await api<{ id: string; url: string; expiresAt: string }>("/api/scan/handoff", { method: "POST" });
        const QR = await import("qrcode");
        const code = await QR.toString(r.url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#18181b", light: "#ffffff" } });
        if (!live) return;
        setLink({ id: r.id, url: r.url });
        setSvg(code);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Couldn't make a code. Please try again.");
      }
    })();
    return () => {
      live = false;
    };
  }, [attempt]);

  // Watch for the phone and its pages.
  useEffect(() => {
    if (!link) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") {
        try {
          const s = await api<Status>(`/api/scan/handoff/${link.id}`);
          if (stop) return;
          setStatus(s);
          const fresh = s.pages.filter((p) => !seen.current.has(p.id));
          if (fresh.length) {
            const got: ReceivedPage[] = [];
            const ids: string[] = [];
            for (const p of fresh) {
              const res = await fetch(p.url);
              if (!res.ok) continue;
              got.push({ blob: new Blob([await res.arrayBuffer()], { type: "image/jpeg" }), width: p.width, height: p.height });
              ids.push(p.id);
              seen.current.add(p.id);
            }
            if (got.length) {
              onPagesRef.current(got);
              setReceived((n) => n + got.length);
              await api(`/api/scan/handoff/${link.id}/collect`, { method: "POST", json: { pageIds: ids } }).catch(() => undefined);
            }
          }
          if (!s.live) return; // expired: stop asking
        } catch (e) {
          if (e instanceof ApiFailure && e.status === 404) {
            setStatus((st) => (st ? { ...st, live: false } : st));
            return;
          }
        }
      }
      timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [link]);

  async function close() {
    if (link) await api(`/api/scan/handoff/${link.id}`, { method: "DELETE" }).catch(() => undefined);
    onClose();
  }

  const expired = status && !status.live;
  const connected = status?.phoneConnected;

  return (
    <section aria-labelledby="phone-h" className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-start">
      <div className="flex size-[188px] flex-none items-center justify-center self-center rounded-xl border border-zinc-200 bg-white p-2 sm:self-start">
        {svg && !expired ? (
          <div role="img" aria-label="QR code for scanning with your phone" className={`size-full ${connected ? "opacity-40" : ""}`} dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <span className="px-4 text-center text-sm text-zinc-600">{expired ? "This code has expired." : error ? "No code" : "Making a code…"}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <h2 id="phone-h" className="text-lg font-semibold">Scan with your phone</h2>
          <button type="button" className="btn-ghost min-h-9 px-2" aria-label="Stop using your phone" onClick={() => void close()}><IconX /></button>
        </div>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[15px] text-zinc-700">
          <li>Point your phone&apos;s camera at the code and open the link.</li>
          <li>Take photos of your pages. They&apos;re cropped and cleaned up on the phone.</li>
          <li>Tap <span className="font-semibold">Send to computer</span>. The pages appear here.</li>
        </ol>
        <p role="status" aria-live="polite" className={`rounded-lg px-3 py-2 text-sm font-medium ${expired ? "bg-amber-50 text-amber-900" : connected ? "bg-green-50 text-green-900" : "bg-zinc-100 text-zinc-700"}`}>
          {error
            ? error
            : expired
              ? "This code has expired."
              : connected
                ? received
                  ? `Phone connected · ${received} ${received === 1 ? "page" : "pages"} received`
                  : "Phone connected. Take photos, then tap Send to computer."
                : "Waiting for your phone…"}
        </p>
        {(expired || error) && (
          <button type="button" className="btn-secondary self-start" onClick={() => { seen.current.clear(); setAttempt((a) => a + 1); }}>Make a new code</button>
        )}
        {link && !expired && (
          <div className="flex min-w-0 items-center gap-2 text-[13px] text-zinc-600">
            <span className="flex-none">Or open on your phone:</span>
            <code className="min-w-0 truncate rounded bg-zinc-100 px-1.5 py-0.5">{link.url}</code>
            <button
              type="button"
              className="btn-ghost min-h-8 flex-none px-2 text-[13px]"
              onClick={() => { void navigator.clipboard?.writeText(link.url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
            >
              <IconCopy size={16} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
        <p className="text-[13px] text-zinc-600">
          The code works for 15 minutes and can only add pages here. Pages pass through our private storage over HTTPS and are deleted as soon as
          they arrive; anything not picked up is deleted automatically.
        </p>
      </div>
    </section>
  );
}
