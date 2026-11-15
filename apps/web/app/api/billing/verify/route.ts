import { z } from "zod";
import { requireActor } from "@/lib/server/actor";
import { billingSummary, confirmCheckout } from "@/lib/server/billing";
import { handle, ok, parseBody } from "@/lib/server/http";

const Body = z.object({
  kind: z.enum(["order", "subscription"]),
  id: z.string().min(1).max(64),
  paymentId: z.string().min(1).max(64),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Checkout succeeded in the browser: check Razorpay's signature and switch Pro on. */
export const POST = handle(async (req: Request) => {
  const actor = await requireActor();
  await confirmCheckout(actor, await parseBody(req, Body));
  const fresh = await requireActor();
  return ok(await billingSummary(fresh));
});
