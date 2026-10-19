import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimit } from "../src/middleware/rate-limit";

describe("rateLimit", () => {
  it("allows up to the limit, then responds 429 with Retry-After", async () => {
    const app = new Hono();
    app.use(rateLimit({ limit: 2, windowMs: 60_000 }));
    app.get("/", (c) => c.text("ok"));
    const hit = () => app.request("/", { headers: { "x-forwarded-for": "203.0.113.7" } });

    expect((await hit()).status).toBe(200);
    const second = await hit();
    expect(second.status).toBe(200);
    expect(second.headers.get("RateLimit-Remaining")).toBe("0");
    const third = await hit();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("tracks keys separately", async () => {
    const app = new Hono();
    app.use(rateLimit({ limit: 1, key: (c) => c.req.header("x-api-key") ?? "anon" }));
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/", { headers: { "x-api-key": "a" } })).status).toBe(200);
    expect((await app.request("/", { headers: { "x-api-key": "b" } })).status).toBe(200);
    expect((await app.request("/", { headers: { "x-api-key": "a" } })).status).toBe(429);
  });

  it("ignores spoofed proxy headers on direct requests", async () => {
    const app = new Hono();
    app.use(rateLimit({ limit: 1 }));
    app.get("/", (c) => c.text("ok"));
    const hit = (ip: string) => app.request("/", { headers: { "cf-connecting-ip": ip, "x-real-ip": ip, "x-forwarded-for": ip } });
    expect((await hit("203.0.113.1")).status).toBe(200);
    expect((await hit("203.0.113.2")).status).toBe(429);
  });

  it("bounds active keys and fails closed at capacity", async () => {
    const app = new Hono();
    app.use(rateLimit({ limit: 2, maxKeys: 1, key: (c) => c.req.header("x-test-key") ?? "anon" }));
    app.get("/", (c) => c.text("ok"));
    expect((await app.request("/", { headers: { "x-test-key": "a" } })).status).toBe(200);
    expect((await app.request("/", { headers: { "x-test-key": "b" } })).status).toBe(429);
    expect((await app.request("/", { headers: { "x-test-key": "a" } })).status).toBe(200);
  });
});
