import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, isNull } from "drizzle-orm";
import { editDrafts, files, getDb, plans, shareLinks, users, type Plan, type User } from "@pdfinkly/db";
import { env } from "./env";
import { HttpError } from "./http";

/**
 * The "actor" is whoever is making the request: a signed-in user, or a guest
 * identified by a signed cookie. Guests are real rows in `users`
 * (is_guest = true), so files, drafts and limits work the same for both.
 */
export interface Actor {
  user: User;
  plan: Plan;
  isGuest: boolean;
}

const GUEST_COOKIE = "pdfinkly_guest";
const GUEST_MAX_AGE = 60 * 60 * 24 * 30;

const mac = (id: string) => createHmac("sha256", env.authSecret).update(`guest:${id}`).digest("base64url");
const signGuest = (id: string) => `${id}.${mac(id)}`;
function verifyGuest(value: string | undefined): string | null {
  if (!value) return null;
  const [id, sig] = value.split(".");
  if (!id || !sig) return null;
  const want = Buffer.from(mac(id));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

const planCache = new Map<string, { plan: Plan; at: number }>();
export async function getPlan(planId: string): Promise<Plan> {
  const hit = planCache.get(planId);
  if (hit && Date.now() - hit.at < 60_000) return hit.plan;
  const [plan] = await getDb().select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) throw new Error(`Plan ${planId} is missing; run migrations`);
  planCache.set(planId, { plan, at: Date.now() });
  return plan;
}

async function loadUser(id: string, guest: boolean): Promise<User | null> {
  const [u] = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.isGuest, guest), isNull(users.deletedAt)))
    .limit(1);
  return u ?? null;
}

export async function getActor(): Promise<Actor | null> {
  const { auth } = await import("./auth");
  const session = await auth();
  const sessionUserId = session?.user?.id;
  if (sessionUserId) {
    const user = await loadUser(sessionUserId, false);
    if (user) return { user, plan: await getPlan(user.planId), isGuest: false };
  }
  const guestId = verifyGuest((await cookies()).get(GUEST_COOKIE)?.value);
  if (guestId) {
    const user = await loadUser(guestId, true);
    if (user) return { user, plan: await getPlan(user.planId), isGuest: true };
  }
  return null;
}

export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw new HttpError("UNAUTHENTICATED", "Sign in or upload a file to start.");
  return actor;
}

/** Signed-in user or existing guest; otherwise create a guest. Route handlers only. */
export async function ensureActor(): Promise<Actor> {
  const existing = await getActor();
  if (existing) return existing;
  const [user] = await getDb().insert(users).values({ isGuest: true }).returning();
  (await cookies()).set(GUEST_COOKIE, signGuest(user!.id), {
    httpOnly: true,
    secure: env.appUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_MAX_AGE,
  });
  return { user: user!, plan: await getPlan(user!.planId), isGuest: true };
}

/** Move a guest's files into the account that just signed in, then retire the guest. */
export async function adoptGuestFiles(userId: string) {
  let jar;
  try {
    jar = await cookies();
  } catch {
    return; // not in a request scope
  }
  const guestId = verifyGuest(jar.get(GUEST_COOKIE)?.value);
  if (!guestId || guestId === userId) return;
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(files).set({ ownerId: userId }).where(eq(files.ownerId, guestId));
    await tx.update(editDrafts).set({ userId }).where(eq(editDrafts.userId, guestId));
    await tx.update(shareLinks).set({ createdBy: userId }).where(eq(shareLinks.createdBy, guestId));
    await tx.update(users).set({ deletedAt: new Date() }).where(and(eq(users.id, guestId), eq(users.isGuest, true)));
  });
  jar.delete(GUEST_COOKIE);
}
