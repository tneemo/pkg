# sqlite-db

SQLite for Node.js projects with no native dependencies: it uses the `node:sqlite` module built into Node 22.13+.

- `getDb()` returns one shared `DatabaseSync` connection, opened on first use with foreign keys on and WAL mode.
- SQL migrations live in `db/migrations/` as plain `.sql` files and are applied automatically, once each, in file-name order. Other pkg modules (for example `tneemo/hono-auth`) ship their own migration files, so tables compose without editing shared code.
- `transaction(fn)` wraps work in BEGIN/COMMIT with rollback on error.
- Tests (`NODE_ENV=test`) automatically use a fresh in-memory database.

Good fit for prototypes, internal tools and small services. When you outgrow it, the SQL carries over to Postgres with few changes.
