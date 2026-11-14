import Link from "next/link";
import { Logo } from "./Logo";

export function SiteHeader({ active }: { active?: "pricing" }) {
  return (
    <header className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-6 py-3.5 sm:px-10">
        <Logo />
        <nav aria-label="Main" className="flex flex-wrap items-center gap-7 text-[15px] font-medium">
          <Link href="/#tools" className="text-zinc-700 hover:text-ink">Tools</Link>
          <Link href="/pricing" aria-current={active === "pricing" ? "page" : undefined} className={active === "pricing" ? "font-semibold text-brand-700" : "text-zinc-700 hover:text-ink"}>
            Pricing
          </Link>
          <Link href="/#privacy" className="text-zinc-700 hover:text-ink">Privacy</Link>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/signin" className="px-3.5 py-2.5 text-[15px] font-semibold text-ink">Sign in</Link>
          <Link href="/upload" className="btn-primary">Upload a PDF</Link>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-zinc-200">
      <div className="mx-auto flex max-w-[1200px] flex-wrap justify-between gap-4 px-6 py-7 text-sm text-zinc-600 sm:px-10">
        <span>© {new Date().getFullYear()} PDFInkly</span>
        <nav aria-label="Footer" className="flex gap-6">
          <Link href="/#privacy" className="text-zinc-600">Privacy</Link>
          <Link href="/pricing" className="text-zinc-600">Pricing</Link>
          <a href="mailto:hello@pdfinkly.com" className="text-zinc-600">Contact</a>
        </nav>
      </div>
    </footer>
  );
}
