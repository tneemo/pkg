# hono-rate-limit

Rate limiting middleware for [Hono](https://hono.dev), for Node.js using `@hono/node-server`.

- Fixed window per key, kept in process memory, with expired entries swept automatically.
- Sends `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers on every response, and `Retry-After` with a JSON `429` when the limit is exceeded.
- Keys default to the socket peer address from the Node adapter. Forwarded headers are ignored; pass `key` to limit per user or API key instead.

Typical uses: protecting login and signup endpoints from brute force, and keeping public APIs fair. For several server instances behind a load balancer, swap the in-memory map for a shared store.

The map is bounded by `maxKeys` (default 10,000) and fails closed for new keys at capacity. Without adapter connection information requests share the `unknown` bucket. For other runtimes supply a trusted `key` function. Only read forwarded headers in that function when your immediate peer is a verified trusted proxy that overwrites them and the origin is isolated. This in-memory limiter is per process; multi-instance deployments require a shared-store limiter.
