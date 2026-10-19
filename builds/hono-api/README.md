# hono-api

A small, production-minded starting point for a JSON REST API in TypeScript on Node.js, built on [Hono](https://hono.dev).

What you get:

- `src/app.ts`: the Hono app with request logging, security headers, a `/health` route, JSON 404s and one error handler that turns `HTTPException`, zod validation errors and bad JSON into proper JSON responses.
- `src/env.ts`: environment variables validated with zod, `.env` loaded automatically.
- `src/index.ts`: the Node server (`npm run dev` with reload, `npm start`).
- `test/`: vitest tests that call the app in-process with `app.request()`.
- `AGENTS.md`: the project conventions, so coding agents extend it consistently.

Pairs well with `tneemo/sqlite-db` (database), `tneemo/hono-auth` (accounts and JWT) and `tneemo/hono-rate-limit`.

Requires Node.js 22.12 or newer.
