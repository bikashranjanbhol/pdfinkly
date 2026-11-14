import "server-only";
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DOWNLOAD_TTL_SECONDS, UPLOAD_TTL_SECONDS, dispositionName, type StorageDriver } from "./types";

/**
 * S3-compatible storage: Cloudflare R2 (recommended), AWS S3 or MinIO.
 * The bucket stays private; the browser only ever gets presigned URLs.
 */
let client: S3Client | undefined;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: process.env.S3_REGION ?? "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
      },
    });
  }
  return client;
}
const bucket = () => {
  const b = process.env.S3_BUCKET;
  if (!b) throw new Error("S3_BUCKET is not set");
  return b;
};

export function s3StorageDriver(): StorageDriver {
  return {
    async presignPut(key, sizeBytes, contentType) {
      const url = await getSignedUrl(
        s3(),
        new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType, ContentLength: sizeBytes }),
        { expiresIn: UPLOAD_TTL_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) },
      );
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": contentType },
        expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
      };
    },
    async presignGet(key, opts) {
      return getSignedUrl(
        s3(),
        new GetObjectCommand({
          Bucket: bucket(),
          Key: key,
          ...(opts?.downloadName ? { ResponseContentDisposition: dispositionName(opts.downloadName) } : {}),
        }),
        { expiresIn: DOWNLOAD_TTL_SECONDS },
      );
    },
    async head(key) {
      try {
        const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
        return { size: Number(r.ContentLength ?? 0) };
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (e as Error).name === "NotFound") return null;
        throw e;
      }
    },
    async readStart(key, n) {
      const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${n - 1}` }));
      return new Uint8Array(await r.Body!.transformToByteArray());
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        if (batch.length === 0) continue;
        await s3().send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      }
    },
  };
}
