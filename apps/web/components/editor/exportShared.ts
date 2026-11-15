import type { CompressJob, CompressResult, ExportInput, RedactImageJob } from "@pdfinkly/shared/export";

/** What the export worker receives: the export input minus callbacks (functions can't be posted). */
export type WorkerInput = Omit<ExportInput, "loadFont" | "onWarning"> & { fontBase: string };

/** Messages to the export worker: build the PDF, or list the images redactions must clean. */
export type WorkerMessage =
  | ({ type: "export" } & WorkerInput)
  | { type: "plan"; base: Uint8Array; ops: ExportInput["ops"]; external?: ExportInput["external"] }
  | { type: "compressPlan"; bytes: Uint8Array }
  | { type: "compressApply"; bytes: Uint8Array; results: CompressResult[] };

export type WorkerReply =
  | { ok: true; bytes: Uint8Array; warnings: string[] }
  | { ok: true; jobs: RedactImageJob[] }
  | { ok: true; compressJobs: CompressJob[] }
  | { ok: true; compressed: Uint8Array }
  | { ok: false; code: string; message: string };

export const fontLoader = (fontBase: string) => async (file: string) => {
  const res = await fetch(fontBase + file);
  if (!res.ok) throw new Error(`Font ${file} failed to load (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
};
