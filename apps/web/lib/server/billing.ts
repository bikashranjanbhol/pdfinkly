import "server-only";
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  getDb,
  payments,
  prices,
  subscriptions,
  usageEvents,
  users,
  type Price,
  type Subscription,
} from "@pdfinkly/db";
import type { Actor } from "./actor";
import type { BillingSummary, CheckoutStart } from "@/lib/billing/types";
import { HttpError } from "./http";
import { fromUnix, razorpay, rzp, type RzpPayment, type RzpSubscription } from "./razorpay";
import {
  accessEnd,
  checkoutSignatureValid,
  mapRazorpayStatus,
  monthStart,
  nextMonthStart,
  passWindow,
  totalCount,
} from "@/lib/billing/logic";

export type Currency = "INR" | "USD";

/** Visitors in India pay in rupees; everyone else in US dollars. */
export function currencyFor(h: Headers): Currency {
  const country = h.get("x-vercel-ip-country");
  return !country || country === "IN" ? "INR" : "USD";
}

export async function listPrices(currency?: Currency): Promise<Price[]> {
  const rows = await getDb().select().from(prices).where(eq(prices.isActive, true)).orderBy(asc(prices.amountMinor));
  return currency ? rows.filter((p) => p.currency === currency) : rows;
}

async function getPrice(id: string): Promise<Price> {
  const [p] = await getDb().select().from(prices).where(and(eq(prices.id, id), eq(prices.isActive, true))).limit(1);
  if (!p) throw new HttpError("NOT_FOUND", "That price isn't available.");
  return p;
}

/** The Razorpay plan behind a recurring price, created on first use. */
async function razorpayPlanFor(price: Price): Promise<string> {
  const mode = razorpay.mode;
  const known = price.razorpayPlanIds[mode];
  if (known) return known;
  const plan = await rzp.createPlan({
    period: price.period === "year" ? "yearly" : "monthly",
    amount: price.amountMinor,
    currency: price.currency,
    name: `PDFInkly Pro (${price.period === "year" ? "yearly" : "monthly"})`,
  });
  await getDb()
    .update(prices)
    .set({ razorpayPlanIds: sql`${prices.razorpayPlanIds} || ${JSON.stringify({ [mode]: plan.id })}::jsonb` })
    .where(eq(prices.id, price.id));
  return plan.id;
}

function requireAccount(actor: Actor) {
  if (actor.isGuest || !actor.user.email) {
    throw new HttpError("UNAUTHENTICATED", "Sign in with Google to buy Pro, so it stays with your account.");
  }
}


const describe = (p: Price) =>
  p.kind === "pass" ? "Pro day pass (24 hours)" : p.period === "year" ? "Pro, billed yearly" : "Pro, billed monthly";

export async function startCheckout(actor: Actor, priceId: string): Promise<CheckoutStart> {
  requireAccount(actor);
  const price = await getPrice(priceId);
  const db = getDb();
  const userId = actor.user.id;
  const notes = { user_id: userId, price_id: price.id };
  const base = {
    keyId: razorpay.keyId,
    amount: price.amountMinor,
    currency: price.currency,
    description: describe(price),
    prefill: { name: actor.user.name ?? undefined, email: actor.user.email ?? undefined },
  };

  if (price.kind === "recurring") {
    const [live] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.kind, "recurring"),
          inArray(subscriptions.status, ["trialing", "active", "past_due"]),
        ),
      )
      .limit(1);
    if (live) throw new HttpError("ALREADY_SUBSCRIBED", "You already have a Pro subscription.");
    const sub = await rzp.createSubscription({
      planId: await razorpayPlanFor(price),
      totalCount: totalCount(price.period as "month" | "year"),
      notes,
    });
    await db.insert(subscriptions).values({
      userId,
      planId: price.planId,
      provider: "razorpay",
      providerSubscriptionId: sub.id,
      status: "incomplete",
      kind: "recurring",
      priceId: price.id,
    });
    return { ...base, kind: "subscription", id: sub.id };
  }

  const order = await rzp.createOrder({
    amount: price.amountMinor,
    currency: price.currency,
    receipt: `pass_${Date.now().toString(36)}`,
    notes,
  });
  await db.insert(subscriptions).values({
    userId,
    planId: price.planId,
    provider: "razorpay",
    providerSubscriptionId: order.id,
    status: "incomplete",
    kind: "pass",
    priceId: price.id,
  });
  return { ...base, kind: "order", id: order.id };
}

