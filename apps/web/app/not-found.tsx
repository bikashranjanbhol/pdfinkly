import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-6 py-24 text-center">
        <p className="pill">404</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">We couldn’t find that page</h1>
        <p className="text-zinc-600">The link may be old, or the file may have been deleted or expired.</p>
        <div className="mt-2 flex gap-3">
          <Link href="/" className="btn-secondary">Go home</Link>
          <Link href="/upload" className="btn-primary">Upload a PDF</Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
