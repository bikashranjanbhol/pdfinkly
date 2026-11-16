"use client";

import type { Quad, ScanFilter } from "@pdfinkly/shared/scan";
import type { Analysis, Rendered } from "./pipeline";

export type { Analysis, Rendered };

export type ScanRequest =
  | { id: number; op: "analyse"; blob: Blob }
  | { id: number; op: "render"; blob: Blob; quad: Quad; filter: ScanFilter; turns: number; photo: { width: number; height: number }; thumbFilter?: ScanFilter; maxSide?: number };
export type ScanResponse =
  | { id: number; ok: true; analysis: Analysis }
  | { id: number; ok: true; rendered: Rendered }
  | { id: number; ok: false; message: string };

type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type Job = DistOmit<ScanRequest, "id">;

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (r: ScanResponse) => void>();

/** A worker that can draw off the page (OffscreenCanvas), or null to work on the page itself. */
function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    const ok = typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && "convertToBlob" in OffscreenCanvas.prototype;
    worker = ok ? new Worker(new URL("./scan.worker.ts", import.meta.url), { type: "module" }) : null;
    worker?.addEventListener("message", (e: MessageEvent<ScanResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    });
    worker?.addEventListener("error", () => {
      // The worker couldn't start: fall back to the page, and retry what was waiting.
      worker = null;
      for (const [id, done] of pending) done({ id, ok: false, message: "__retry__" });
      pending.clear();
    });
  } catch {
    worker = null;
  }
  return worker;
}

async function onPage(job: Job): Promise<ScanResponse> {
  const p = await import("./pipeline");
  try {
    if (job.op === "analyse") return { id: 0, ok: true, analysis: await p.analyse(job.blob) };
    return { id: 0, ok: true, rendered: await p.render(job.blob, job.quad, job.filter, job.turns, job.photo, job.thumbFilter, job.maxSide) };
  } catch (e) {
    return { id: 0, ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

async function run(job: Job): Promise<ScanResponse> {
  const w = getWorker();
  if (!w) return onPage(job);
  const id = nextId++;
  const res = await new Promise<ScanResponse>((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ ...job, id } as ScanRequest);
  });
  if (!res.ok && res.message === "__retry__") return onPage(job);
  return res;
}

// One photo at a time: phone memory is limited and each photo is large.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
}

export function analysePhoto(blob: Blob): Promise<Analysis> {
  return serial(async () => {
    const r = await run({ op: "analyse", blob });
    if (!r.ok) throw new Error(r.message);
    return (r as { analysis: Analysis }).analysis;
  });
}

export function renderPage(
  blob: Blob, quad: Quad, filter: ScanFilter, turns: number, photo: { width: number; height: number }, thumbFilter?: ScanFilter, maxSide?: number,
): Promise<Rendered> {
  return serial(async () => {
    const r = await run({ op: "render", blob, quad, filter, turns, photo, thumbFilter, maxSide });
    if (!r.ok) throw new Error(r.message);
    return (r as { rendered: Rendered }).rendered;
  });
}
