"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client/api";

/** Two-step cancel (no browser confirm dialog): stop renewing, keep Pro until the period ends. */
export function CancelSubscriptionButton({ until }: { until: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/billing/cancel", { method: "POST" });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't cancel. Please try again.");
    } finally {
      setBusy(false);
      setAsking(false);
    }
  }

  if (!asking) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button type="button" className="btn-secondary" onClick={() => setAsking(true)}>Cancel subscription</button>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </div>
    );
  }
  return (
    <div role="group" aria-label="Confirm cancellation" className="flex flex-col gap-3 rounded-[10px] border border-amber-200 bg-amber-50 p-4">
      <p className="text-[15px] text-amber-900">
        Your subscription won&apos;t renew. You keep Pro until {until}, then your account moves to Free.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-danger" onClick={() => void cancel()} disabled={busy}>
          {busy ? "Cancelling…" : "Yes, cancel"}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setAsking(false)} disabled={busy}>Keep Pro</button>
      </div>
    </div>
  );
}
