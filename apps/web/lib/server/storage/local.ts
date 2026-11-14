import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { DOWNLOAD_TTL_SECONDS, UPLOAD_TTL_SECONDS, type StorageDriver } from "./types";

/**
 * Local-disk storage for development only. It mimics presigned URLs with an
 * HMAC over (method, key, size, expiry), served by /api/dev-storage/[...key].
 * Never use it in production: Vercel's filesystem is not persistent.
 */
export const LOCAL_ROOT = path.resolve(
  /* turbopackIgnore: true */ process.env.LOCAL_STORAGE_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".dev-storage"),
);

export function localPath(key: string): string {
  const p = path.resolve(/* turbopackIgnore: true */ LOCAL_ROOT, key);
  if (!p.startsWith(LOCAL_ROOT + path.sep)) throw new Error("Invalid storage key");
  return p;
}

export function signLocal(method: "PUT" | "GET", key: string, exp: number, size = 0, download = ""): string {
  return createHmac("sha256", env.authSecret).update(`${method}\n${key}\n${exp}\n${size}\n${download}`).digest("base64url");
}

export function verifyLocal(method: "PUT" | "GET", key: string, exp: number, sig: string, size = 0, download = ""): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const want = Buffer.from(signLocal(method, key, exp, size, download));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

const urlFor = (key: string) => `${env.appUrl}/api/dev-storage/${key.split("/").map(encodeURIComponent).join("/")}`;

export function localStorageDriver(): StorageDriver {
  return {
    async presignPut(key, sizeBytes, contentType) {
      const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
      const sig = signLocal("PUT", key, exp, sizeBytes);
      return {
        url: `${urlFor(key)}?exp=${exp}&size=${sizeBytes}&sig=${sig}`,
        method: "PUT",
        headers: { "Content-Type": contentType },
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },
    async presignGet(key, opts) {
      const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS;
      const dl = opts?.downloadName ?? "";
      const sig = signLocal("GET", key, exp, 0, dl);
      return `${urlFor(key)}?exp=${exp}&sig=${sig}${dl ? `&dl=${encodeURIComponent(dl)}` : ""}`;
    },
    async head(key) {
      try {
        return { size: (await stat(localPath(key))).size };
      } catch {
        return null;
      }
    },
    async readStart(key, n) {
      const fh = await open(localPath(key), "r");
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    },
    async remove(keys) {
      await Promise.all(keys.map((k) => rm(localPath(k), { force: true })));
    },
  };
}

export async function ensureDirFor(key: string) {
  await mkdir(path.dirname(localPath(key)), { recursive: true });
}
