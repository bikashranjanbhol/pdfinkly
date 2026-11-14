import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb, shareLinks } from "@pdfinkly/db";
import { CreateShareBody } from "@pdfinkly/shared";
import { requireActor } from "@/lib/server/actor";
import { env } from "@/lib/server/env";
import { getOwnedFile } from "@/lib/server/files";
import { HttpError, handle, ok, parseBody, uuidParam } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/ratelimit";
import { hashToken } from "@/lib/server/shares";

type Ctx = { params: Promise<{ fileId: string }> };

export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const actor = await requireActor();
  const file = await getOwnedFile(actor, fileId);
  const rows = await getDb().select().from(shareLinks).where(eq(shareLinks.fileId, file.id)).orderBy(desc(shareLinks.createdAt));
  return ok({
    items: rows.map((s) => ({
      id: s.id,
      permission: s.permission,
      hint: s.tokenHash.slice(-4),
      expiresAt: s.expiresAt?.toISOString() ?? null,
      revokedAt: s.revokedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

/** Create a link. The raw token is returned once; only its hash is stored. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const body = await parseBody(req, CreateShareBody);
  const actor = await requireActor();
  if (actor.isGuest) throw new HttpError("UNAUTHENTICATED", "Sign in to share files.");
  await rateLimit("share", actor.user.id, 60, 3600);
  const file = await getOwnedFile(actor, fileId);
  if (!file.currentVersionId) throw new HttpError("NOT_FOUND", "Upload the file before sharing it.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null;
  const [row] = await getDb()
    .insert(shareLinks)
    .values({ fileId: file.id, createdBy: actor.user.id, tokenHash: hashToken(token), permission: body.permission, expiresAt })
    .returning();
  return ok({ shareId: row!.id, url: `${env.appUrl}/s/${token}`, expiresAt: expiresAt?.toISOString() ?? null }, 201);
});
