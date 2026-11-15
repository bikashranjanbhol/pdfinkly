// A stand-in for Razorpay's API and Checkout, for local tests (the real one
// can't be reached from the test machine).
//
//   RAZORPAY_KEY_ID=rzp_test_mock RAZORPAY_KEY_SECRET=mocksecret node scripts/mock-razorpay.mjs
//
// Point the app at it with RAZORPAY_API_BASE=http://127.0.0.1:4010/v1, and have
// the browser load http://127.0.0.1:4010/checkout.js in place of Razorpay's
// script (the Playwright test reroutes it). "Paying" in the fake Checkout
// marks the subscription/order paid and hands back a correctly signed result.
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.MOCK_RAZORPAY_PORT ?? 4010);
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? "rzp_test_mock";
const SECRET = process.env.RAZORPAY_KEY_SECRET ?? "mocksecret";
const id = (p) => `${p}_${randomBytes(7).toString("hex")}`;
const sign = (data) => createHmac("sha256", SECRET).update(data).digest("hex");
const now = () => Math.floor(Date.now() / 1000);

const plans = new Map();
const subs = new Map();
const orders = new Map();
const calls = [];

const CHECKOUT_JS = `
window.Razorpay = function (options) {
  var failed = null;
  return {
    on: function (evt, cb) { if (evt === "payment.failed") failed = cb; },
    open: function () {
      var kind = options.order_id ? "order" : "subscription";
      var body = JSON.stringify({ kind: kind, id: options.order_id || options.subscription_id, key: options.key });
      fetch("http://127.0.0.1:${PORT}/__pay", { method: "POST", body: body })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (r.error) { if (failed) failed({ error: { description: r.error } }); return; }
          window.__lastRazorpay = { options: options, result: r };
          options.handler(r);
        });
    },
  };
};`;

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === "/checkout.js") return send(res, 200, CHECKOUT_JS, "application/javascript");
  if (path === "/__calls") return send(res, 200, calls);
  if (path === "/__pay") {
    if (body.key !== KEY_ID) return send(res, 200, { error: "wrong key in Checkout" });
    const paymentId = id("pay");
    if (body.kind === "order") {
      const o = orders.get(body.id);
      if (!o) return send(res, 200, { error: "unknown order" });
      o.status = "paid";
      return send(res, 200, { razorpay_payment_id: paymentId, razorpay_order_id: o.id, razorpay_signature: sign(`${o.id}|${paymentId}`) });
    }
    const s = subs.get(body.id);
    if (!s) return send(res, 200, { error: "unknown subscription" });
    const period = plans.get(s.plan_id)?.period === "yearly" ? 365 : 30;
    Object.assign(s, { status: "active", current_start: now(), current_end: now() + period * 86400, customer_id: id("cust") });
    return send(res, 200, { razorpay_payment_id: paymentId, razorpay_subscription_id: s.id, razorpay_signature: sign(`${paymentId}|${s.id}`) });
  }

  if (!path.startsWith("/v1/")) return send(res, 404, { error: { description: "not found" } });
  const auth = Buffer.from(`${KEY_ID}:${SECRET}`).toString("base64");
  if (req.headers.authorization !== `Basic ${auth}`) return send(res, 401, { error: { description: "auth failed" } });
  calls.push({ method: req.method, path, body });

  let m;
  if (req.method === "POST" && path === "/v1/plans") {
    const p = { id: id("plan"), ...body };
    plans.set(p.id, p);
    return send(res, 200, p);
  }
  if (req.method === "POST" && path === "/v1/subscriptions") {
    if (!plans.has(body.plan_id)) return send(res, 400, { error: { description: "plan not found" } });
    const s = { id: id("sub"), plan_id: body.plan_id, status: "created", total_count: body.total_count, notes: body.notes, current_start: null, current_end: null };
    subs.set(s.id, s);
    return send(res, 200, s);
  }
  if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)$/)) && req.method === "GET") {
    const s = subs.get(m[1]);
    return s ? send(res, 200, s) : send(res, 404, { error: { description: "no such subscription" } });
  }
  if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)\/cancel$/)) && req.method === "POST") {
    const s = subs.get(m[1]);
    if (!s) return send(res, 404, { error: { description: "no such subscription" } });
    if (!body.cancel_at_cycle_end) s.status = "cancelled";
    s.ended_at = body.cancel_at_cycle_end ? s.current_end : now();
    return send(res, 200, s);
  }
  if (req.method === "POST" && path === "/v1/orders") {
    const o = { id: id("order"), amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: "created" };
    orders.set(o.id, o);
    return send(res, 200, o);
  }
  return send(res, 404, { error: { description: `no mock for ${req.method} ${path}` } });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-razorpay] http://127.0.0.1:${PORT}`));
