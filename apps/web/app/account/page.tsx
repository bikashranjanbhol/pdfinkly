import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { DeleteAccountButton } from "@/components/DeleteAccountButton";
import { getActor } from "@/lib/server/actor";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const actor = await getActor();
  if (!actor || actor.isGuest) redirect("/signin");
  const { user, plan } = actor;

  return (
    <div className="min-h-screen bg-ground">
      <AppHeader active="account" />
      <main className="mx-auto flex max-w-[880px] flex-col gap-5 px-6 pb-12 pt-8">
        <h1 className="font-display text-[32px] font-bold tracking-tight">Account</h1>

        <section aria-labelledby="plan-h" className="card flex flex-col gap-4 p-6">
          <div>
            <h2 id="plan-h" className="text-lg font-semibold">{plan.name} plan</h2>
            <p className="mt-1 text-zinc-600">Browser editing is free. Paid plans with OCR, conversion and bigger files are coming soon.</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            <div className="rounded-[10px] bg-zinc-50 p-3.5"><div className="text-[13px] text-zinc-600">Largest file allowed</div><div className="mt-0.5 text-xl font-bold">{plan.maxFileMb} MB</div></div>
            <div className="rounded-[10px] bg-zinc-50 p-3.5"><div className="text-[13px] text-zinc-600">Files kept for</div><div className="mt-0.5 text-xl font-bold">{plan.retentionHours ? `${plan.retentionHours} hours` : "Until you delete"}</div></div>
          </div>
        </section>

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
            <p className="mt-1 text-zinc-600">Removes your files and share links.</p>
          </div>
          <DeleteAccountButton />
        </section>
      </main>
    </div>
  );
}
