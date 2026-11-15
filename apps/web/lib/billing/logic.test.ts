import { describe, expect, it } from "vitest";
import {
  accessEnd,
  checkoutSignatureValid,
  effectivePlanId,
  formatMoney,
  GRACE_DAYS,
  hmacHex,
  mapRazorpayStatus,
  monthStart,
  nextMonthStart,
  passWindow,
  webhookSignatureValid,
} from "./logic";

const DAY = 86400_000;
const at = (iso: string) => new Date(iso);

describe("mapRazorpayStatus", () => {
  it("maps every Razorpay state", () => {
    expect(mapRazorpayStatus("created")).toBe("incomplete");
    expect(mapRazorpayStatus("authenticated")).toBe("active");
    expect(mapRazorpayStatus("active")).toBe("active");
    expect(mapRazorpayStatus("pending")).toBe("past_due");
    expect(mapRazorpayStatus("halted")).toBe("past_due");
    expect(mapRazorpayStatus("cancelled")).toBe("cancelled");
    expect(mapRazorpayStatus("completed")).toBe("expired");
    expect(mapRazorpayStatus("expired")).toBe("expired");
  });
});

describe("accessEnd", () => {
  const end = at("2026-12-15T00:00:00Z");
  it("gives renewing subscriptions a grace period", () => {
    expect(accessEnd([{ kind: "recurring", status: "active", currentPeriodEnd: end, cancelAtPeriodEnd: false }])).toEqual(
      new Date(end.getTime() + GRACE_DAYS * DAY),
    );
    expect(accessEnd([{ kind: "recurring", status: "past_due", currentPeriodEnd: end, cancelAtPeriodEnd: false }])).toEqual(
      new Date(end.getTime() + GRACE_DAYS * DAY),
    );
  });
  it("ends a cancelled subscription at the end of the paid period", () => {
    expect(accessEnd([{ kind: "recurring", status: "active", currentPeriodEnd: end, cancelAtPeriodEnd: true }])).toEqual(end);
    expect(accessEnd([{ kind: "recurring", status: "cancelled", currentPeriodEnd: end, cancelAtPeriodEnd: false }])).toEqual(end);
  });
  it("ignores unpaid and expired rows", () => {
    expect(accessEnd([{ kind: "recurring", status: "incomplete", currentPeriodEnd: null, cancelAtPeriodEnd: false }])).toBeNull();
    expect(accessEnd([{ kind: "recurring", status: "expired", currentPeriodEnd: end, cancelAtPeriodEnd: false }])).toBeNull();
    expect(accessEnd([{ kind: "pass", status: "incomplete", currentPeriodEnd: end, cancelAtPeriodEnd: false }])).toBeNull();
  });
  it("takes the latest of a pass and a subscription", () => {
    const later = at("2027-01-01T00:00:00Z");
    expect(
      accessEnd([
        { kind: "recurring", status: "cancelled", currentPeriodEnd: end, cancelAtPeriodEnd: true },
        { kind: "pass", status: "active", currentPeriodEnd: later, cancelAtPeriodEnd: false },
      ]),
    ).toEqual(later);
  });
});

describe("effectivePlanId", () => {
  const now = at("2026-11-15T12:00:00Z");
  it("falls back to free when the paid plan has run out", () => {
    expect(effectivePlanId("pro", at("2026-11-16T00:00:00Z"), now)).toBe("pro");
    expect(effectivePlanId("pro", at("2026-11-15T11:59:59Z"), now)).toBe("free");
    expect(effectivePlanId("pro", null, now)).toBe("free");
    expect(effectivePlanId("free", null, now)).toBe("free");
  });
});

describe("passWindow", () => {
  const now = at("2026-11-15T12:00:00Z");
  it("starts now, or after a pass that is still running", () => {
    expect(passWindow(null, now)).toEqual({ start: now, end: new Date(now.getTime() + DAY) });
    const running = at("2026-11-15T20:00:00Z");
    expect(passWindow(running, now)).toEqual({ start: running, end: new Date(running.getTime() + DAY) });
    expect(passWindow(at("2026-11-14T00:00:00Z"), now).start).toEqual(now);
  });
});

describe("month boundaries", () => {
  it("resets on the first of the month (UTC)", () => {
    expect(monthStart(at("2026-12-31T23:00:00Z"))).toEqual(at("2026-12-01T00:00:00Z"));
    expect(nextMonthStart(at("2026-12-31T23:00:00Z"))).toEqual(at("2027-01-01T00:00:00Z"));
  });
});

describe("signatures", () => {
  const secret = "test_secret";
  it("checks order signatures as order_id|payment_id", () => {
    const signature = hmacHex(secret, "order_1|pay_1");
    expect(checkoutSignatureValid(secret, { kind: "order", id: "order_1", paymentId: "pay_1", signature })).toBe(true);
    expect(checkoutSignatureValid(secret, { kind: "order", id: "order_2", paymentId: "pay_1", signature })).toBe(false);
  });
  it("checks subscription signatures as payment_id|subscription_id", () => {
    const signature = hmacHex(secret, "pay_1|sub_1");
    expect(checkoutSignatureValid(secret, { kind: "subscription", id: "sub_1", paymentId: "pay_1", signature })).toBe(true);
    expect(checkoutSignatureValid("other", { kind: "subscription", id: "sub_1", paymentId: "pay_1", signature })).toBe(false);
  });
  it("checks webhook bodies", () => {
    const body = '{"event":"payment.captured"}';
    expect(webhookSignatureValid("wh", body, hmacHex("wh", body))).toBe(true);
    expect(webhookSignatureValid("wh", body + " ", hmacHex("wh", body))).toBe(false);
    expect(webhookSignatureValid("wh", body, "short")).toBe(false);
  });
});

describe("formatMoney", () => {
  it("formats rupees and dollars", () => {
    expect(formatMoney(19900, "INR")).toBe("₹199");
    expect(formatMoney(149900, "INR")).toBe("₹1,499");
    expect(formatMoney(700, "USD")).toBe("$7");
    expect(formatMoney(250, "USD")).toBe("$2.50");
  });
});
