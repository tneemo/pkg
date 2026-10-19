import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

export interface RateLimitOptions {
  /** Window length in milliseconds (default 60 000). */
  windowMs?: number;
  /** Requests allowed per key per window (default 60). */
  limit?: number;
  /** How to identify a client. Defaults to the Node adapter's socket peer address. */
  key?: (c: Context) => string;
  /** Maximum active keys before new identities fail closed (default 10,000). */
  maxKeys?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

function clientIp(c: Context): string {
  try { return getConnInfo(c).remote.address ?? "unknown"; }
  catch { return "unknown"; }
}

/**
 * Fixed-window rate limiter kept in process memory. Responds 429 with Retry-After
 * when a key goes over the limit. Use one instance per route group.
 * For several server instances, put a shared store (e.g. Redis) behind the same interface.
 */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const windowMs = options.windowMs ?? 60_000;
  const limit = options.limit ?? 60;
  const maxKeys = options.maxKeys ?? 10_000;
  if (![windowMs, limit, maxKeys].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("rate limit options must be positive integers");
  const keyOf = options.key ?? clientIp;
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      lastSweep = now;
    }
    const key = keyOf(c);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= maxKeys) {
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
        if (buckets.size >= maxKeys) {
          c.header("Retry-After", String(Math.ceil(windowMs / 1000)));
          return c.json({ error: "Rate limiter capacity exceeded" }, 429);
        }
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    const remaining = Math.max(0, limit - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    c.header("RateLimit-Limit", String(limit));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(resetSeconds));
    if (bucket.count > limit) {
      c.header("Retry-After", String(resetSeconds));
      return c.json({ error: "Too many requests" }, 429);
    }
    await next();
  };
}
