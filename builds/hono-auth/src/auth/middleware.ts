import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { verifyToken, type TokenUser } from "./token";

export type AuthUser = TokenUser;

/** Use as `new Hono<AuthEnv>()` so `c.get("user")` is typed. */
export type AuthEnv = { Variables: { user: AuthUser } };

/** Requires `Authorization: Bearer <token>`; sets c.get("user"). */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HTTPException(401, { message: "Missing bearer token" });
  let user: AuthUser;
  try {
    user = await verifyToken(token);
  } catch {
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }
  c.set("user", user);
  await next();
});
