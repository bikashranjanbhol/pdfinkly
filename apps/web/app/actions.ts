"use server";

import { signIn, signOut } from "@/lib/server/auth";

/** Only same-site paths, so the redirect can't be pointed elsewhere. */
const safeNext = (next?: string) => (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/files");

export async function signInWith(provider: "google" | "github", next?: string) {
  await signIn(provider, { redirectTo: safeNext(next) });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
