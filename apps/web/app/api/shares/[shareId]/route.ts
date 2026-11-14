import { and, eq, isNull } from "drizzle-orm";
import { getDb, shareLinks } from "@pdfinkly/db";
import { requireActor } from "@/lib/server/actor";
import { HttpError, handle, noContent, uuidParam } from "@/lib/server/http";

type Ctx = { params: Promise<{ shareId: string }> };

/** Revoke a link. The row stays (as revoked) so the history is visible. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const shareId = uuidParam((await ctx.params).shareId);
  const actor = await requireActor();
  const [row] = await getDb()
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, shareId), eq(shareLinks.createdBy, actor.user.id), isNull(shareLinks.revokedAt)))
    .returning({ id: shareLinks.id });
  if (!row) throw new HttpError("NOT_FOUND", "Link not found.");
  return noContent();
});
