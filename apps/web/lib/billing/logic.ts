/**
 * Billing rules with no I/O, so they can be unit-tested: how Razorpay's
 * subscription states map to ours, how long a user's Pro lasts, signatures.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SubStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired" | "incomplete";

/** Days of Pro kept after a renewal is due, while Razorpay retries the charge. */
export const GRACE_DAYS = 3;
const DAY = 24 * 3600 * 1000;

/** Razorpay subscription states → ours. */
export function mapRazorpayStatus(s: string): SubStatus {
  switch (s) {
    case "authenticated":
    case "active":
    case "resumed":
      return "active";
    case "pending":
    case "halted":
      return "past_due";
    case "cancelled":
      return "cancelled";
    case "completed":
    case "expired":
      return "expired";
    case "paused":
      return "cancelled";
    default:
      return "incomplete"; // created
  }
}

export interface SubFacts {
  kind: "recurring" | "pass";
  status: SubStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** When the paid access these subscriptions give runs out (null: none). */
export function accessEnd(subs: SubFacts[]): Date | null {
  let end: number | null = null;
  for (const s of subs) {
    if (!s.currentPeriodEnd) continue;
    const t = s.currentPeriodEnd.getTime();
    let until: number | null = null;
    if (s.kind === "pass") until = s.status === "active" ? t : null;
    else if (s.status === "active") until = s.cancelAtPeriodEnd ? t : t + GRACE_DAYS * DAY;
    else if (s.status === "past_due") until = t + GRACE_DAYS * DAY;
    else if (s.status === "cancelled") until = t; // paid-for time is kept
    if (until !== null && (end === null || until > end)) end = until;
  }
  return end === null ? null : new Date(end);
}

/** The plan a user is on right now. */
export function effectivePlanId(planId: string, planExpiresAt: Date | null, now = new Date()): string {
  if (planId === "free") return "free";
  return planExpiresAt && planExpiresAt.getTime() > now.getTime() ? planId : "free";
}

/** A new day pass starts when the user's current pass ends, so passes stack. */
export function passWindow(existingPassEnd: Date | null, now = new Date(), hours = 24): { start: Date; end: Date } {
  const start = existingPassEnd && existingPassEnd > now ? existingPassEnd : now;
  return { start, end: new Date(start.getTime() + hours * 3600 * 1000) };
}

/** First instant of the current month (UTC), when the free job count resets. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Checkout's success signature. Orders sign `order_id|payment_id`;
 * subscriptions sign `payment_id|subscription_id` (Razorpay's documented order).
 */
export function checkoutSignatureValid(
  secret: string,
  p: { kind: "order" | "subscription"; id: string; paymentId: string; signature: string },
): boolean {
  const data = p.kind === "order" ? `${p.id}|${p.paymentId}` : `${p.paymentId}|${p.id}`;
  return safeEqualHex(hmacHex(secret, data), p.signature);
}

/** Webhooks sign the raw request body with the webhook secret. */
export const webhookSignatureValid = (secret: string, rawBody: string, signature: string) =>
  safeEqualHex(hmacHex(secret, rawBody), signature);

/** Number of charges a subscription runs for before it must be renewed by hand. */
export const totalCount = (period: "month" | "year") => (period === "month" ? 120 : 10);

export function formatMoney(amountMinor: number, currency: string): string {
  const v = amountMinor / 100;
  const whole = Number.isInteger(v);
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(v);
}
