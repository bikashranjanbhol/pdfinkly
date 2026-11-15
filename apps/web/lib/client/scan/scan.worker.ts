/// <reference lib="webworker" />
import { analyse, render } from "./pipeline";
import type { ScanRequest, ScanResponse } from "./index";

self.onmessage = async (e: MessageEvent<ScanRequest>) => {
  const req = e.data;
  let res: ScanResponse;
  try {
    res =
      req.op === "analyse"
        ? { id: req.id, ok: true, analysis: await analyse(req.blob) }
        : { id: req.id, ok: true, rendered: await render(req.blob, req.quad, req.filter, req.turns, req.photo, req.thumbFilter) };
  } catch (err) {
    res = { id: req.id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(res);
};
