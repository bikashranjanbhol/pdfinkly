import { and, eq } from "drizzle-orm";
import { editDrafts, files, getDb } from "@pdfinkly/db";
import { RestoreBody } from "@pdfinkly/shared";
import { requireActor } from "@/lib/server/actor";
import { getOwnedFile, getVersion, toSummary } from "@/lib/server/files";
import { handle, ok, parseBody, uuidParam } from "@/lib/server/http";

type Ctx = { params: Promise<{ fileId: string }> };

/** Make an older version current again. Nothing is deleted; any open draft is discarded. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const body = await parseBody(req, RestoreBody);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const v = await getVersion(file.id, body.versionId);
  const updated = await getDb().transaction(async (tx) => {
    await tx.delete(editDrafts).where(and(eq(editDrafts.fileId, file.id), eq(editDrafts.userId, actor.user.id)));
    const [f] = await tx.update(files).set({ currentVersionId: v.id }).where(eq(files.id, file.id)).returning();
    return f!;
  });
  return ok({ file: toSummary(updated, v, false) });
});
