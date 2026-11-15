/// <reference lib="webworker" />
import { exportPdf, ExportError } from "@pdfinkly/shared/export";
import { fontLoader, type WorkerInput } from "./exportShared";

// Runs pdf-lib off the main thread so big files don't freeze the editor.
self.onmessage = async (e: MessageEvent<WorkerInput>) => {
  const { fontBase, ...input } = e.data;
  const warnings: string[] = [];
  try {
    const bytes = await exportPdf({ ...input, loadFont: fontLoader(fontBase), onWarning: (w) => warnings.push(w) });
    (self as unknown as Worker).postMessage({ ok: true, bytes, warnings }, [bytes.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      code: err instanceof ExportError ? err.code : "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
