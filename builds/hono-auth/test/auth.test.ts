import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { authRoutes, requireAuth, type AuthEnv } from "../src/auth";

const app = new Hono<AuthEnv>();
app.route("/auth", authRoutes);
app.get("/private", requireAuth, (c) => c.json({ email: c.get("user").email }));

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("auth", () => {
  it("registers, logs in and authorizes requests", async () => {
    const reg = await post("/auth/register", { email: "Ada@Example.com", password: "correct horse" });
    expect(reg.status).toBe(201);
    const { user } = (await reg.json()) as { user: { email: string } };
    expect(user.email).toBe("ada@example.com");

    const login = await post("/auth/login", { email: "ada@example.com", password: "correct horse" });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };

    const me = await app.request("/auth/me", { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    const priv = await app.request("/private", { headers: { authorization: `Bearer ${token}` } });
    expect(await priv.json()).toEqual({ email: "ada@example.com" });
  });

  it("rejects duplicates, bad passwords and missing tokens", async () => {
    await post("/auth/register", { email: "bob@example.com", password: "password123" });
    expect((await post("/auth/register", { email: "bob@example.com", password: "password123" })).status).toBe(409);
    expect((await post("/auth/login", { email: "bob@example.com", password: "wrong-password" })).status).toBe(401);
    expect((await post("/auth/register", { email: "not-an-email", password: "password123" })).status).toBe(400);
    expect((await app.request("/private")).status).toBe(401);
    expect((await app.request("/private", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });
});
