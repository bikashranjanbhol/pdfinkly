import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export type Db = PostgresJsDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __pdfinklyDb?: Db; __pdfinklySql?: ReturnType<typeof postgres> };

/**
 * One pooled client per server instance. On Vercel, point DATABASE_URL at a
 * pooled connection string (Neon/Supabase pooler); `prepare: false` keeps it
 * compatible with transaction-mode poolers.
 */
export function getDb(): Db {
  if (!globalForDb.__pdfinklyDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const sql = postgres(url, { max: Number(process.env.DATABASE_POOL_MAX ?? 5), prepare: false, onnotice: () => {} });
    globalForDb.__pdfinklySql = sql;
    globalForDb.__pdfinklyDb = drizzle(sql, { schema });
  }
  return globalForDb.__pdfinklyDb;
}
