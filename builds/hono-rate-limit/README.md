# hono-rate-limit

Rate limiting middleware for [Hono](https://hono.dev), with no dependencies.

- Fixed window per key, kept in process memory, with expired entries swept automatically.
- Sends `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers on every response, and `Retry-After` with a JSON `429` when the limit is exceeded.
- Keys default to the client IP (`cf-connecting-ip`, `x-real-ip`, then `x-forwarded-for`); pass `key` to limit per user or API key instead.

Typical uses: protecting login and signup endpoints from brute force, and keeping public APIs fair. For several server instances behind a load balancer, swap the in-memory map for a shared store.
