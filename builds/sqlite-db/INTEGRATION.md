1. Use the database anywhere on the server:
   ```ts
   import { getDb } from "../db"; // path relative to your file; the module lives in src/db
   const rows = getDb().prepare("SELECT * FROM todos WHERE user_id = ?").all(userId);
   ```
   `node:sqlite` statements are synchronous: `.run(...)`, `.get(...)`, `.all(...)`. Use `RETURNING *` with `.get()` to read back inserted rows.
2. Add tables with a new file in `db/migrations/` named `<UTC timestamp>_<name>.sql`, e.g. `db/migrations/20261019120000_todos.sql`. It runs automatically on the next `getDb()` call.
3. The database file is `data/app.db` by default (set `DATABASE_PATH` to change it). Make sure `data/` is in `.gitignore`. Tests use an in-memory database automatically.
