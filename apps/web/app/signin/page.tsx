import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signInWith } from "@/app/actions";
import { Logo } from "@/components/Logo";
import { IconCheck } from "@/components/icons";
import { getActor } from "@/lib/server/actor";
import { configuredProviders } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const actor = await getActor().catch(() => null);
  const { error, next } = await searchParams;
  const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : undefined;
  if (actor && !actor.isGuest) redirect(dest ?? "/files");
  const providers = configuredProviders();

  return (
    <div className="flex min-h-screen flex-wrap bg-ground">
      <main className="flex min-w-0 flex-[999_1_520px] flex-col px-6 pb-10 pt-7 sm:px-10">
        <Logo />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="flex w-full max-w-[400px] flex-col gap-5">
            <div>
              <h1 className="font-display text-[34px] font-bold leading-tight tracking-tight">Sign in or create an account</h1>
              <p className="mt-2 text-zinc-600">
                {dest?.startsWith("/pricing")
                  ? "Pro is tied to your account, so sign in first. You'll go straight on to payment."
                  : "One step. We'll create your account if you don't have one."}
              </p>
            </div>
            {error && (
              <p role="alert" className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                Sign-in didn&apos;t work. Please try again.
              </p>
            )}
            {providers.length > 0 ? (
              providers.map((p) => (
                <form key={p.id} action={signInWith.bind(null, p.id, dest)}>
                  <button type="submit" className="btn-secondary h-12 w-full">Continue with {p.name}</button>
                </form>
              ))
            ) : (
              <p className="rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                No sign-in providers are configured yet. Add Google or GitHub keys to the environment (see README).
              </p>
            )}
            <p className="text-[13px] text-zinc-500">By continuing you agree to the Terms and Privacy Policy.</p>
            <div className="border-t border-zinc-200 pt-4 text-[15px] text-zinc-600">
              Just need a quick edit? <Link href="/upload" className="font-semibold text-brand-700">Continue without an account</Link>
            </div>
          </div>
        </div>
      </main>
      <aside className="flex min-w-0 flex-[1_1_380px] flex-col justify-center gap-6 bg-brand-50 px-12 py-14 text-brand-900">
        <h2 className="font-display text-[26px] font-bold">With an account you can</h2>
        <ul className="flex flex-col gap-4 text-base">
          {["Keep your files and pick up on any device", "Go back to any earlier version", "Share files with links you can revoke"].map((t) => (
            <li key={t} className="flex gap-3"><IconCheck className="mt-0.5 flex-none text-brand-700" />{t}</li>
          ))}
        </ul>
        <p className="text-sm text-brand-800">Files you edited as a guest move into your account when you sign in.</p>
      </aside>
    </div>
  );
}
