import type { UploadTicket } from "@pdfinkly/shared";

export interface StorageDriver {
  /** Short-lived URL the browser PUTs the bytes to. */
  presignPut(key: string, sizeBytes: number, contentType: string): Promise<UploadTicket>;
  /** Short-lived URL the browser GETs the bytes from. */
  presignGet(key: string, opts?: { downloadName?: string }): Promise<string>;
  /** Size of a stored object, or null if it isn't there. */
  head(key: string): Promise<{ size: number } | null>;
  /** First `n` bytes of an object (to check the %PDF- magic). */
  readStart(key: string, n: number): Promise<Uint8Array>;
  remove(keys: string[]): Promise<void>;
}

export const UPLOAD_TTL_SECONDS = 10 * 60;
export const DOWNLOAD_TTL_SECONDS = 5 * 60;

/** Make a file name safe for Content-Disposition. */
export function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
