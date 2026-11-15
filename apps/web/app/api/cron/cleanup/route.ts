import { timingSafeEqual } from "node:crypto";
import { and, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { fileVersions, files, getDb } from "@pdfinkly/db";
import { storage } from "@/lib/server/storage";
import { removeStaleHandoffs } from "@/lib/server/handoff";

/**
 * Deletes expired files and files soft-deleted more than a day ago: storage
 * objects first, then rows. Runs daily via Vercel Cron (vercel.json; Hobby allows
 * one run a day — reads already hide expired files via liveFile()), which
 * sends `Authorization: Bearer $CRON_SECRET`.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const db = getDb();
  const dayAgo = new Date(Date.now() - 86400_000);
  let removedFiles = 0;
  let removedObjects = 0;

  for (let round = 0; round < 20; round++) {
    const batch = await db
      .select({ id: files.id })
      .from(files)
      .where(
        or(
          and(isNotNull(files.expiresAt), lt(files.expiresAt, new Date())),
          and(isNotNull(files.deletedAt), lt(files.deletedAt, dayAgo)),
          // Uploads that never completed.
          and(sql`${files.status} = 'uploading'`, lt(files.createdAt, dayAgo)),
        ),
      )
      .limit(500);
    if (batch.length === 0) break;
    const ids = batch.map((b) => b.id);
    const keys = (await db.select({ key: fileVersions.storageKey }).from(fileVersions).where(inArray(fileVersions.fileId, ids))).map(
      (r) => r.key,
    );
    await storage().remove(keys);
    await db.delete(files).where(inArray(files.id, ids));
    removedFiles += ids.length;
    removedObjects += keys.length;
  }

  // Phone-scan links past their hour, and any pages the computer never picked up.
  const removedHandoffs = await removeStaleHandoffs();

  return Response.json({ removedFiles, removedObjects, removedHandoffs });
}
