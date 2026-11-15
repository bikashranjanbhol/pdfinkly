import { ensureActor } from "@/lib/server/actor";
import { createHandoff } from "@/lib/server/handoff";
import { handle, ok } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/ratelimit";

/** A one-time link (shown as a QR code) for scanning with a phone. */
export const POST = handle(async () => {
  const actor = await ensureActor();
  await rateLimit("scan-handoff", actor.user.id, 30, 3600);
  return ok(await createHandoff(actor));
});
