"use client";

import type { ExportInput, RedactImageJob } from "@pdfinkly/shared/export";
import { cleanRedactedImages } from "@/lib/client/redaction";
import { fontLoader, type WorkerMessage, type WorkerReply } from "./exportShared";

type Input = Omit<ExportInput, "loadFont" | "onWarning">;

/** Run one job in a fresh Web Worker; null when workers aren't available (or it crashed). */
export async function inWorker(msg: WorkerMessage): Promise<WorkerReply | null> {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  try {
    return await new Promise<WorkerReply>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerReply>) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      // Copies (not transfers) the inputs: the editor keeps using its buffers.
      worker.postMessage(msg);
    });
  } catch {
    return null;
  } finally {
    worker.terminate();
  }
}

const fail = (r: { code: string; message: string }) => Object.assign(new Error(r.message), { code: r.code });

/**
 * Apply operations to the PDF with pdf-lib in a Web Worker (falls back to the
 * main thread). With redactions, images under them are first decoded and
 * blacked out here (the worker can't render), then swapped in by the export.
 */
export async function runExport(input: Input, opts: { onWarning?: (message: string) => void } = {}): Promise<Uint8Array> {
  const fontBase = `${window.location.origin}/fonts/`;

  let redactImages = input.redactImages;
  if (!redactImages && input.ops.some((o) => o.op === "annot.add" && o.annot.kind === "redact")) {
    const plan = { type: "plan" as const, base: input.base, ops: input.ops, external: input.external };
    const reply = await inWorker(plan);
    let jobs: RedactImageJob[];
    if (reply && reply.ok && "jobs" in reply) jobs = reply.jobs;
    else if (reply && !reply.ok) throw fail(reply);
    else jobs = await (await import("@pdfinkly/shared/export")).planRedactionImages(plan);
    redactImages = await cleanRedactedImages(jobs);
  }

  const full = { ...input, ...(redactImages ? { redactImages } : {}) };
  const reply = await inWorker({ type: "export", ...full, fontBase });
  if (reply && reply.ok && "bytes" in reply) {
    reply.warnings.forEach((w) => opts.onWarning?.(w));
    return reply.bytes;
  }
  if (reply && !reply.ok) throw fail(reply);
  const { exportPdf } = await import("@pdfinkly/shared/export");
  return exportPdf({ ...full, loadFont: fontLoader(fontBase), onWarning: opts.onWarning });
}
