/** Shapes shared by the billing API and the browser. */
export interface BillingSummary {
  planId: string;
  planName: string;
  features: Record<string, boolean>;
  maxFileMb: number;
  retentionHours: number | null;
  jobs: { used: number; limit: number | null; resetsAt: string };
  proUntil: string | null;
  subscription: null | {
    period: "month" | "year";
    status: string;
    renewsAt: string | null;
    cancelAtPeriodEnd: boolean;
    amount: number;
    currency: string;
  };
  paymentsEnabled: boolean;
}

export interface CheckoutStart {
  keyId: string;
  kind: "subscription" | "order";
  id: string;
  amount: number;
  currency: string;
  description: string;
  prefill: { name?: string; email?: string };
}
