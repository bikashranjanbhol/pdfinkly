import "server-only";
import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { accounts, getDb, sessions, users, verificationTokens } from "@pdfinkly/db";
import { env } from "./env";
import { adoptGuestFiles } from "./actor";

export function configuredProviders(): { id: "google" | "github"; name: string }[] {
  const list: { id: "google" | "github"; name: string }[] = [];
  if (env.google()) list.push({ id: "google", name: "Google" });
  if (env.github()) list.push({ id: "github", name: "GitHub" });
  return list;
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const providers: Provider[] = [];
  if (env.google()) providers.push(Google);
  if (env.github()) providers.push(GitHub);
  return {
    adapter: DrizzleAdapter(getDb(), {
      // Our tables carry extra columns (plan, guest flag, soft delete); the
      // adapter only touches the Auth.js ones.
      usersTable: users as never,
      accountsTable: accounts as never,
      sessionsTable: sessions as never,
      verificationTokensTable: verificationTokens as never,
    }),
    providers,
    session: { strategy: "database", maxAge: 30 * 24 * 60 * 60 },
    pages: { signIn: "/signin" },
    trustHost: true,
    events: {
      // Files a guest edited before signing in move into the account.
      async signIn({ user }) {
        if (user.id) await adoptGuestFiles(user.id);
      },
    },
  };
});
