"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";
import type { UploadTicket } from "@pdfinkly/shared";
import { api, putWithProgress, sha256Hex } from "./api";

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;

/** PDF.js, loaded only in the browser, with its worker served from /pdf.worker.min.mjs. */
export function pdfjs(): Promise<PdfJs> {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    return m;
  });
  return lib;
}

/** Open a PDF from bytes (copied, since PDF.js transfers the buffer to its worker) or a URL. */
export async function openPdf(src: Uint8Array | string, password?: string): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  const task = m.getDocument({
    ...(typeof src === "string" ? { url: src } : { data: src.slice() }),
    ...(password ? { password } : {}),
    // Keep font names/flags on the main thread: the Edit text tool shows them and matches fonts.
    fontExtraProperties: true,
  });
  return task.promise;
}

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function countPages(bytes: Uint8Array): Promise<number> {
  const doc = await openPdf(bytes);
  const n = doc.numPages;
  await doc.loadingTask.destroy();
  return n;
}

/** Upload a brand-new PDF: create the file, PUT the bytes, then confirm. */
export async function uploadNewPdf(file: File, onProgress?: (f: number) => void, signal?: AbortSignal) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pageCount = await countPages(bytes); // also rejects non-PDFs before any upload
  const created = await api<{ fileId: string; versionId: string; upload: UploadTicket }>("/api/files", {
    method: "POST",
    json: { name: file.name, sizeBytes: file.size },
  });
  await putWithProgress(created.upload, new Blob([bytes], { type: "application/pdf" }), onProgress, signal);
  await api(`/api/files/${created.fileId}/versions/${created.versionId}/complete`, {
    method: "POST",
    json: { sha256: await sha256Hex(bytes), pageCount, source: "upload" },
  });
  return { fileId: created.fileId, versionId: created.versionId, pageCount };
}

/** Upload edited bytes as the next version of an existing file. */
export async function uploadNewVersion(fileId: string, bytes: Uint8Array, baseVersionId: string, pageCount: number, onProgress?: (f: number) => void) {
  const created = await api<{ versionId: string; upload: UploadTicket }>(`/api/files/${fileId}/versions`, {
    method: "POST",
    json: { sizeBytes: bytes.byteLength, baseVersionId },
  });
  await putWithProgress(created.upload, new Blob([bytes.slice()], { type: "application/pdf" }), onProgress);
  return api<{ version: { id: string; versionNo: number } }>(`/api/files/${fileId}/versions/${created.versionId}/complete`, {
    method: "POST",
    json: { sha256: await sha256Hex(bytes), pageCount, source: "edit" },
  });
}
