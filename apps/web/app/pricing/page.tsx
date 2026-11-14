import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { IconCheck } from "@/components/icons";

export const metadata: Metadata = { title: "Pricing" };

const PLANS = [
  {
    name: "Free",
    tagline: "For a quick edit now and then.",
    price: "₹0",
    period: "forever",
    cta: { href: "/upload", label: "Start for free", primary: false },
    features: ["Edit, annotate, fill and sign", "Merge and organize pages", "Version history and share links", "Files kept for a limited time"],
  },
  {
    name: "Pro",
    tagline: "For people who work with PDFs every week.",
    price: "Coming soon",
    period: "",
    cta: { href: "/signin", label: "Join the waitlist", primary: true },
    features: ["Everything in Free", "Bigger files", "Compress, OCR and Office conversion", "Files kept until you delete them"],
    popular: true,
  },
  {
    name: "Business",
    tagline: "For teams that process documents daily.",
    price: "Coming soon",
    period: "",
    cta: { href: "mailto:hello@pdfinkly.com", label: "Talk to us", primary: false },
    features: ["Everything in Pro", "Largest files", "Password protect and unlock", "Priority support"],
  },
];

export default function Pricing() {
  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader active="pricing" />
      <main className="mx-auto flex max-w-[1200px] flex-col gap-10 px-6 pb-20 pt-16 sm:px-10">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <h1 className="font-display text-5xl font-bold tracking-tight">Simple plans for every PDF</h1>
          <p className="max-w-[560px] text-lg text-zinc-600">
            Editing in the browser is free. Paid plans will add bigger files, server tools like OCR and conversion, and
            longer storage.
          </p>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-5">
          {PLANS.map((p) => (
            <section
              key={p.name}
              aria-labelledby={`plan-${p.name}`}
              className={`relative flex flex-col gap-5 rounded-2xl bg-white p-7 ${p.popular ? "border-2 border-brand-600" : "border border-zinc-200"}`}
            >
              {p.popular && (
                <span className="absolute -top-3 left-7 rounded-full bg-brand-600 px-2.5 py-1 text-xs font-bold tracking-wide text-white">
                  MOST POPULAR
                </span>
              )}
              <div>
                <h2 id={`plan-${p.name}`} className="text-xl font-bold">{p.name}</h2>
                <p className="mt-1 text-[15px] text-zinc-600">{p.tagline}</p>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-4xl font-bold">{p.price}</span>
                {p.period && <span className="text-zinc-600">{p.period}</span>}
              </div>
              <Link href={p.cta.href} className={p.cta.primary ? "btn-primary" : "btn-secondary"}>{p.cta.label}</Link>
              <ul className="flex flex-col gap-2.5 text-[15px]">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2.5"><IconCheck size={18} className="mt-0.5 flex-none text-green-700" />{f}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
