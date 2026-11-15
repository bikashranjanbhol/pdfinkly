import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { Scanner } from "@/components/scan/Scanner";
import { handoffForToken } from "@/lib/server/handoff";

export const metadata: Metadata = { title: "Scan for your computer", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Opened from the QR code on a computer: scan here, pages go there. No sign-in needed. */
export default async function PhoneScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const live = await handoffForToken(token).catch(() => null);
  return (
    <div className="min-h-screen bg-ground">
      <header className="border-b border-zinc-200 bg-white px-4 py-3">
        <Logo href="/" size={28} />
      </header>
      {live ? (
        <Scanner handoff={token} />
      ) : (
        <main className="mx-auto flex max-w-[560px] flex-col gap-4 px-4 py-12">
          <h1 className="font-display text-[28px] font-bold tracking-tight">This link has expired</h1>
          <p className="text-zinc-600">
            Links from the QR code work for 15 minutes. On your computer, open Scan, choose <span className="font-semibold">Use your phone</span>, and
            scan the new code.
          </p>
          <p>
            <Link href="/scan" className="btn-secondary">Scan on this phone instead</Link>
          </p>
        </main>
      )}
    </div>
  );
}
