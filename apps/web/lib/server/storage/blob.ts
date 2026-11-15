import "server-only";
import { del, get, head, issueSignedToken, presignUrl, BlobNotFoundError, type IssuedSignedToken } from "@vercel/blob";
import { DOWNLOAD_TTL_SECONDS, UPLOAD_TTL_SECONDS, type StorageDriver } from "./types";

/**
 * Vercel Blob (private store). The browser never gets a store credential:
 * the server signs one URL per operation (PUT to upload, GET to read), each
 * scoped to one pathname and a few minutes.
 *
 * Auth: when the store is connected to the Vercel project, the SDK uses OIDC
 * (BLOB_STORE_ID + VERCEL_OIDC_TOKEN, injected by Vercel). BLOB_READ_WRITE_TOKEN
 * also works, e.g. for local development.
 */

// Must match the SDK's API version so the presigned PUT is accepted.
const BLOB_API_VERSION = "13";

// issueSignedToken() is a network call; reuse one whole-store token until it's
// close to expiry. Its signing key never leaves the server — only the HMAC'd
// URLs do, and each of those is limited to one pathname, method and expiry.
let cached: IssuedSignedToken | undefined;
async function signingToken(): Promise<IssuedSignedToken> {
  const now = Date.now();
  if (cached && cached.validUntil - now > 15 * 60 * 1000) return cached;
  cached = await issueSignedToken({ pathname: "*", operations: ["get", "put"], validUntil: now + 60 * 60 * 1000 });
  return cached;
}

export function blobStorageDriver(): StorageDriver {
  return {
    async presignPut(key, sizeBytes, contentType) {
      const expires = Date.now() + UPLOAD_TTL_SECONDS * 1000;
      const { presignedUrl } = await presignUrl(await signingToken(), {
        operation: "put",
        access: "private",
        pathname: key,
        validUntil: expires,
        allowedContentTypes: ["application/pdf"],
        maximumSizeInBytes: sizeBytes,
        addRandomSuffix: false,
        // Keys are unique per version; overwrite only happens when a failed upload is retried.
        allowOverwrite: true,
      });
      return {
        url: presignedUrl,
        method: "PUT",
        // Only headers the Blob API lists in Access-Control-Allow-Headers: anything else
        // fails the browser's CORS preflight (it surfaced as "Network error during upload").
        // addRandomSuffix / allowOverwrite are already signed into the URL's query string.
        headers: {
          "x-api-version": BLOB_API_VERSION,
          "x-vercel-blob-access": "private",
          "x-content-type": contentType,
        },
        expiresAt: new Date(expires).toISOString(),
      };
    },

    async presignGet(key) {
      // Filenames for downloads are applied in the browser (see lib/client saveAs),
      // because Blob can't set Content-Disposition per signed URL.
      const { presignedUrl } = await presignUrl(await signingToken(), {
        operation: "get",
        access: "private",
        pathname: key,
        validUntil: Date.now() + DOWNLOAD_TTL_SECONDS * 1000,
      });
      return presignedUrl;
    },

    async head(key) {
      try {
        const h = await head(key);
        return { size: h.size };
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },

    async readStart(key, n) {
      const res = await get(key, { access: "private", useCache: false, headers: { range: `bytes=0-${n - 1}` } });
      if (!res || res.statusCode !== 200) return new Uint8Array();
      const reader = res.stream.getReader();
      const out = new Uint8Array(n);
      let filled = 0;
      try {
        while (filled < n) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          const take = Math.min(value.length, n - filled);
          out.set(value.subarray(0, take), filled);
          filled += take;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return out.subarray(0, filled);
    },

    async remove(keys) {
      // del() accepts many pathnames per call; keep batches modest.
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        if (batch.length) await del(batch);
      }
    },
  };
}
