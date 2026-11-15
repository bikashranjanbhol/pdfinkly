import { requireActor } from "@/lib/server/actor";
import { closeHandoff, handoffStatus } from "@/lib/server/handoff";
import { handle, noContent, ok } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Is the phone connected, and which pages are ready to pick up. */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const actor = await requireActor();
  return ok(await handoffStatus(actor, (await ctx.params).id), { headers: { "cache-control": "no-store" } });
});

/** Stop: the link stops working and pages not picked up are deleted. */
export const DELETE = handle(async (_req: Request, ctx: Ctx) => {
  const actor = await requireActor();
  await closeHandoff(actor, (await ctx.params).id);
  return noContent();
});
