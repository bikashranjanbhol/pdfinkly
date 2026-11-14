import { and, eq, sql } from "drizzle-orm";
import { editDrafts, fileVersions, files, getDb } from "@pdfinkly/db";
import { CompleteVersionBody } from "@pdfinkly/shared";
import { requireActor } from "@/lib/server/actor";
import { assertSize, getOwnedFile, toSummary, toVersionInfo } from "@/lib/server/files";
import { HttpError, handle, ok, parseBody, uuidParam } from "@/lib/server/http";
import { storage, versionKey } from "@/lib/server/storage";

type Ctx = { params: Promise<{ fileId: string; versionId: string }> };

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
function hasPdfMagic(bytes: Uint8Array): boolean {
  // The spec allows a little junk before the header; look in the first 1 KB.
  outer: for (let i = 0; i + PDF_MAGIC.length <= bytes.length; i++) {
    for (let j = 0; j < PDF_MAGIC.length; j++) if (bytes[i + j] !== PDF_MAGIC[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The only route that creates a file_versions row. Checks the uploaded object,
 * then in one transaction numbers the version, makes it current, and (for an
 * editor save) clears the draft whose edits are now inside the PDF.
 */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const p = await ctx.params;
  const fileId = uuidParam(p.fileId);
  const versionId = uuidParam(p.versionId);
  const body = await parseBody(req, CompleteVersionBody);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const db = getDb();

  // Idempotent: completing twice returns the same version.
  const [existing] = await db.select().from(fileVersions).where(eq(fileVersions.id, versionId)).limit(1);
  if (existing) {
    if (existing.fileId !== file.id) throw new HttpError("NOT_FOUND", "Version not found.");
    return ok({ version: toVersionInfo(existing), file: toSummary(file, existing, false) });
  }

  const key = versionKey(file.ownerId, file.id, versionId);
  const store = storage();
  const head = await store.head(key);
  if (!head) throw new HttpError("UPLOAD_MISSING", "The upload didn't arrive. Please try again.");
  try {
    assertSize(actor.plan, head.size);
  } catch (e) {
    await store.remove([key]);
    throw e;
  }
  if (!hasPdfMagic(await store.readStart(key, 1024))) {
    await store.remove([key]);
    if (!file.currentVersionId) await db.update(files).set({ status: "failed" }).where(eq(files.id, file.id));
    throw new HttpError("INVALID_PDF", "That file isn't a PDF.");
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM files WHERE id = ${file.id} FOR UPDATE`);
    const [{ next }] = (await tx.execute(
      sql`SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM file_versions WHERE file_id = ${file.id}`,
    )) as unknown as [{ next: number }];
    const [version] = await tx
      .insert(fileVersions)
      .values({
        id: versionId,
        fileId: file.id,
        versionNo: Number(next),
        source: body.source,
        storageKey: key,
        sizeBytes: head.size,
        sha256: body.sha256 ?? null,
        pageCount: body.pageCount,
        createdBy: actor.user.id,
      })
      .returning();
    const [updated] = await tx
      .update(files)
      .set({ currentVersionId: version!.id, status: "ready" })
      .where(eq(files.id, file.id))
      .returning();
    if (body.source === "edit") {
      await tx.delete(editDrafts).where(and(eq(editDrafts.fileId, file.id), eq(editDrafts.userId, actor.user.id)));
    }
    return { version: version!, file: updated! };
  });

  return ok({ version: toVersionInfo(result.version), file: toSummary(result.file, result.version, false) });
});
