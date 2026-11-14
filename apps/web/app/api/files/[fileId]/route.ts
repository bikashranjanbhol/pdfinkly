import { and, eq, isNull } from "drizzle-orm";
import { fileVersions, files, getDb, shareLinks } from "@pdfinkly/db";
import { RenameFileBody } from "@pdfinkly/shared";
import { requireActor } from "@/lib/server/actor";
import { cleanName, getOwnedFile, hasDraft, listVersions, toSummary } from "@/lib/server/files";
import { handle, noContent, ok, parseBody, uuidParam } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";

type Ctx = { params: Promise<{ fileId: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const [current] = file.currentVersionId
    ? await getDb().select().from(fileVersions).where(eq(fileVersions.id, file.currentVersionId)).limit(1)
    : [];
  return ok({
    file: toSummary(file, current ?? null, await hasDraft(file.id, actor.user.id)),
    currentVersion: current ? { id: current.id, versionNo: current.versionNo, pageCount: current.pageCount } : null,
    viewUrl: current ? await storage().presignGet(current.storageKey) : null,
    downloadUrl: current ? await storage().presignGet(current.storageKey, { downloadName: file.name }) : null,
    versions: await listVersions(file.id),
  });
});

export const PATCH = handle(async (req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const body = await parseBody(req, RenameFileBody);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const [updated] = await getDb().update(files).set({ name: cleanName(body.name) }).where(eq(files.id, file.id)).returning();
  return ok({ file: toSummary(updated!, null, false) });
});

/** Soft delete: hidden at once, bytes removed later by the cleanup job. Share links stop working. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const now = new Date();
  await getDb().transaction(async (tx) => {
    await tx.update(files).set({ deletedAt: now }).where(eq(files.id, file.id));
    await tx.update(shareLinks).set({ revokedAt: now }).where(and(eq(shareLinks.fileId, file.id), isNull(shareLinks.revokedAt)));
  });
  return noContent();
});
