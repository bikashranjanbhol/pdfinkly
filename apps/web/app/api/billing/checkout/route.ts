import { z } from "zod";
import { requireActor } from "@/lib/server/actor";
import { startCheckout } from "@/lib/server/billing";
import { handle, ok, parseBody } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/ratelimit";

const Body = z.object({ priceId: z.string().min(1).max(64) });

/** Start a Razorpay Checkout: a subscription (Pro monthly/yearly) or an order (day pass). */
export const POST = handle(async (req: Request) => {
  const actor = await requireActor();
  await rateLimit("checkout", actor.user.id, 20, 3600);
  const { priceId } = await parseBody(req, Body);
  return ok(await startCheckout(actor, priceId));
});
