import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { editDrafts, fileVersions, files, getDb, type FileRow, type FileVersionRow, type Plan } from "@pdfinkly/db";
import type { FileSummary, VersionInfo } from "@pdfinkly/shared";
import type { Actor } from "./actor";
import { HttpError } from "./http";

export const maxBytes = (plan: Plan) => plan.maxFileMb * 1024 * 1024;

export const expiryFor = (plan: Plan): Date | null =>
  plan.retentionHours ? new Date(Date.now() + plan.retentionHours * 3600 * 1000) : null;

export function assertSize(plan: Plan, sizeBytes: number) {
  if (sizeBytes > maxBytes(plan)) {
    throw new HttpError("FILE_TOO_LARGE", `Files on the ${plan.name} plan can be up to ${plan.maxFileMb} MB.`, {
      maxBytes: maxBytes(plan),
    });
  }
}

/** A file the actor owns and hasn't deleted; otherwise 404 (never 403, so ids can't be probed). */
export async function getOwnedFile(actor: Actor, fileId: string): Promise<FileRow> {
  const [f] = await getDb()
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ownerId, actor.user.id), isNull(files.deletedAt)))
    .limit(1);
  if (!f) throw new HttpError("NOT_FOUND", "File not found.");
  return f;
}

export async function getVersion(fileId: string, versionId: string): Promise<FileVersionRow> {
  const [v] = await getDb()
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.id, versionId), eq(fileVersions.fileId, fileId)))
    .limit(1);
  if (!v) throw new HttpError("NOT_FOUND", "Version not found.");
  return v;
}

export async function listVersions(fileId: string): Promise<VersionInfo[]> {
  const rows = await getDb().select().from(fileVersions).where(eq(fileVersions.fileId, fileId)).orderBy(desc(fileVersions.versionNo));
  return rows.map(toVersionInfo);
}

export const toVersionInfo = (v: FileVersionRow): VersionInfo => ({
  id: v.id,
  versionNo: v.versionNo,
  source: v.source,
  sizeBytes: v.sizeBytes,
  pageCount: v.pageCount,
  createdAt: v.createdAt.toISOString(),
});

export function toSummary(f: FileRow, v: FileVersionRow | null, hasDraft: boolean): FileSummary {
  return {
    id: f.id,
    name: f.name,
    status: f.status,
    pageCount: v?.pageCount ?? null,
    sizeBytes: v?.sizeBytes ?? null,
    currentVersionId: f.currentVersionId,
    hasDraft,
    expiresAt: f.expiresAt?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export async function hasDraft(fileId: string, userId: string): Promise<boolean> {
  const [d] = await getDb()
    .select({ id: editDrafts.id })
    .from(editDrafts)
    .where(and(eq(editDrafts.fileId, fileId), eq(editDrafts.userId, userId)))
    .limit(1);
  return !!d;
}

/** Make a user-supplied file name safe to store and show. */
export function cleanName(name: string): string {
  const n = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200) || "document.pdf";
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}
