/// <reference lib="webworker" />
import { exportPdf, ExportError, type ExportInput } from "@pdfinkly/shared/export";

// Runs pdf-lib off the main thread so big files don't freeze the editor.
self.onmessage = async (e: MessageEvent<ExportInput>) => {
  try {
    const bytes = await exportPdf(e.data);
    (self as unknown as Worker).postMessage({ ok: true, bytes }, [bytes.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      code: err instanceof ExportError ? err.code : "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