async function findSub(providerId: string): Promise<Subscription | null> {
  const [s] = await getDb()
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.provider, "razorpay"), eq(subscriptions.providerSubscriptionId, providerId)))
    .limit(1);
  return s ?? null;
}

/** Re-derive users.plan_id / plan_expires_at from all of a user's subscriptions. */
export async function recomputePlan(userId: string): Promise<void> {
  const db = getDb();
  const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const end = accessEnd(subs);
  const live = end && end > new Date();
  const planId = live ? (subs.find((s) => s.currentPeriodEnd && s.status !== "incomplete")?.planId ?? "pro") : "free";
  await db.update(users).set({ planId, planExpiresAt: end }).where(eq(users.id, userId));
}

async function recordPayment(sub: Subscription, p: { id: string; amount: number; currency: string; status?: string; at?: Date | null }) {
  const status = p.status === "failed" ? "failed" : p.status === "refunded" ? "refunded" : "succeeded";
  await getDb()
    .insert(payments)
    .values({
      userId: sub.userId,
      subscriptionId: sub.id,
      provider: "razorpay",
      providerPaymentId: p.id,
      amountMinor: p.amount,
      currency: p.currency.toUpperCase(),
      status,
      paidAt: status === "succeeded" ? (p.at ?? new Date()) : null,
      priceId: sub.priceId,
    })
    .onConflictDoUpdate({
      target: [payments.provider, payments.providerPaymentId],
      set: { status, ...(status === "succeeded" ? {} : { paidAt: null }) },
    });
}

/** Apply Razorpay's view of a subscription to our row. */
export async function applySubscription(remote: RzpSubscription, payment?: RzpPayment | null): Promise<Subscription | null> {
  const sub = await findSub(remote.id);
  if (!sub || sub.kind !== "recurring") return null;
  const status = mapRazorpayStatus(remote.status);
  const start = fromUnix(remote.current_start);
  const end = fromUnix(remote.current_end);
  const [row] = await getDb()
    .update(subscriptions)
    .set({
      status: status === "incomplete" && sub.status !== "incomplete" ? sub.status : status,
      providerCustomerId: remote.customer_id ?? sub.providerCustomerId,
      currentPeriodStart: start ?? sub.currentPeriodStart,
      currentPeriodEnd: end ?? sub.currentPeriodEnd,
    })
    .where(eq(subscriptions.id, sub.id))
    .returning();
  if (payment) await recordPayment(row!, { ...payment, at: fromUnix(payment.created_at) });
  await recomputePlan(sub.userId);
  return row!;
}

/** A paid day pass: 24 hours, starting after any pass still running. */
export async function activatePass(orderId: string, payment: { id: string; amount: number; currency: string; at?: Date | null }) {
  const sub = await findSub(orderId);
  if (!sub || sub.kind !== "pass") return null;
  await recordPayment(sub, payment);
  if (sub.status === "active") return sub; // already done (webhook and browser both report it)
  const db = getDb();
  const [latest] = await db
    .select({ end: sql<Date | null>`max(${subscriptions.currentPeriodEnd})` })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, sub.userId), eq(subscriptions.kind, "pass"), eq(subscriptions.status, "active")));
  const latestEnd = latest?.end ? new Date(latest.end) : null;
  const { start, end } = passWindow(latestEnd);
  const [row] = await db
    .update(subscriptions)
    .set({ status: "active", currentPeriodStart: start, currentPeriodEnd: end })
    .where(and(eq(subscriptions.id, sub.id), eq(subscriptions.status, "incomplete")))
    .returning();
  await recomputePlan(sub.userId);
  return row ?? sub;
}

