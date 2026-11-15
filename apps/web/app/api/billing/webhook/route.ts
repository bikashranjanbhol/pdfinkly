import { and, eq } from "drizzle-orm";
import { getDb, payments, subscriptions, webhookEvents } from "@pdfinkly/db";
import { activatePass, applySubscription, recomputePlan } from "@/lib/server/billing";
import { fromUnix, razorpay, type RzpPayment, type RzpSubscription } from "@/lib/server/razorpay";
import { webhookSignatureValid } from "@/lib/billing/logic";

interface RzpEvent {
  event: string;
  payload: {
    subscription?: { entity: RzpSubscription };
    payment?: { entity: RzpPayment };
    refund?: { entity: { id: string; payment_id: string } };
  };
}

/**
 * Razorpay webhooks: renewals, failed charges, cancellations, and day passes
 * whose browser tab closed before it could report back. Idempotent on the
 * event id; always answers 200 once the signature checks out, so Razorpay
 * doesn't retry an event we have recorded (errors are kept on the row).
 */
export async function POST(req: Request) {
  const secret = razorpay.webhookSecret;
  if (!secret) return new Response("webhook secret not set", { status: 503 });
  const raw = await req.text();
  const sig = req.headers.get("x-razorpay-signature") ?? "";
  if (!webhookSignatureValid(secret, raw, sig)) return new Response("bad signature", { status: 400 });

  let evt: RzpEvent;
  try {
    evt = JSON.parse(raw) as RzpEvent;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const db = getDb();
  const eventId = req.headers.get("x-razorpay-event-id") ?? `${evt.event}:${raw.length}:${sig.slice(0, 16)}`;
  const [row] = await db
    .insert(webhookEvents)
    .values({ provider: "razorpay", eventId, eventType: evt.event, payload: evt })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (!row) return Response.json({ ok: true, duplicate: true });

  try {
    await handleEvent(evt);
    await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, row.id));
  } catch (e) {
    console.error("[webhook]", evt.event, e);
    await db.update(webhookEvents).set({ error: String((e as Error)?.message ?? e) }).where(eq(webhookEvents.id, row.id));
  }
  return Response.json({ ok: true });
}

async function handleEvent(evt: RzpEvent) {
  const sub = evt.payload.subscription?.entity;
  const pay = evt.payload.payment?.entity;
  if (evt.event.startsWith("subscription.") && sub) {
    await applySubscription(sub, pay && pay.status === "captured" ? pay : null);
    return;
  }
  if (evt.event === "payment.captured" && pay?.order_id && !pay.invoice_id) {
    await activatePass(pay.order_id, { ...pay, at: fromUnix(pay.created_at) });
    return;
  }
  if (evt.event.startsWith("refund.") && evt.payload.refund) {
    const db = getDb();
    const [p] = await db
      .update(payments)
      .set({ status: "refunded" })
      .where(and(eq(payments.provider, "razorpay"), eq(payments.providerPaymentId, evt.payload.refund.entity.payment_id)))
      .returning();
    if (p?.subscriptionId) {
      // A refunded day pass ends now; a refunded renewal is handled by the cancellation that goes with it.
      await db
        .update(subscriptions)
        .set({ status: "expired", currentPeriodEnd: new Date() })
        .where(and(eq(subscriptions.id, p.subscriptionId), eq(subscriptions.kind, "pass")));
      await recomputePlan(p.userId);
    }
  }
}
