1. Mount the routes where the Hono app is created (`src/app.ts` in `tneemo/hono-api`):
   ```ts
   import { authRoutes } from "./auth";
   app.route("/auth", authRoutes);
   ```
   This adds `POST /auth/register`, `POST /auth/login` and `GET /auth/me`.
2. Protect your own routes and read the signed-in user:
   ```ts
   import { Hono } from "hono";
   import { requireAuth, type AuthEnv } from "../auth";

   export const todoRoutes = new Hono<AuthEnv>();
   todoRoutes.use(requireAuth);
   todoRoutes.get("/", (c) => {
     const { id } = c.get("user"); // the signed-in user's id
     // ...
   });
   ```
3. Reference users from your own tables with `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE` in a new migration in `db/migrations/`.
4. Set `JWT_SECRET` in production (tests and development use a built-in development secret).
