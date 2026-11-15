"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CheckoutStart } from "@/lib/billing/types";
import { api } from "@/lib/client/api";

const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
}
interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", cb: (r: { error?: { description?: string } }) => void): void;
}
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

let scriptPromise: Promise<RazorpayCtor> | null = null;
function loadCheckout(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  scriptPromise ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CHECKOUT_JS;
    s.async = true;
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error("Checkout didn't load.")));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't reach the payment page. Check your connection and try again."));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Buy a price with Razorpay Checkout (UPI, cards, netbanking, wallets; UPI
 * AutoPay or card mandates for subscriptions). Pro is switched on by the
 * server once it has checked Razorpay's signature.
 */
export function CheckoutButton({
  priceId,
  label,
  primary,
  signedIn,
  disabledReason,
  autoStart,
}: {
  priceId: string;
  label: string;
  primary?: boolean;
  signedIn: boolean;
  disabledReason?: string;
  /** Open Checkout straight away (back from sign-in with ?buy=…). */
  autoStart?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (autoStart && signedIn && !disabledReason && !started.current) {
      started.current = true;
      void buy();
    }
  }, [autoStart, signedIn, disabledReason]);
  const cls = `${primary ? "btn-primary" : "btn-secondary"} w-full`;

  if (disabledReason) {
    return <button type="button" className={cls} disabled>{disabledReason}</button>;
  }
  if (!signedIn) {
    return (
      <a href={`/signin?next=${encodeURIComponent(`/pricing?buy=${priceId}`)}`} className={cls}>
        {label}
      </a>
    );
  }

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const [Razorpay, start] = await Promise.all([
        loadCheckout(),
        api<CheckoutStart>("/api/billing/checkout", { method: "POST", json: { priceId } }),
      ]);
      await new Promise<void>((resolve, reject) => {
        const rzp = new Razorpay({
          key: start.keyId,
          name: "PDFInkly",
          description: start.description,
          ...(start.kind === "order"
            ? { order_id: start.id, amount: start.amount, currency: start.currency }
            : { subscription_id: start.id }),
          prefill: start.prefill,
          theme: { color: "#2563eb" },
          handler: (r: RazorpayResponse) => {
            api("/api/billing/verify", {
              method: "POST",
              json: { kind: start.kind, id: start.id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature },
            }).then(() => resolve(), reject);
          },
          modal: { ondismiss: () => reject(new DOMException("closed", "AbortError")) },
        });
        rzp.on("payment.failed", (r) => setError(r.error?.description ?? "The payment didn't go through."));
        rzp.open();
      });
      router.push("/account?welcome=1");
      router.refresh();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={cls} onClick={() => void buy()} disabled={busy} aria-busy={busy}>
        {busy ? "Opening payment…" : label}
      </button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
