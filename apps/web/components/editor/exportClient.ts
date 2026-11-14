"use client";

import type { ExportInput } from "@pdfinkly/shared/export";

type Reply = { ok: true; bytes: Uint8Array } | { ok: false; code: string; message: string };

/** Apply operations to the PDF with pdf-lib in a Web Worker (falls back to the main thread). */
export async function runExport(input: ExportInput): Promise<Uint8Array> {
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
        worker!.postMessage(input);
      });
      if (reply.ok) return reply.bytes;
      throw Object.assign(new Error(reply.message), { code: reply.code });
    } catch (e) {
      if ((e as { code?: string }).code) throw e;
      // Worker failed to start or crashed: fall through to the main thread.
    } finally {
      worker.terminate();
    }
  }
  const { exportPdf } = await import("@pdfinkly/shared/export");
  return exportPdf(input);
}
