"use client";

import { useEffect, useState } from "react";
import type { BillingSummary } from "@/lib/billing/types";
import { api, ApiFailure } from "./api";

/** Pro-only features, as keys of plans.features. */
export type ProFeature = "redact" | "protect" | "bates";

export const FEATURE_LABEL: Record<ProFeature, string> = {
  redact: "Redaction",
  protect: "Password protection",
  bates: "Bates numbering",
};

let lastFocusRefresh = 0;
let cached: Promise<BillingSummary | null> | null = null;
const listeners = new Set<(b: BillingSummary | null) => void>();

function load(): Promise<BillingSummary | null> {
  cached ??= api<{ billing?: BillingSummary }>("/api/me")
    .then((r) => r.billing ?? null)
    .catch(() => null);
  return cached;
}

/** Re-read the plan (after a purchase, or a counted job). */
export function refreshPlan() {
  cached = null;
  void load().then((b) => listeners.forEach((l) => l(b)));
}

/** The visitor's plan; null while loading or for a brand-new visitor (treated as Free). */
export function usePlan(): BillingSummary | null {
  const [plan, setPlan] = useState<BillingSummary | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((b) => live && setPlan(b));
    listeners.add(setPlan);
    // Pro may have been bought in another tab (the pricing page opens in one).
    const onFocus = () => {
      if (Date.now() - lastFocusRefresh > 2000) {
        lastFocusRefresh = Date.now();
        refreshPlan();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      listeners.delete(setPlan);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return plan;
}

/** A Pro feature the visitor's plan lacks. While the plan is still loading nothing is locked. */
export const isLocked = (plan: BillingSummary | null, f: ProFeature) => plan !== null && plan.features?.[f] !== true;

export class QuotaExceeded extends Error {
  constructor(message: string, public limit: number, public resetsAt: string) {
    super(message);
  }
}

/** Count one conversion/compression; throws QuotaExceeded when the month's allowance is used up. */
export async function countJob(tool: "convert" | "compress"): Promise<void> {
  try {
    await api("/api/usage", { method: "POST", json: { tool } });
  } catch (e) {
    if (e instanceof ApiFailure && e.code === "QUOTA_EXCEEDED") {
      const d = (e.details ?? {}) as { limit?: number; resetsAt?: string };
      throw new QuotaExceeded(e.message, d.limit ?? 0, d.resetsAt ?? "");
    }
    // The count is a soft limit: if the server can't be reached, let the work go ahead.
    if (e instanceof ApiFailure && e.status < 500) throw e;
  } finally {
    refreshPlan();
  }
}
