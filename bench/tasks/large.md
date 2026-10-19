Build a TypeScript REST API for a personal bookmarks service in the current directory (it is empty). Use Node.js 22.

Users sign up and log in, and each user only sees and changes their own bookmarks.

API (JSON in and out):
- `GET /health` returns 200.
- `POST /auth/register` `{ "email", "password" }` creates an account and returns 201. Invalid email or a password shorter than 8 characters gets 400; an email that is already registered gets 409.
- `POST /auth/login` `{ "email", "password" }` returns 200 `{ "token": "<token>" }`; wrong credentials get 401.
- Brute-force protection: after 10 login attempts within one minute from the same client IP, further login attempts get 429 until the minute has passed.
- Every `/bookmarks` and `/tags` route requires `Authorization: Bearer <token>` (otherwise 401):
  - `POST /bookmarks` `{ "url", "title", "tags"?: string[] }` returns 201 with the bookmark `{ "id", "url", "title", "tags", "createdAt" }`. `url` must be an absolute http or https URL and `title` must be non-empty, otherwise 400. Tags are stored lower-cased and without duplicates.
  - `GET /bookmarks` returns 200 `{ "items": [...], "total": <number> }`, newest first. Query parameters, all optional and combinable: `tag` (only bookmarks with that tag), `q` (case-insensitive substring match on title or url), `limit` (default 20, at most 100; invalid values get 400) and `offset` (default 0). `total` counts all matches, ignoring `limit` and `offset`.
  - `GET /bookmarks/:id` returns 200 with the bookmark.
  - `PATCH /bookmarks/:id` `{ "url"?, "title"?, "tags"? }` returns 200 with the updated bookmark, validated like `POST`.
  - `DELETE /bookmarks/:id` returns 204.
  - A bookmark that does not exist or belongs to another user gets 404.
  - `GET /tags` returns 200 with `[{ "tag", "count" }]` for the caller's bookmarks, sorted by count descending, then tag ascending.

Configuration and running:
- Store data in SQLite at the path in the `DATABASE_PATH` environment variable, so data survives restarts.
- Read the token signing secret from the `JWT_SECRET` environment variable.
- Leave dependencies installed. `npm start` must start the API on the port in the `PORT` environment variable (default 3000) with no other command needed.
- Write automated tests. `npm test` must pass.

Do not ask me questions; make reasonable decisions. When you are done, briefly summarize what you built.
