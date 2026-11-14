import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { env } from "@/lib/server/env";
import { dispositionName } from "@/lib/server/storage";
import { ensureDirFor, localPath, verifyLocal } from "@/lib/server/storage/local";

/**
 * Stand-in for presigned S3 URLs when STORAGE_DRIVER=local (development only).
 * Every request must carry a valid, unexpired HMAC signature.
 */
type Ctx = { params: Promise<{ key: string[] }> };

const deny = (status: number, message: string) => new Response(message, { status });
const keyOf = async (ctx: Ctx) => (await ctx.params).key.map(decodeURIComponent).join("/");

export async function PUT(req: Request, ctx: Ctx) {
  if (env.storageDriver !== "local") return deny(404, "Not found");
  const key = await keyOf(ctx);
  const u = new URL(req.url);
  const exp = Number(u.searchParams.get("exp"));
  const size = Number(u.searchParams.get("size"));
  if (!verifyLocal("PUT", key, exp, u.searchParams.get("sig") ?? "", size)) return deny(403, "Bad or expired signature");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength !== size) return deny(400, "Size does not match the signed size");
  await ensureDirFor(key);
  await writeFile(localPath(key), bytes);
  return new Response(null, { status: 200 });
}

export async function GET(req: Request, ctx: Ctx) {
  if (env.storageDriver !== "local") return deny(404, "Not found");
  const key = await keyOf(ctx);
  const u = new URL(req.url);
  const dl = u.searchParams.get("dl") ?? "";
  if (!verifyLocal("GET", key, Number(u.searchParams.get("exp")), u.searchParams.get("sig") ?? "", 0, dl)) {
    return deny(403, "Bad or expired signature");
  }
  const p = localPath(key);
  let size: number;
  try {
    size = (await stat(p)).size;
  } catch {
    return deny(404, "Not found");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Length": String(size),
    "Cache-Control": "private, max-age=60",
  };
  if (dl) headers["Content-Disposition"] = dispositionName(dl);
  return new Response(Readable.toWeb(createReadStream(p)) as ReadableStream, { headers });
}
