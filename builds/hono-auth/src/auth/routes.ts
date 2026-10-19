import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireAuth, type AuthEnv } from "./middleware";
import { hashPassword, verifyPassword } from "./password";
import { issueToken } from "./token";
import { findUserByEmail, findUserById, insertUser } from "./users";

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
});
const loginSchema = z.object({
  email: z.string().trim().toLowerCase(),
  password: z.string(),
});

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const json = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  });
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HTTPException(400, { message: `Invalid request: ${detail}` });
  }
  return parsed.data;
}

/** POST /register, POST /login, GET /me. Mount with app.route("/auth", authRoutes). */
export const authRoutes = new Hono<AuthEnv>()
  .post("/register", async (c) => {
    const { email, password } = await body(c, registerSchema);
    if (findUserByEmail(email)) throw new HTTPException(409, { message: "Email is already registered" });
    const user = insertUser(email, await hashPassword(password));
    return c.json({ user, token: await issueToken(user) }, 201);
  })
  .post("/login", async (c) => {
    const { email, password } = await body(c, loginSchema);
    const row = findUserByEmail(email);
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      throw new HTTPException(401, { message: "Invalid email or password" });
    }
    const user = { id: row.id, email: row.email, created_at: row.created_at };
    return c.json({ user, token: await issueToken(user) });
  })
  .get("/me", requireAuth, (c) => {
    const user = findUserById(c.get("user").id);
    if (!user) throw new HTTPException(401, { message: "Account no longer exists" });
    return c.json({ user });
  });
