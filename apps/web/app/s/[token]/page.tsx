import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, isNull } from "drizzle-orm";
import { fileVersions, files, getDb, shareLinks, users } from "@pdfinkly/db";
import { Logo } from "@/components/Logo";
import { SharedViewer } from "@/components/SharedViewer";
import { hashToken } from "@/lib/server/shares";
import { storage } from "@/lib/server/storage";

export const metadata: Metadata = { title: "Shared PDF", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function resolve(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const db = getDb();
  const [row] = await db
    .select({ share: shareLinks, file: files, version: fileVersions, owner: users.name })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .innerJoin(fileVersions, eq(fileVersions.id, files.currentVersionId))
    .innerJoin(users, eq(users.id, files.ownerId))
    .where(and(eq(shareLinks.tokenHash, hashToken(token)), isNull(shareLinks.revokedAt), isNull(files.deletedAt)))
    .limit(1);
  if (!row) return null;
  if (row.share.expiresAt && row.share.expiresAt < new Date()) return null;
  return row;
}

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const row = await resolve(token);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-100">
      <header className="border-b border-zinc-200 bg-white">
        <div className="flex min-h-16 flex-wrap items-center gap-x-5 gap-y-3 px-6 py-2.5">
          <Logo size={30} />
          {row && (
            <>
              <div className="min-w-0 flex-[1_1_260px]">
                <div className="truncate font-semibold">{row.file.name}</div>
                <div className="text-[13px] text-zinc-600">
                  Shared{row.owner ? ` by ${row.owner}` : ""} · view only{row.version.pageCount ? ` · ${row.version.pageCount} pages` : ""}
                </div>
              </div>
              <a className="btn-primary" href={await storage().presignGet(row.version.storageKey, { downloadName: row.file.name })}>Download</a>
            </>
          )}
        </div>
      </header>

      {row ? (
        <SharedViewer url={await storage().presignGet(row.version.storageKey)} />
      ) : (
        <main className="flex flex-1 items-center justify-center px-4 py-10">
          <div className="flex max-w-[440px] flex-col items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-8 text-center">
            <h1 className="font-display text-2xl font-bold">This link no longer works</h1>
            <p className="text-zinc-600">It has expired or the owner turned it off. Ask the person who shared it for a new link.</p>
          </div>
        </main>
      )}

      <footer className="flex flex-wrap justify-center gap-2 border-t border-zinc-200 bg-white px-6 py-3.5 text-sm text-zinc-600">
        Need to edit a PDF of your own? <Link href="/" className="font-semibold text-brand-700">Try PDFInkly free</Link>
      </footer>
    </div>
  );
}
