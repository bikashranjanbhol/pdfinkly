"use client";

import type { ExportInput } from "@pdfinkly/shared/export";
import { fontLoader, type WorkerInput } from "./exportShared";

type Reply = { ok: true; bytes: Uint8Array; warnings: string[] } | { ok: false; code: string; message: string };

/** Apply operations to the PDF with pdf-lib in a Web Worker (falls back to the main thread). */
export async function runExport(
  input: Omit<ExportInput, "loadFont" | "onWarning">,
  opts: { onWarning?: (message: string) => void } = {},
): Promise<Uint8Array> {
  const fontBase = `${window.location.origin}/fonts/`;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (worker) {
    try {
      const reply = await new Promise<Reply>((resolve, reject) => {
        worker!.onmessage = (e: MessageEvent<Reply>) => resolve(e.data);
        worker!.onerror = (e) => reject(e);
        // Copies (not transfers) the inputs: the editor keeps using its buffers.
        worker!.postMessage({ ...input, fontBase } satisfies WorkerInput);
      });
      if (reply.ok) {
        reply.warnings.forEach((w) => opts.onWarning?.(w));
        return reply.bytes;
      }
      throw Object.assign(new Error(reply.message), { code: reply.code });
    } catch (e) {
      if ((e as { code?: string }).code) throw e;
      // Worker failed to start or crashed: fall through to the main thread.
    } finally {
      worker.terminate();
    }
  }
  const { exportPdf } = await import("@pdfinkly/shared/export");
  return exportPdf({ ...input, loadFont: fontLoader(fontBase), onWarning: opts.onWarning });
}
