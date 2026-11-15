// Applies migrations/*.sql in order, once each, all in one transaction.
//
//   DATABASE_URL=... node scripts/migrate.mjs           local / manual
//   node scripts/migrate.mjs --vercel                   from the Vercel build (prebuild)
//
// With --vercel it runs only for production builds (VERCEL_ENV=production), so a
// preview build of a feature branch can never change the production schema.
// Prefers the direct (unpooled) connection, which Neon's Vercel integration sets
// as DATABASE_URL_UNPOOLED; falls back to DATABASE_URL.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const onVercel = process.argv.includes("--vercel");
if (onVercel && process.env.VERCEL_ENV !== "production") {
  console.log(`[migrate] skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}); migrations run on production builds only`);
  process.exit(0);
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set" + (onVercel ? " — connect a database to this Vercel project" : ""));
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 20 });

try {
  const applied = await sql.begin(async (tx) => {
    // Two deploys at once must not both apply the same migration.
    await tx`SELECT pg_advisory_xact_lock(727274)`;
    await tx`CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx`SELECT name FROM _migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const ran = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(await readFile(path.join(dir, f), "utf8"));
      await tx`INSERT INTO _migrations (name) VALUES (${f})`;
      ran.push(f);
    }
    return ran;
  });
  for (const f of applied) console.log(`[migrate] applied ${f}`);
  console.log("[migrate] migrations up to date");
} catch (err) {
  console.error("[migrate] failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
