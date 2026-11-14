import { and, eq } from "drizzle-orm";
import { editDrafts, getDb } from "@pdfinkly/db";
import { SaveDraftBody } from "@pdfinkly/shared";
import { requireActor } from "@/lib/server/actor";
import { getOwnedFile, getVersion } from "@/lib/server/files";
import { HttpError, handle, noContent, ok, parseBody, uuidParam } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/ratelimit";

type Ctx = { params: Promise<{ fileId: string }> };

async function load(fileId: string, userId: string) {
  const [d] = await getDb()
    .select()
    .from(editDrafts)
    .where(and(eq(editDrafts.fileId, fileId), eq(editDrafts.userId, userId)))
    .limit(1);
  return d ?? null;
}

const view = (d: NonNullable<Awaited<ReturnType<typeof load>>>) => ({
  baseVersionId: d.baseVersionId,
  operations: d.operations,
  revision: d.revision,
  updatedAt: d.updatedAt.toISOString(),
});

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const d = await load(file.id, actor.user.id);
  return d ? ok(view(d)) : noContent();
});

/**
 * Autosave with optimistic locking: the client sends the revision it last saw.
 * A stale tab gets 409 with the server copy instead of overwriting newer edits.
 */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const body = await parseBody(req, SaveDraftBody);
  const actor = await requireActor();
  await rateLimit("draft", actor.user.id, 600, 3600);
  const file = await getOwnedFile(actor, fileId);
  await getVersion(file.id, body.baseVersionId);
  const db = getDb();
  const current = await load(file.id, actor.user.id);

  if (!current) {
    if (body.revision !== 0) {
      throw new HttpError("DRAFT_CONFLICT", "This draft was saved or discarded in another tab.", { server: null });
    }
    const [created] = await db
      .insert(editDrafts)
      .values({ fileId: file.id, userId: actor.user.id, baseVersionId: body.baseVersionId, operations: body.operations, revision: 1 })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const now = await load(file.id, actor.user.id);
      throw new HttpError("DRAFT_CONFLICT", "This file was edited in another tab.", { server: now ? view(now) : null });
    }
    return ok({ revision: created.revision }, 201);
  }

  const [updated] = await db
    .update(editDrafts)
    .set({ baseVersionId: body.baseVersionId, operations: body.operations, revision: current.revision + 1 })
    .where(and(eq(editDrafts.id, current.id), eq(editDrafts.revision, body.revision)))
    .returning();
  if (!updated) {
    throw new HttpError("DRAFT_CONFLICT", "This file was edited in another tab.", { server: view(current) });
  }
  return ok({ revision: updated.revision });
});

export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  await getDb().delete(editDrafts).where(and(eq(editDrafts.fileId, file.id), eq(editDrafts.userId, actor.user.id)));
  return noContent();
});
