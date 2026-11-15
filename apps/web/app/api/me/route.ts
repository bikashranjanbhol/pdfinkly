import { eq } from "drizzle-orm";
import { getDb, users } from "@pdfinkly/db";
import { getActor } from "@/lib/server/actor";
import { billingSummary, cancelSubscription } from "@/lib/server/billing";
import { handle, noContent, ok } from "@/lib/server/http";

export const GET = handle(async () => {
  const actor = await getActor();
  if (!actor) return ok({ user: null });
  const { user, plan, isGuest } = actor;
  return ok({
    user: { id: user.id, name: user.name, email: user.email, image: user.image, isGuest },
    plan: { id: plan.id, name: plan.name, maxFileMb: plan.maxFileMb, retentionHours: plan.retentionHours },
    billing: await billingSummary(actor),
  });
});

/** Soft-delete the account; its files are hidden now and removed by the cleanup job. */
export const DELETE = handle(async () => {
  const actor = await getActor();
  if (!actor || actor.isGuest) return noContent();
  // Stop future charges; a missing subscription is fine.
  await cancelSubscription(actor).catch(() => {});
  await getDb().update(users).set({ deletedAt: new Date() }).where(eq(users.id, actor.user.id));
  const { signOut } = await import("@/lib/server/auth");
  await signOut({ redirect: false });
  return noContent();
});
