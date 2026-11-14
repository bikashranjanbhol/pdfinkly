import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import {
  IconArrow, IconHighlight, IconLock, IconPages, IconPen, IconSign, IconUpload, IconText,
} from "@/components/icons";

const TOOLS = [
  { href: "/upload", icon: IconPen, title: "Edit and annotate", text: "Add text, highlights, shapes, images and notes." },
  { href: "/upload", icon: IconSign, title: "Fill and sign", text: "Complete forms and add a drawn or typed signature." },
  { href: "/upload", icon: IconPages, title: "Organize pages", text: "Reorder, rotate, delete and insert pages." },
  { href: "/upload", icon: IconArrow, title: "Merge PDFs", text: "Add pages from another PDF into the one you're editing." },
  { href: "/upload", icon: IconHighlight, title: "Highlight and review", text: "Mark up contracts and reports, then share a link." },
  { href: "/upload", icon: IconText, title: "Version history", text: "Every save is a version. Go back any time." },
  { href: "/upload", icon: IconLock, title: "Private by design", text: "Edits run in your browser. Nothing leaves until you save." },
  { href: "/upload", icon: IconUpload, title: "No install", text: "Works in any modern browser on desktop and mobile." },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-ground">
      <SiteHeader />

      <section className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-14 px-6 pb-16 pt-16 sm:px-10 sm:pt-20">
        <div className="flex min-w-0 flex-[1_1_440px] flex-col gap-6">
          <span className="self-start rounded-full bg-brand-50 px-3 py-1.5 text-[13px] font-semibold text-brand-700">
            Free PDF editor in your browser
          </span>
          <h1 className="font-display text-5xl font-bold leading-[1.05] tracking-tight sm:text-[56px]">
            Edit any PDF without installing anything.
          </h1>
          <p className="max-w-[520px] text-lg text-zinc-600">
            Annotate, fill and sign, rearrange pages and merge files. Editing happens in your browser, so your
            document stays on your device until you save.
          </p>
          <div className="flex flex-wrap items-center gap-5 rounded-2xl border-2 border-dashed border-zinc-400 bg-white p-7">
            <span className="flex size-[52px] items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <IconUpload size={26} />
            </span>
            <div className="min-w-0 flex-[1_1_180px]">
              <div className="font-semibold">Start with a PDF</div>
              <div className="text-sm text-zinc-500">No account needed for a quick edit</div>
            </div>
            <Link href="/upload" className="btn-primary">Choose a PDF</Link>
          </div>
        </div>

        <div className="min-w-0 flex-[1_1_520px]" aria-hidden="true">
          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_12px_32px_rgba(24,24,27,0.08)]">
            <div className="flex h-11 items-center gap-2 border-b border-zinc-200 px-4">
              <span className="size-2.5 rounded-full bg-zinc-200" />
              <span className="size-2.5 rounded-full bg-zinc-200" />
              <span className="size-2.5 rounded-full bg-zinc-200" />
              <span className="ml-3 text-[13px] font-medium text-zinc-600">Service-agreement.pdf</span>
            </div>
            <div className="flex h-[360px] bg-zinc-100">
              <div className="flex w-[84px] flex-col gap-2.5 border-r border-zinc-200 bg-white p-3">
                <div className="h-[76px] rounded border-2 border-brand-600 bg-white" />
                <div className="h-[76px] rounded border border-zinc-200 bg-white" />
                <div className="h-[76px] rounded border border-zinc-200 bg-white" />
              </div>
              <div className="flex flex-1 justify-center pt-6">
                <div className="flex w-[300px] flex-col gap-2 bg-white px-6 py-7 shadow-sm">
                  <div className="h-3 w-3/5 rounded-sm bg-zinc-700" />
                  <div className="mb-2 h-1.5 w-2/5 rounded-sm bg-zinc-300" />
                  <div className="h-1.5 rounded-sm bg-zinc-200" />
                  <div className="h-1.5 rounded-sm bg-zinc-200" />
                  <div className="flex flex-col gap-1.5 bg-yellow-200 py-1">
                    <div className="h-1.5 rounded-sm bg-zinc-300" />
                    <div className="h-1.5 w-2/3 rounded-sm bg-zinc-300" />
                  </div>
                  <div className="h-1.5 rounded-sm bg-zinc-200" />
                  <div className="h-1.5 w-4/5 rounded-sm bg-zinc-200" />
                  <div className="mt-6 self-start rounded border-[1.5px] border-dashed border-brand-600 px-2.5 py-1 font-[cursive] text-xl text-brand-700">
                    A. Sharma
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="tools" className="border-y border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-6 py-16 sm:px-10">
          <div>
            <h2 className="font-display text-4xl font-bold tracking-tight">Every PDF tool in one place</h2>
            <p className="mt-2 text-[17px] text-zinc-600">Drop your file in and pick what you need. No account needed to start.</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
            {TOOLS.map(({ href, icon: Icon, title, text }) => (
              <Link key={title} href={href} className="flex flex-col gap-2.5 rounded-[14px] border border-zinc-200 bg-white p-5 text-ink hover:border-brand-600">
                <span className="flex size-10 items-center justify-center rounded-[10px] bg-brand-50 text-brand-600"><Icon /></span>
                <span className="text-[17px] font-semibold">{title}</span>
                <span className="text-sm text-zinc-600">{text}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto flex max-w-[1200px] flex-col gap-8 px-6 py-16 sm:px-10">
        <h2 className="font-display text-4xl font-bold tracking-tight">How it works</h2>
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6">
          {[
            ["Upload your PDF", "Drop it in or pick it from your device."],
            ["Edit in your browser", "Every change autosaves, and undo is always there."],
            ["Download or share", "Get the finished PDF or send a link you can revoke."],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-4">
              <span className="flex size-9 flex-none items-center justify-center rounded-full bg-ink font-bold text-white">{i + 1}</span>
              <div>
                <div className="text-[17px] font-semibold">{t}</div>
                <div className="text-[15px] text-zinc-600">{d}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section id="privacy" className="bg-ink text-zinc-50">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-6 py-16 sm:px-10">
          <h2 className="font-display text-4xl font-bold tracking-tight">Your documents stay yours</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-8">
            <div><div className="text-[17px] font-semibold">Edited on your device</div><p className="mt-2 text-zinc-300">Annotating, signing and page changes run in your browser. Nothing is uploaded until you save.</p></div>
            <div><div className="text-[17px] font-semibold">Deleted on schedule</div><p className="mt-2 text-zinc-300">Free files are deleted automatically after the retention period. You can delete yours any time.</p></div>
            <div><div className="text-[17px] font-semibold">Encrypted and revocable</div><p className="mt-2 text-zinc-300">HTTPS in transit, private storage, short-lived download links and share links you can revoke.</p></div>
          </div>
        </div>
      </section>

      <section className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-6 px-6 py-16 sm:px-10">
        <div>
          <h2 className="font-display text-3xl font-bold">Ready to edit your PDF?</h2>
          <p className="mt-1.5 text-zinc-600">Free to start. Upgrade when you need more.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/pricing" className="btn-secondary">See pricing</Link>
          <Link href="/upload" className="btn-primary">Upload a PDF</Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
