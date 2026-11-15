"use client";

import Link from "next/link";
import type { BillingSummary } from "@/lib/billing/types";

/** "3 of 10 free this month" under a counted tool, or the block when it's used up. */
export function QuotaNotice({ plan, blocked }: { plan: BillingSummary | null; blocked: string | null }) {
  if (blocked) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <span>{blocked}</span>
        <span>
          <Link href="/pricing" target="_blank" className="font-semibold text-brand-700">See Pro plans</Link>
          {" "}· a day pass is enough for a one-off job.
        </span>
      </div>
    );
  }
  const jobs = plan?.jobs;
  if (!jobs || jobs.limit === null) return null;
  const left = Math.max(0, jobs.limit - jobs.used);
  return (
    <p className="text-[13px] text-zinc-600">
      {left} of {jobs.limit} free conversions and compressions left this month.{" "}
      <Link href="/pricing" target="_blank" className="font-semibold text-brand-700">Unlimited with Pro</Link>
    </p>
  );
}
