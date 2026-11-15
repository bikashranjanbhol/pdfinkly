import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, scanHandoffPages, scanHandoffs } from "@pdfinkly/db";
import type { Actor } from "./actor";
import { env } from "./env";
import { HttpError } from "./http";
import { storage } from "./storage";

/**
 * Scanning with a phone for a computer. The computer gets a one-time token
 * (shown as a QR code); with it, the phone can add finished pages and nothing
 * else. The computer picks the pages up, which deletes them.
 */

const CONNECT_MS = 15 * 60_000; // the code works for 15 minutes…
const LIFETIME_MS = 60 * 60_000; // …extended while the phone is in use, up to an hour
export const MAX_PAGES = 60;
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const expired = () => new HttpError("NOT_FOUND", "This scan link has expired or was closed. Make a new QR code on your computer.");
const keyFor = (handoffId: string, pageId: string) => `scan-handoffs/${handoffId}/${pageId}.jpg`;

export async function createHandoff(actor: Actor) {
  await removeStaleHandoffs(20);
  const token = randomBytes(24).toString("base64url");
  const [row] = await getDb()
    .insert(scanHandoffs)
    .values({ userId: actor.user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + CONNECT_MS) })
    .returning();
  return { id: row!.id, url: `${env.appUrl}/scan/phone/${token}`, expiresAt: row!.expiresAt.toISOString() };
}

/** The live handoff behind a phone's token, or null. */
export async function handoffForToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await getDb()
    .select()
    .from(scanHandoffs)
    .where(and(eq(scanHandoffs.tokenHash, hash(token)), isNull(scanHandoffs.closedAt), gt(scanHandoffs.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

/** The phone is here: note it, and keep the link alive while it's used (never past an hour). */
export async function touchFromPhone(token: string) {
  const h = await handoffForToken(token);
  if (!h) throw expired();
  const until = new Date(Math.min(h.createdAt.getTime() + LIFETIME_MS, Math.max(h.expiresAt.getTime(), Date.now() + CONNECT_MS)));
  await getDb().update(scanHandoffs).set({ phoneSeenAt: new Date(), expiresAt: until }).where(eq(scanHandoffs.id, h.id));
  return { ...h, expiresAt: until };
}

export async function addPage(token: string, p: { width: number; height: number; sizeBytes: number }) {
  const h = await touchFromPhone(token);
  if (p.sizeBytes > MAX_PAGE_BYTES) throw new HttpError("FILE_TOO_LARGE", "That page is too large to send.");
  const db = getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(scanHandoffPages).where(eq(scanHandoffPages.handoffId, h.id));
  if (Number(n) >= MAX_PAGES) throw new HttpError("VALIDATION_FAILED", `You can send up to ${MAX_PAGES} pages at a time.`);
  const [{ seq } = { seq: 0 }] = await db
    .select({ seq: sql<number>`coalesce(max(${scanHandoffPages.seq}), 0)` })
    .from(scanHandoffPages)
    .where(eq(scanHandoffPages.handoffId, h.id));
  const id = crypto.randomUUID();
  const key = keyFor(h.id, id);
  await db.insert(scanHandoffPages).values({ id, handoffId: h.id, seq: Number(seq) + 1, storageKey: key, ...p });
  return { pageId: id, upload: await storage().presignPut(key, p.sizeBytes, "image/jpeg") };
}

export async function completePage(token: string, pageId: string) {
  const h = await touchFromPhone(token);
  const db = getDb();
  const [page] = await db
    .select()
    .from(scanHandoffPages)
    .where(and(eq(scanHandoffPages.id, pageId), eq(scanHandoffPages.handoffId, h.id)))
    .limit(1);
  if (!page) throw new HttpError("NOT_FOUND", "We couldn't find that page.");
  const st = storage();
  const found = await st.head(page.storageKey);
  if (!found) throw new HttpError("UPLOAD_MISSING", "The page didn't arrive. Please try sending again.");
  if (found.size !== page.sizeBytes) throw new HttpError("SIZE_MISMATCH", "The page arrived incomplete. Please try sending again.");
  const start = await st.readStart(page.storageKey, 3);
  if (start[0] !== 0xff || start[1] !== 0xd8 || start[2] !== 0xff) {
    await st.remove([page.storageKey]);
    await db.delete(scanHandoffPages).where(eq(scanHandoffPages.id, page.id));
    throw new HttpError("VALIDATION_FAILED", "That isn't a scanned page.");
  }
  await db.update(scanHandoffPages).set({ ready: true }).where(eq(scanHandoffPages.id, page.id));
  return { ok: true };
}

async function ownHandoff(actor: Actor, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError("NOT_FOUND", "Not found.");
  const [h] = await getDb()
    .select()
    .from(scanHandoffs)
    .where(and(eq(scanHandoffs.id, id), eq(scanHandoffs.userId, actor.user.id)))
    .limit(1);
  if (!h) throw new HttpError("NOT_FOUND", "Not found.");
  return h;
}

/** What the computer sees: whether the phone has opened the link, and the pages ready to pick up. */
export async function handoffStatus(actor: Actor, id: string) {
  const h = await ownHandoff(actor, id);
  const live = !h.closedAt && h.expiresAt > new Date();
  const pages = await getDb()
    .select()
    .from(scanHandoffPages)
    .where(and(eq(scanHandoffPages.handoffId, h.id), eq(scanHandoffPages.ready, true)))
    .orderBy(asc(scanHandoffPages.seq));
  const st = storage();
  return {
    live,
    phoneConnected: !!h.phoneSeenAt,
    expiresAt: h.expiresAt.toISOString(),
    pages: await Promise.all(
      pages.map(async (p) => ({ id: p.id, seq: p.seq, width: p.width, height: p.height, url: await st.presignGet(p.storageKey) })),
    ),
  };
}

/** The computer has the pages: delete them. */
export async function collectPages(actor: Actor, id: string, pageIds: string[]) {
  const h = await ownHandoff(actor, id);
  if (!pageIds.length) return;
  const db = getDb();
  const rows = await db
    .select({ id: scanHandoffPages.id, key: scanHandoffPages.storageKey })
    .from(scanHandoffPages)
    .where(and(eq(scanHandoffPages.handoffId, h.id), inArray(scanHandoffPages.id, pageIds)));
  await storage().remove(rows.map((r) => r.key));
  if (rows.length) await db.delete(scanHandoffPages).where(inArray(scanHandoffPages.id, rows.map((r) => r.id)));
}

/** Stop: the link stops working and anything not picked up is deleted. */
export async function closeHandoff(actor: Actor, id: string) {
  const h = await ownHandoff(actor, id);
  await removeHandoffs([h.id]);
}

async function removeHandoffs(ids: string[]) {
  if (!ids.length) return;
  const db = getDb();
  const keys = (await db.select({ key: scanHandoffPages.storageKey }).from(scanHandoffPages).where(inArray(scanHandoffPages.handoffId, ids))).map(
    (r) => r.key,
  );
  await storage().remove(keys);
  await db.delete(scanHandoffs).where(inArray(scanHandoffs.id, ids));
}

/** Handoffs past their hour (or long expired): delete them and their pages. */
export async function removeStaleHandoffs(limit = 500): Promise<number> {
  const db = getDb();
  const stale = await db
    .select({ id: scanHandoffs.id })
    .from(scanHandoffs)
    .where(or(lt(scanHandoffs.expiresAt, new Date()), lt(scanHandoffs.createdAt, new Date(Date.now() - LIFETIME_MS))))
    .limit(limit);
  await removeHandoffs(stale.map((s) => s.id));
  return stale.length;
}
