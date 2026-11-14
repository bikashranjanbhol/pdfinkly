import "server-only";

/** Read lazily so `next build` works without runtime secrets. */
export const env = {
  get appUrl() {
    return (process.env.APP_URL ?? process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  },
  get authSecret() {
    const s = process.env.AUTH_SECRET;
    if (!s) throw new Error("AUTH_SECRET is not set");
    return s;
  },
  get storageDriver(): "s3" | "local" {
    return process.env.STORAGE_DRIVER === "s3" ? "s3" : "local";
  },
  google: () => (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET ? true : false),
  github: () => (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET ? true : false),
};
