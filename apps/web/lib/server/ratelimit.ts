import "server-only";
import { HttpError } from "./http";

/**
 * Fixed-window rate limit. Uses Upstash Redis (REST) when configured so limits
 * hold across serverless instances; falls back to per-instance memory in dev.
 */
const memory = new Map<string, { count: number; resetAt: number }>();

async function hit(key: string, windowSec: number): Promise<{ count: number; ttl: number }> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(windowSec), "NX"],
        ["TTL", key],
      ]),
      cache: "no-store",
    });
    if (res.ok) {
      const [incr, , ttl] = (await res.json()) as { result: number }[];
      return { count: incr!.result, ttl: Math.max(ttl!.result, 1) };
    }
    // Redis unavailable: fail open rather than block every request.
    return { count: 0, ttl: windowSec };
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { count: 1, ttl: windowSec };
  }
  entry.count++;
  return { count: entry.count, ttl: Math.ceil((entry.resetAt - now) / 1000) };
}

export async function rateLimit(bucket: string, id: string, max: number, windowSec: number) {
  const { count, ttl } = await hit(`rl:${bucket}:${id}`, windowSec);
  if (count > max) {
    throw new HttpError("RATE_LIMITED", "Too many requests. Please wait a moment.", undefined, { "Retry-After": String(ttl) });
  }
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
