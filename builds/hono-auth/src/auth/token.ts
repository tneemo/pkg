import { sign, verify } from "hono/jwt";

const DEV_SECRET = "insecure-development-secret";

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("JWT_SECRET must be set in production");
  return DEV_SECRET;
}

export interface TokenUser {
  id: number;
  email: string;
}

export async function issueToken(user: TokenUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7);
  return sign({ sub: String(user.id), email: user.email, iat: now, exp: now + ttl }, secret(), "HS256");
}

/** Throws if the token is invalid or expired. */
export async function verifyToken(token: string): Promise<TokenUser> {
  const payload = await verify(token, secret(), "HS256");
  return { id: Number(payload.sub), email: String(payload.email) };
}
