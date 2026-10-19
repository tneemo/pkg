# hono-auth

Email and password accounts for [Hono](https://hono.dev) APIs.

- `POST /register` `{ email, password }` creates an account and returns `{ user, token }` (201).
- `POST /login` `{ email, password }` returns `{ user, token }`.
- `GET /me` with `Authorization: Bearer <token>` returns the current user.
- `requireAuth` middleware protects any route and exposes `c.get("user")` (`{ id, email }`), typed via `AuthEnv`.

Passwords are hashed with scrypt (Node's crypto, no native modules) and compared in constant time. Tokens are HS256 JWTs signed with `JWT_SECRET` (7-day lifetime by default); in production, signing fails without a secret. Emails are normalized to lower case and unique.

Stores users in SQLite through `tneemo/sqlite-db`, which is installed automatically along with the `users` table migration.
