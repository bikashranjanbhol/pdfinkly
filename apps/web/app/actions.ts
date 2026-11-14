"use server";

import { signIn, signOut } from "@/lib/server/auth";

export async function signInWith(provider: "google" | "github") {
  await signIn(provider, { redirectTo: "/files" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
