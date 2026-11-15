import { requireActor } from "@/lib/server/actor";
import { billingSummary, cancelSubscription } from "@/lib/server/billing";
import { handle, ok } from "@/lib/server/http";

/** Stop renewing; Pro stays until the end of the period already paid for. */
export const POST = handle(async () => {
  const actor = await requireActor();
  await cancelSubscription(actor);
  return ok(await billingSummary(await requireActor()));
});
