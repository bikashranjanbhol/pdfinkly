import type { ExportInput } from "@pdfinkly/shared/export";

/** What the export worker receives: the export input minus callbacks (functions can't be posted). */
export type WorkerInput = Omit<ExportInput, "loadFont" | "onWarning"> & { fontBase: string };

export const fontLoader = (fontBase: string) => async (file: string) => {
  const res = await fetch(fontBase + file);
  if (!res.ok) throw new Error(`Font ${file} failed to load (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
};
