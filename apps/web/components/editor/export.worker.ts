/// <reference lib="webworker" />
import { applyCompression, exportPdf, ExportError, planCompression, planRedactionImages, stripText } from "@pdfinkly/shared/export";
import { fontLoader, type WorkerMessage } from "./exportShared";

// Runs pdf-lib off the main thread so big files don't freeze the editor.
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    if (e.data.type === "compressPlan") {
      const compressJobs = await planCompression(e.data.bytes);
      post({ ok: true, compressJobs }, compressJobs.map((j) => j.pdf.buffer));
      return;
    }
    if (e.data.type === "stripText") {
      const compressed = await stripText(e.data.bytes);
      post({ ok: true, compressed }, [compressed.buffer]);
      return;
    }
    if (e.data.type === "compressApply") {
      const compressed = await applyCompression(e.data.bytes, e.data.results);
      post({ ok: true, compressed }, [compressed.buffer]);
      return;
    }
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
