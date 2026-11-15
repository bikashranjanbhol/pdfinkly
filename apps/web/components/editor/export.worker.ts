/// <reference lib="webworker" />
import { exportPdf, ExportError, planRedactionImages } from "@pdfinkly/shared/export";
import { fontLoader, type WorkerMessage } from "./exportShared";

// Runs pdf-lib off the main thread so big files don't freeze the editor.
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (e.data.type === "plan") {
      const { base, ops, external } = e.data;
      const jobs = await planRedactionImages({ base, ops, external });
      post({ ok: true, jobs }, jobs.map((j) => j.pdf.buffer));
      return;
    }
    const { type: _t, fontBase, ...input } = e.data;
    const warnings: string[] = [];
    const bytes = await exportPdf({ ...input, loadFont: fontLoader(fontBase), onWarning: (w) => warnings.push(w) });
    post({ ok: true, bytes, warnings }, [bytes.buffer]);
  } catch (err) {
    post({
      ok: false,
      code: err instanceof ExportError ? err.code : "INTERNAL",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
