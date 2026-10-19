This is a foundation: it creates the project. After installing:

1. `npm test` should pass and `npm run dev` serves on http://localhost:3000 (`GET /health`).
2. Add features as routers in `src/<feature>/routes.ts` and mount them in `createApp()` in `src/app.ts` with `app.route("/<feature>", routes)`.
3. Follow `AGENTS.md` for validation, errors, env vars and tests.
