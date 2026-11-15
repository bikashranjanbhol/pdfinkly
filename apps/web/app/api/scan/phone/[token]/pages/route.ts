import { z } from "zod";
import { addPage, MAX_PAGE_BYTES } from "@/lib/server/handoff";
import { handle, ok, parseBody } from "@/lib/server/http";
import { clientIp, rateLimit } from "@/lib/server/ratelimit";

type Ctx = { params: Promise<{ token: string }> };
const Body = z.object({
  width: z.number().int().min(16).max(10000),
  height: z.number().int().min(16).max(10000),
  sizeBytes: z.number().int().min(100).max(MAX_PAGE_BYTES),
});

/** Start sending one page: returns where to upload it. */
export const POST = handle(async (req: Request, ctx: Ctx) => {
  await rateLimit("scan-phone", clientIp(req), 200, 3600);
  return ok(await addPage((await ctx.params).token, await parseBody(req, Body)));
});
