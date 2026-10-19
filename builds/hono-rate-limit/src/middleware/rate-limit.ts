import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Window length in milliseconds (default 60 000). */
  windowMs?: number;
  /** Requests allowed per key per window (default 60). */
  limit?: number;
  /** How to identify a client. Defaults to the client IP from common proxy headers. */
  key?: (c: Context) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? forwarded ?? "unknown";
}

/**
 * Fixed-window rate limiter kept in process memory. Responds 429 with Retry-After
 * when a key goes over the limit. Use one instance per route group.
 * For several server instances, put a shared store (e.g. Redis) behind the same interface.
 */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const windowMs = options.windowMs ?? 60_000;
  const limit = options.limit ?? 60;
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
