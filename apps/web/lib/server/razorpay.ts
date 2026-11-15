import "server-only";
import { HttpError } from "./http";

/**
 * Minimal Razorpay REST client (plans, subscriptions, orders). Keys come from
 * RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET; RAZORPAY_API_BASE points tests at a
 * mock server.
 */
export const razorpay = {
  configured: () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
  get keyId() {
    return process.env.RAZORPAY_KEY_ID ?? "";
  },
  get keySecret() {
    const s = process.env.RAZORPAY_KEY_SECRET;
    if (!s) throw new HttpError("PAYMENTS_UNAVAILABLE", "Payments aren't switched on yet.");
    return s;
  },
  get webhookSecret() {
    return process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
  },
  /** Test and live keys see different plans, so plan ids are stored per mode. */
  get mode(): "test" | "live" {
    return (process.env.RAZORPAY_KEY_ID ?? "").startsWith("rzp_live_") ? "live" : "test";
  },
};

const base = () => (process.env.RAZORPAY_API_BASE ?? "https://api.razorpay.com/v1").replace(/\/$/, "");

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!razorpay.configured()) throw new HttpError("PAYMENTS_UNAVAILABLE", "Payments aren't switched on yet.");
  const auth = Buffer.from(`${razorpay.keyId}:${razorpay.keySecret}`).toString("base64");
  const res = await fetch(base() + path, {
    method,
    headers: { authorization: `Basic ${auth}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) {
    console.error(`[razorpay] ${method} ${path} → ${res.status}`, json?.error?.description);
    throw new HttpError("PAYMENTS_UNAVAILABLE", "The payment service didn't respond. Please try again.");
  }
  return json;
}

export interface RzpPlan { id: string }
export interface RzpSubscription {
  id: string;
  plan_id: string;
  status: string;
  customer_id?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  charge_at?: number | null;
  notes?: Record<string, string>;
}
export interface RzpOrder { id: string; amount: number; currency: string; status: string; notes?: Record<string, string> }
export interface RzpPayment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  order_id?: string | null;
  invoice_id?: string | null;
  created_at?: number;
  notes?: Record<string, string>;
}

export const rzp = {
  createPlan: (p: { period: "monthly" | "yearly"; amount: number; currency: string; name: string }) =>
    call<RzpPlan>("POST", "/plans", {
      period: p.period,
      interval: 1,
      item: { name: p.name, amount: p.amount, currency: p.currency },
    }),
  createSubscription: (p: { planId: string; totalCount: number; notes: Record<string, string> }) =>
    call<RzpSubscription>("POST", "/subscriptions", {
      plan_id: p.planId,
      total_count: p.totalCount,
      customer_notify: 1,
      notes: p.notes,
    }),
  getSubscription: (id: string) => call<RzpSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`),
  cancelSubscription: (id: string) =>
    call<RzpSubscription>("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 }),
  createOrder: (p: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) =>
    call<RzpOrder>("POST", "/orders", p),
  getPayment: (id: string) => call<RzpPayment>("GET", `/payments/${encodeURIComponent(id)}`),
};

export const fromUnix = (s: number | null | undefined) => (s ? new Date(s * 1000) : null);