/** The browser's report that Checkout succeeded; trusted only with a valid signature. */
export async function confirmCheckout(
  actor: Actor,
  p: { kind: "order" | "subscription"; id: string; paymentId: string; signature: string },
) {
  const sub = await findSub(p.id);
  if (!sub || sub.userId !== actor.user.id) throw new HttpError("NOT_FOUND", "We couldn't find that checkout.");
  if (!checkoutSignatureValid(razorpay.keySecret, p)) {
    throw new HttpError("PAYMENT_INVALID", "We couldn't confirm that payment. If you were charged, it will be refunded.");
  }
  const price = sub.priceId ? await getPrice(sub.priceId) : null;
  if (p.kind === "order") {
    await activatePass(p.id, { id: p.paymentId, amount: price?.amountMinor ?? 0, currency: price?.currency ?? "INR" });
  } else {
    const remote = await rzp.getSubscription(p.id);
    // Checkout's success means the mandate and first charge went through, even
    // if Razorpay still reports "authenticated" for a moment.
    const fixed = { ...remote, status: remote.status === "created" ? "authenticated" : remote.status };
    if (!fixed.current_end) {
      const now = Math.floor(Date.now() / 1000);
      fixed.current_start = now;
      fixed.current_end = now + (price?.period === "year" ? 365 : 30) * 86400;
    }
    await applySubscription(fixed, {
      id: p.paymentId,
      amount: price?.amountMinor ?? 0,
      currency: price?.currency ?? "INR",
      status: "captured",
    });
  }
}

export async function cancelSubscription(actor: Actor) {
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, actor.user.id),
        eq(subscriptions.kind, "recurring"),
        inArray(subscriptions.status, ["trialing", "active", "past_due"]),
      ),
    )
    .limit(1);
  if (!sub) throw new HttpError("NOT_FOUND", "You don't have a subscription to cancel.");
  if (sub.cancelAtPeriodEnd) return;
  await rzp.cancelSubscription(sub.providerSubscriptionId);
  await db.update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.id, sub.id));
  await recomputePlan(actor.user.id);
}

// ---------------------------------------------------------------------------
// Usage: browser tools that count against the Free plan's monthly allowance.
// ---------------------------------------------------------------------------

export const COUNTED_TOOLS = ["convert", "compress"] as const;
export type CountedTool = (typeof COUNTED_TOOLS)[number];

export async function jobsUsed(userId: string): Promise<number> {
  const [r] = await getDb()
    .select({ n: count() })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.kind, "job"), gte(usageEvents.occurredAt, monthStart())));
  return Number(r?.n ?? 0);
}

export async function useJob(actor: Actor, tool: CountedTool): Promise<{ used: number; limit: number | null }> {
  const limit = actor.plan.monthlyJobs;
  const used = await jobsUsed(actor.user.id);
  if (limit !== null && used >= limit) {
    throw new HttpError(
      "QUOTA_EXCEEDED",
      `You've used all ${limit} free conversions and compressions this month. Pro has no limit.`,
      { used, limit, resetsAt: nextMonthStart().toISOString() },
    );
  }
  await getDb().insert(usageEvents).values({ userId: actor.user.id, kind: "job", tool });
  return { used: used + 1, limit };
}

// ---------------------------------------------------------------------------
// What the account page and /api/me show.
// ---------------------------------------------------------------------------

export async function billingSummary(actor: Actor): Promise<BillingSummary> {
  const db = getDb();
  const { user, plan } = actor;
  const [sub] = await db
    .select({ s: subscriptions, p: prices })
    .from(subscriptions)
    .leftJoin(prices, eq(prices.id, subscriptions.priceId))
    .where(
      and(
        eq(subscriptions.userId, user.id),
        eq(subscriptions.kind, "recurring"),
        inArray(subscriptions.status, ["active", "past_due", "cancelled"]),
      ),
    )
    .orderBy(desc(subscriptions.currentPeriodEnd))
    .limit(1);
  const subLive = sub && sub.s.currentPeriodEnd && sub.s.currentPeriodEnd > new Date();
  return {
    planId: plan.id,
    planName: plan.name,
    features: plan.features,
    maxFileMb: plan.maxFileMb,
    retentionHours: plan.retentionHours,
    jobs: { used: await jobsUsed(user.id), limit: plan.monthlyJobs, resetsAt: nextMonthStart().toISOString() },
    proUntil: plan.id !== "free" && user.planExpiresAt ? user.planExpiresAt.toISOString() : null,
    subscription:
      subLive && sub.p
        ? {
            period: sub.p.period as "month" | "year",
            status: sub.s.status,
            renewsAt: sub.s.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: sub.s.cancelAtPeriodEnd || sub.s.status === "cancelled",
            amount: sub.p.amountMinor,
            currency: sub.p.currency,
          }
        : null,
    paymentsEnabled: razorpay.configured(),
  };
}

export async function paymentHistory(userId: string) {
  return getDb()
    .select({
      id: payments.id,
      amountMinor: payments.amountMinor,
      currency: payments.currency,
      status: payments.status,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
      priceId: payments.priceId,
    })
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.createdAt))
    .limit(24);
}
