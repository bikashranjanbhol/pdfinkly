import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { IconCheck } from "@/components/icons";
import { CheckoutButton } from "@/components/billing/CheckoutButton";
import { formatMoney } from "@/lib/billing/logic";
import { getActor } from "@/lib/server/actor";
import { billingSummary, currencyFor, listPrices, type Currency } from "@/lib/server/billing";
import { razorpay } from "@/lib/server/razorpay";
import type { Price } from "@pdfinkly/db";

export const metadata: Metadata = { title: "Pricing" };
export const dynamic = "force-dynamic";

const FREE = [
  "Edit text, annotate, fill and sign",
  "Organize, merge and rotate pages",
  "OCR in your browser (English and Hindi)",
  "Watermarks, page numbers, headers and footers",
  "10 conversions or compressions a month",
  "Files up to 25 MB, kept for 24 hours",
];
const PRO = [
  "Everything in Free",
  "Unlimited conversions (Word, Excel, PowerPoint, images) and compression",
  "Redaction with Aadhaar, PAN and bank detail detection",
  "Password protection with permissions",
  "Bates numbering",
  "Files up to 200 MB, kept until you delete them",
];
const PASS = ["All of Pro for 24 hours", "One payment, nothing renews", "Buy another to add 24 more hours"];

// Shown if the database can't be read, so the page still renders.
const FALLBACK: Record<Currency, Pick<Price, "id" | "period" | "amountMinor" | "currency">[]> = {
  INR: [
    { id: "pro_month_inr", period: "month", amountMinor: 19900, currency: "INR" },
    { id: "pro_year_inr", period: "year", amountMinor: 149900, currency: "INR" },
    { id: "pro_day_inr", period: "day", amountMinor: 4900, currency: "INR" },
  ],
  USD: [
    { id: "pro_month_usd", period: "month", amountMinor: 700, currency: "USD" },
    { id: "pro_year_usd", period: "year", amountMinor: 5900, currency: "USD" },
    { id: "pro_day_usd", period: "day", amountMinor: 200, currency: "USD" },
  ],
};

export default async function Pricing({ searchParams }: { searchParams: Promise<{ currency?: string; buy?: string }> }) {
  const sp = await searchParams;
  const currency: Currency = sp.currency === "USD" || sp.currency === "INR" ? sp.currency : currencyFor(await headers());
  const [actor, rows] = await Promise.all([getActor().catch(() => null), listPrices(currency).catch(() => null)]);
  const list = rows?.length ? rows : FALLBACK[currency];
  const by = (period: string) => list.find((p) => p.period === period)!;
  const month = by("month");
  const year = by("year");
  const day = by("day");
  const saving = Math.round((1 - year.amountMinor / (month.amountMinor * 12)) * 100);

  const signedIn = !!actor && !actor.isGuest;
  const summary = signedIn ? await billingSummary(actor).catch(() => null) : null;
  const off = !razorpay.configured() ? "Payments open soon" : undefined;
  const sub = summary?.subscription;
  const subscribedReason =
    off ??
    (sub
      ? sub.cancelAtPeriodEnd && sub.renewsAt
        ? `Pro until ${new Date(sub.renewsAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
        : "You're subscribed"
      : undefined);
  const other: Currency = currency === "INR" ? "USD" : "INR";

  const card = "relative flex flex-col gap-5 rounded-2xl bg-white p-7";
  const features = (items: string[]) => (
    <ul className="flex flex-col gap-2.5 text-[15px]">
      {items.map((f) => (
        <li key={f} className="flex gap-2.5"><IconCheck size={18} className="mt-0.5 flex-none text-green-700" />{f}</li>
      ))}
    </ul>
  );

  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader active="pricing" />
      <main className="mx-auto flex max-w-[1200px] flex-col gap-10 px-6 pb-20 pt-16 sm:px-10">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <h1 className="font-display text-5xl font-bold tracking-tight">Simple plans for every PDF</h1>
          <p className="max-w-[600px] text-lg text-zinc-600">
            Editing, signing and OCR are free. Pro removes the monthly limits and adds redaction, password protection and
            bigger files. Your PDFs are processed in your browser on every plan.
          </p>
          <p className="text-sm text-zinc-600">
            Prices in {currency === "INR" ? "Indian rupees" : "US dollars"} ·{" "}
            <Link href={`/pricing?currency=${other}`} className="font-semibold text-brand-700">
              Show in {other === "INR" ? "rupees" : "dollars"}
            </Link>
          </p>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
          <section aria-labelledby="plan-free" className={`${card} border border-zinc-200`}>
            <div>
              <h2 id="plan-free" className="text-xl font-bold">Free</h2>
              <p className="mt-1 text-[15px] text-zinc-600">For a quick edit now and then.</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-4xl font-bold">{formatMoney(0, currency)}</span>
              <span className="text-zinc-600">forever</span>
            </div>
            <Link href="/upload" className="btn-secondary w-full">Start for free</Link>
            {features(FREE)}
          </section>

          <section aria-labelledby="plan-pro" className={`${card} border-2 border-brand-600`}>
            <span className="absolute -top-3 left-7 rounded-full bg-brand-600 px-2.5 py-1 text-xs font-bold tracking-wide text-white">
              MOST POPULAR
            </span>
            <div>
              <h2 id="plan-pro" className="text-xl font-bold">Pro</h2>
              <p className="mt-1 text-[15px] text-zinc-600">For people who work with PDFs every week.</p>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-4xl font-bold">{formatMoney(month.amountMinor, currency)}</span>
                <span className="text-zinc-600">a month</span>
              </div>
              <span className="text-sm text-zinc-600">
                or {formatMoney(year.amountMinor, currency)} a year (save {saving}%)
              </span>
            </div>
            <div className="flex flex-col gap-2">
              <CheckoutButton priceId={month.id} label="Get Pro monthly" primary signedIn={signedIn} disabledReason={subscribedReason} autoStart={sp.buy === month.id} />
              <CheckoutButton priceId={year.id} label={`Get Pro yearly (save ${saving}%)`} signedIn={signedIn} disabledReason={subscribedReason} autoStart={sp.buy === year.id} />
            </div>
            {features(PRO)}
          </section>

          <section aria-labelledby="plan-pass" className={`${card} border border-zinc-200`}>
            <div>
              <h2 id="plan-pass" className="text-xl font-bold">Day pass</h2>
              <p className="mt-1 text-[15px] text-zinc-600">For a one-off job: a form, an application, a contract.</p>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-4xl font-bold">{formatMoney(day.amountMinor, currency)}</span>
              <span className="text-zinc-600">for 24 hours</span>
            </div>
            <CheckoutButton priceId={day.id} label="Buy a day pass" signedIn={signedIn} disabledReason={off} autoStart={sp.buy === day.id} />
            {features(PASS)}
          </section>
        </div>

        <div className="flex flex-col gap-2 text-center text-sm text-zinc-600">
          <p>
            Pay with UPI, cards, netbanking or wallets through Razorpay. Subscriptions renew automatically (UPI AutoPay or
            card) and you can cancel any time from your account; Pro stays on until the end of the period you paid for.
          </p>
          <p>
            Need it for a team? <a href="mailto:hello@pdfinkly.com" className="font-semibold text-brand-700">Talk to us</a> about the
            Business plan.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
