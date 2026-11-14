import { randomUUID } from "node:crypto";
import { CreateVersionBody } from "@pdfinkly/shared";
import { requireActor } from "@/lib/server/actor";
import { assertSize, getOwnedFile, getVersion } from "@/lib/server/files";
import { handle, ok, parseBody, uuidParam } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/ratelimit";
import { storage, versionKey } from "@/lib/server/storage";

type Ctx = { params: Promise<{ fileId: string }> };

/** Start uploading a new version (e.g. the editor's exported PDF). */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const fileId = uuidParam((await ctx.params).fileId);
  const body = await parseBody(req, CreateVersionBody);
  const actor = await requireActor();
  await rateLimit("create-version", actor.user.id, 120, 3600);
  const file = await getOwnedFile(actor, fileId);
  if (body.baseVersionId) await getVersion(file.id, body.baseVersionId);
  assertSize(actor.plan, body.sizeBytes);
  const versionId = randomUUID();
  const upload = await storage().presignPut(versionKey(file.ownerId, file.id, versionId), body.sizeBytes, "application/pdf");
  return ok({ versionId, upload }, 201);
});
