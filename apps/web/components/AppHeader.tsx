import Link from "next/link";
import { signOutAction } from "@/app/actions";
import { getActor } from "@/lib/server/actor";
import { Logo } from "./Logo";

export async function AppHeader({ active }: { active?: "files" | "upload" | "scan" | "account" }) {
  const actor = await getActor().catch(() => null);
  const link = (key: typeof active, href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={`rounded-lg px-3.5 py-2.5 ${active === key ? "bg-brand-50 font-semibold text-brand-700" : "text-zinc-700 hover:bg-zinc-100"}`}
    >
      {label}
    </Link>
  );
  const initials = (actor?.user.name ?? actor?.user.email ?? "G").split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join("");

  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="flex min-h-16 flex-wrap items-center gap-x-6 gap-y-3 px-6 py-2.5">
        <Logo href="/files" size={30} />
        <nav aria-label="App" className="flex gap-1 text-[15px] font-medium">
          {link("files", "/files", "My files")}
          {link("upload", "/upload", "Upload")}
          {link("scan", "/scan", "Scan")}
          {actor && !actor.isGuest && link("account", "/account", "Account")}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {actor && (
            <span className="rounded-full bg-zinc-100 px-3 py-1.5 text-[13px] font-medium text-zinc-600">
              {actor.isGuest ? "Guest" : `${actor.plan.name} plan`}
            </span>
          )}
          {actor && actor.plan.id === "free" && (
            <Link href="/pricing" className="text-sm font-semibold text-brand-700">Upgrade</Link>
          )}
          {!actor || actor.isGuest ? (
            <Link href="/signin" className="btn-secondary min-h-10 px-3.5 text-sm">Sign in</Link>
          ) : (
            <form action={signOutAction} className="flex items-center gap-2">
              <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-900">
                {initials}
              </span>
              <button type="submit" className="btn-ghost min-h-10 px-3 text-sm">Sign out</button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
