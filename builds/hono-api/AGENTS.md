# Conventions

- The Hono app is assembled in `src/app.ts` (`createApp`). Mount feature routers there: `app.route("/todos", todoRoutes)`.
- Put each feature in its own folder under `src/` (for example `src/todos/routes.ts`) exporting a `new Hono()` router.
- Validate request bodies with zod: `schema.parse(await c.req.json())`. Validation errors become 400 responses automatically.
- Throw `HTTPException` from `hono/http-exception` for expected errors (404, 409, ...). Responses are JSON: `{ "error": "..." }`.
- Declare environment variables in `src/env.ts`; document them in `.env.example`.
- Tests live in `test/` and use `app.request(path, init)`, no running server needed. Run `npm test`.
- Builds installed with pkg are listed in `pkg.lock.json`. Look for existing ones before writing a common feature: `npx -y @tneemo/pkg search "<need>"`.
