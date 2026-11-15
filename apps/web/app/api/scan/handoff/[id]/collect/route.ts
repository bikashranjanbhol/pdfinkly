import { z } from "zod";
import { requireActor } from "@/lib/server/actor";
import { collectPages } from "@/lib/server/handoff";
import { handle, noContent, parseBody } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ pageIds: z.array(z.string().uuid()).max(100) });

/** The computer has these pages: delete them from storage. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  const actor = await requireActor();
  const { pageIds } = await parseBody(req, Body);
  await collectPages(actor, (await ctx.params).id, pageIds);
  return noContent();
});
