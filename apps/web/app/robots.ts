import type { MetadataRoute } from "next";

/** Index the marketing pages only; files, shares and the editor stay out of search. */
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    rules: { userAgent: "*", allow: ["/", "/pricing"], disallow: ["/api/", "/edit/", "/s/", "/files", "/account", "/upload", "/signin"] },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
