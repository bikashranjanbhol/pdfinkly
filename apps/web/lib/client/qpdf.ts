"use client";

/**
 * qpdf (the reference PDF toolkit) compiled to WebAssembly, served from
 * /qpdf/ and loaded as a plain script (its JS has Node-only branches that
 * bundlers trip over). Used for AES-256 password protection and for unlocking
 * protected PDFs, entirely in the browser.
 */

interface QpdfInstance {
  callMain(args: string[]): number;
  FS: { writeFile(path: string, data: Uint8Array): void; readFile(path: string): Uint8Array; unlink(path: string): void };
}
type Factory = (opts: Record<string, unknown>) => Promise<QpdfInstance>;

/** Lines qpdf printed during the current call (null between calls: output goes to the console). */
let log: string[] | null = null;
let instance: Promise<QpdfInstance> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't load the PDF security tools. Check your connection and try again."));
    document.head.appendChild(s);
  });
}

async function qpdf(): Promise<QpdfInstance> {
  instance ??= (async () => {
    const w = window as unknown as { Module?: Factory };
    if (!w.Module) await loadScript("/qpdf/qpdf.js");
    const factory = w.Module!;
    // The module binds console.log/console.error when it's created (its print hooks are
    // ignored), so hand it forwarders that feed `log` during a call.
    const orig = { log: console.log, error: console.error };
    console.log = (...a: unknown[]) => (log ? void log.push(a.join(" ")) : orig.log(...a));
    console.error = (...a: unknown[]) => (log ? void log.push(a.join(" ")) : orig.error(...a));
    const created = factory({ locateFile: () => "/qpdf/qpdf.wasm", noInitialRun: true });
    console.log = orig.log;
    console.error = orig.error;
    return created;
  })();
  instance.catch(() => { instance = null; });
  return instance;
}

let n = 0;
/** Run qpdf on one input file; returns the exit code, its output and (if asked) the output file. */
async function run(input: Uint8Array, args: (inPath: string, outPath: string) => string[], wantOutput: boolean) {
  const q = await qpdf();
  const id = ++n;
  const inPath = `/in-${id}.pdf`, outPath = `/out-${id}.pdf`;
  q.FS.writeFile(inPath, input);
  const lines: string[] = [];
  log = lines;
  try {
    let code: number;
    try { code = q.callMain(args(inPath, outPath)); } finally { log = null; }
    const text = lines.join("\n");
    const output = wantOutput && (code === 0 || code === 3) ? q.FS.readFile(outPath).slice() : null;
    return { code, text, output };
  } finally {
    for (const p of [inPath, outPath]) try { q.FS.unlink(p); } catch { /* not created */ }
  }
}

export interface Protection {
  /** Needed to open the file ("" = anyone can open it). */
  openPassword: string;
  /** Needed to change the permissions; generated when left empty and something is restricted. */
  ownerPassword: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowEdit: boolean;
}

/** Encrypt with AES-256 (PDF 2.0, revision 6) and the given permissions. */
export async function protectPdf(bytes: Uint8Array, p: Protection): Promise<Uint8Array> {
  const restricted = !p.allowPrint || !p.allowCopy || !p.allowEdit;
  let owner = p.ownerPassword;
  if (!owner) {
    // No permissions password: with restrictions, make one nobody knows (so they can't be lifted);
    // without, reuse the open password (whoever can open it can do anything anyway).
    owner = restricted ? Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("") : p.openPassword;
  }
  const r = await run(bytes, (i, o) => [
    "--encrypt", `--user-password=${p.openPassword}`, `--owner-password=${owner}`, "--bits=256",
    `--print=${p.allowPrint ? "full" : "none"}`, `--extract=${p.allowCopy ? "y" : "n"}`, `--modify=${p.allowEdit ? "all" : "none"}`,
    "--", i, o,
  ], true);
  if (!r.output) throw new Error(`Couldn't protect the PDF: ${r.text.split("\n").pop() || `qpdf exited with ${r.code}`}`);
  return r.output;
}

export type LockState = { encrypted: false } | { encrypted: true; needsPassword: boolean };

/** Is the PDF encrypted, and does it need a password just to open? */
export async function lockState(bytes: Uint8Array): Promise<LockState> {
  // Opens without a password? Then --is-encrypted tells us if only its permissions are locked.
  const show = await run(bytes, (i) => ["--show-encryption", i], false);
  if (/invalid password/i.test(show.text)) return { encrypted: true, needsPassword: true };
  const enc = await run(bytes, (i) => ["--is-encrypted", i], false);
  return enc.code === 0 ? { encrypted: true, needsPassword: false } : { encrypted: false };
}

export class WrongPasswordError extends Error {
  constructor(message: string) { super(message); this.name = "WrongPasswordError"; }
}

/**
 * Remove encryption with the file's password. A file that opens without one
 * (only its permissions are locked) needs its permissions (owner) password.
 */
export async function unlockPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const state = await lockState(bytes);
  if (!state.encrypted) return bytes;
  const info = await run(bytes, (i) => ["--show-encryption", `--password=${password}`, i], false);
  if (info.code !== 0 && info.code !== 3) throw new WrongPasswordError("That password isn't right. Check it and try again.");
  if (!state.needsPassword && !/Supplied password is owner password/.test(info.text)) {
    throw new WrongPasswordError("This PDF opens without a password but its permissions are locked. Enter its permissions (owner) password to unlock it.");
  }
  const r = await run(bytes, (i, o) => [`--password=${password}`, "--decrypt", "--", i, o], true);
  if (!r.output) throw new WrongPasswordError("That password isn't right. Check it and try again.");
  return r.output;
}
