import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { DeleteAccountButton } from "@/components/DeleteAccountButton";
import Link from "next/link";
import { CancelSubscriptionButton } from "@/components/billing/CancelSubscriptionButton";
import { formatMoney } from "@/lib/billing/logic";
import { getActor } from "@/lib/server/actor";
import { billingSummary, paymentHistory } from "@/lib/server/billing";

const date = (iso: string | Date) =>
  new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
const dateTime = (iso: string | Date) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const PRICE_LABEL: Record<string, string> = { month: "Pro monthly", year: "Pro yearly", day: "Day pass" };

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const actor = await getActor();
  if (!actor || actor.isGuest) redirect("/signin");
  const { user, plan } = actor;
  const [billing, history, { welcome }] = await Promise.all([billingSummary(actor), paymentHistory(user.id), searchParams]);
  const sub = billing.subscription;
  const pro = plan.id !== "free";

  return (
    <div className="min-h-screen bg-ground">
      <AppHeader active="account" />
      <main className="mx-auto flex max-w-[880px] flex-col gap-5 px-6 pb-12 pt-8">
        <h1 className="font-display text-[32px] font-bold tracking-tight">Account</h1>

        {welcome && pro && (
          <p role="status" className="rounded-[14px] border border-green-200 bg-green-50 px-5 py-4 text-[15px] text-green-900">
            Thank you! Pro is on{billing.proUntil ? ` until ${dateTime(billing.proUntil)}` : ""}. A receipt is on its way from Razorpay.
          </p>
        )}

        <section aria-labelledby="plan-h" className="card flex flex-col gap-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="plan-h" className="text-lg font-semibold">{plan.name} plan</h2>
              <p className="mt-1 text-zinc-600">
                {sub
                  ? sub.cancelAtPeriodEnd
                    ? `${PRICE_LABEL[sub.period]} · cancelled, Pro until ${date(sub.renewsAt!)}`
                    : `${PRICE_LABEL[sub.period]} · ${formatMoney(sub.amount, sub.currency)} · renews on ${date(sub.renewsAt!)}${sub.status === "past_due" ? " (last payment failed; Razorpay will retry)" : ""}`
                  : pro && billing.proUntil
                    ? `Day pass · Pro until ${dateTime(billing.proUntil)}`
                    : "Editing, signing and OCR are free. Pro removes the monthly limits and adds redaction and password protection."}
              </p>
            </div>
            {!sub && <Link href="/pricing" className="btn-primary">{pro ? "Get Pro monthly or yearly" : "Upgrade to Pro"}</Link>}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
            <div className="rounded-[10px] bg-zinc-50 p-3.5"><div className="text-[13px] text-zinc-600">Largest file allowed</div><div className="mt-0.5 text-xl font-bold">{plan.maxFileMb} MB</div></div>
            <div className="rounded-[10px] bg-zinc-50 p-3.5"><div className="text-[13px] text-zinc-600">Files kept for</div><div className="mt-0.5 text-xl font-bold">{plan.retentionHours ? `${plan.retentionHours} hours` : "Until you delete"}</div></div>
            <div className="rounded-[10px] bg-zinc-50 p-3.5">
              <div className="text-[13px] text-zinc-600">Conversions and compressions</div>
              <div className="mt-0.5 text-xl font-bold">
                {billing.jobs.limit === null ? "Unlimited" : `${Math.min(billing.jobs.used, billing.jobs.limit)} of ${billing.jobs.limit} used`}
              </div>
              {billing.jobs.limit !== null && <div className="text-[13px] text-zinc-600">Resets on {date(billing.jobs.resetsAt)}</div>}
            </div>
          </div>
          {sub && !sub.cancelAtPeriodEnd && <CancelSubscriptionButton until={date(sub.renewsAt!)} />}
        </section>

        {history.length > 0 && (
          <section aria-labelledby="payments-h" className="card flex flex-col gap-3 p-6">
            <h2 id="payments-h" className="text-lg font-semibold">Payments</h2>
            <table className="w-full text-left text-[15px]">
              <thead className="text-[13px] text-zinc-600">
                <tr><th className="py-1.5 font-medium">Date</th><th className="py-1.5 font-medium">What</th><th className="py-1.5 font-medium">Amount</th><th className="py-1.5 font-medium">Status</th></tr>
              </thead>
              <tbody>
                {history.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-100">
                    <td className="py-2">{date(p.paidAt ?? p.createdAt)}</td>
                    <td className="py-2">{PRICE_LABEL[p.priceId?.split("_")[1] ?? ""] ?? "Pro"}</td>
                    <td className="py-2">{formatMoney(p.amountMinor, p.currency)}</td>
                    <td className="py-2">{p.status === "succeeded" ? "Paid" : p.status === "refunded" ? "Refunded" : p.status === "failed" ? "Failed" : "Pending"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[13px] text-zinc-600">Razorpay emails a receipt for every payment.</p>
          </section>
        )}

        <section aria-labelledby="profile-h" className="card flex flex-col gap-2 p-6">
          <h2 id="profile-h" className="text-lg font-semibold">Profile</h2>
          <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[15px]">
            <dt className="text-zinc-600">Name</dt><dd>{user.name ?? "–"}</dd>
            <dt className="text-zinc-600">Email</dt><dd>{user.email}</dd>
          </dl>
        </section>

        <section aria-labelledby="danger-h" className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-red-200 bg-white p-6">
          <div>
            <h2 id="danger-h" className="text-lg font-semibold text-red-800">Delete account</h2>
            <p className="mt-1 text-zinc-600">Removes your files and share links{sub && !sub.cancelAtPeriodEnd ? ", and stops your subscription" : ""}.</p>
          </div>
          <DeleteAccountButton />
        </section>
      </main>
    </div>
  );
}
