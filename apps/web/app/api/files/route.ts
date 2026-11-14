import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { editDrafts, fileVersions, files, getDb } from "@pdfinkly/db";
import { CreateFileBody } from "@pdfinkly/shared";
import { ensureActor, getActor } from "@/lib/server/actor";
import { assertSize, cleanName, expiryFor, toSummary } from "@/lib/server/files";
import { handle, ok, parseBody } from "@/lib/server/http";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";
import { storage, versionKey } from "@/lib/server/storage";

/** List my files, most recently changed first. */
export const GET = handle(async () => {
  const actor = await getActor();
  if (!actor) return ok({ items: [] });
  const db = getDb();
  const rows = await db
    .select()
    .from(files)
    .where(and(eq(files.ownerId, actor.user.id), isNull(files.deletedAt)))
    .orderBy(desc(files.updatedAt))
    .limit(200);
  const versionIds = rows.flatMap((f) => (f.currentVersionId ? [f.currentVersionId] : []));
  const versions = versionIds.length
    ? await db.select().from(fileVersions).where(inArray(fileVersions.id, versionIds))
    : [];
  const drafts = rows.length
    ? await db
        .select({ fileId: editDrafts.fileId })
        .from(editDrafts)
        .where(and(eq(editDrafts.userId, actor.user.id), inArray(editDrafts.fileId, rows.map((f) => f.id))))
    : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const withDraft = new Set(drafts.map((d) => d.fileId));
  return ok({
    items: rows
      .filter((f) => f.status !== "uploading")
      .map((f) => toSummary(f, f.currentVersionId ? byId.get(f.currentVersionId) ?? null : null, withDraft.has(f.id))),
  });
});

/** Start an upload: create the file record and hand back a signed PUT URL. */
export const POST = handle(async (req: Request) => {
  await rateLimit("create-file", clientIp(req), 60, 3600);
  const body = await parseBody(req, CreateFileBody);
  const actor = await ensureActor();
  assertSize(actor.plan, body.sizeBytes);

  const [file] = await getDb()
    .insert(files)
    .values({ ownerId: actor.user.id, name: cleanName(body.name), status: "uploading", expiresAt: expiryFor(actor.plan) })
    .returning();
  const versionId = randomUUID();
  const upload = await storage().presignPut(versionKey(actor.user.id, file!.id, versionId), body.sizeBytes, "application/pdf");
  return ok({ fileId: file!.id, versionId, upload }, 201);
});
