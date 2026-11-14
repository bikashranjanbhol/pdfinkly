import { requireActor } from "@/lib/server/actor";
import { getOwnedFile, getVersion, toVersionInfo } from "@/lib/server/files";
import { handle, ok, uuidParam } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";

type Ctx = { params: Promise<{ fileId: string; versionId: string }> };

/** Signed URLs for one version: preview in history, download, or merge into another file. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const p = await ctx.params;
  const actor = await requireActor();
  const file = await getOwnedFile(actor, uuidParam(p.fileId));
  const v = await getVersion(file.id, uuidParam(p.versionId));
  const base = file.name.replace(/\.pdf$/i, "");
  return ok({
    version: toVersionInfo(v),
    viewUrl: await storage().presignGet(v.storageKey),
    downloadUrl: await storage().presignGet(v.storageKey, { downloadName: `${base} (v${v.versionNo}).pdf` }),
  });
});
