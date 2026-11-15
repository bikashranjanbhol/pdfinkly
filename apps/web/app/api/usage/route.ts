import { z } from "zod";
import { ensureActor } from "@/lib/server/actor";
import { COUNTED_TOOLS, useJob } from "@/lib/server/billing";
import { handle, ok, parseBody } from "@/lib/server/http";

const Body = z.object({ tool: z.enum(COUNTED_TOOLS) });

/** Count one conversion/compression against the plan's monthly allowance (402 when it's used up). */
export const POST = handle(async (req: Request) => {
  const actor = await ensureActor();
  const { tool } = await parseBody(req, Body);
  return ok(await useJob(actor, tool));
});
