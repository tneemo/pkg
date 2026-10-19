import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Applies every *.sql file in `dir` that has not been applied yet, in file-name order.
 * Name files `<UTC timestamp>_<description>.sql`, e.g. `20261019120000_todos.sql`.
 */
export function migrate(db: DatabaseSync, dir = process.env.MIGRATIONS_DIR ?? "db/migrations"): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  if (!existsSync(dir)) return [];
  const applied = new Set(db.prepare("SELECT name FROM _migrations").all().map((row) => String(row.name)));
  const pending = readdirSync(dir).filter((f) => f.endsWith(".sql") && !applied.has(f)).sort();
  for (const name of pending) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
    }
  }
  return pending;
}
