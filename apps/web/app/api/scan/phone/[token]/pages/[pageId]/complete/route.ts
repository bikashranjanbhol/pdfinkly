import { completePage } from "@/lib/server/handoff";
import { handle, ok } from "@/lib/server/http";

type Ctx = { params: Promise<{ token: string; pageId: string }> };

/** The page is uploaded: check it and make it visible to the computer. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const { token, pageId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(pageId)) return ok({ ok: false }, 404);
  return ok(await completePage(token, pageId));
});
