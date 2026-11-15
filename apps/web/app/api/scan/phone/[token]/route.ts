import { touchFromPhone } from "@/lib/server/handoff";
import { handle, ok } from "@/lib/server/http";

type Ctx = { params: Promise<{ token: string }> };

/** The phone opened the link: tells the computer it's connected. */
export const POST = handle(async (_req: Request, ctx: Ctx) => {
  const h = await touchFromPhone((await ctx.params).token);
  return ok({ expiresAt: h.expiresAt.toISOString() });
});
