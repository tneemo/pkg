import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate";

let instance: DatabaseSync | undefined;

/** DATABASE_PATH, or data/app.db; tests (NODE_ENV=test) get a fresh in-memory database. */
export function databasePath(): string {
  return process.env.DATABASE_PATH ?? (process.env.NODE_ENV === "test" ? ":memory:" : "data/app.db");
}

/** The shared connection. Opened on first use, with pending migrations applied. */
export function getDb(): DatabaseSync {
  if (!instance) {
    const path = databasePath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    migrate(db);
    instance = db;
  }
  return instance;
}

/** Runs fn in a transaction; rolls back if it throws. */
export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function closeDb(): void {
  instance?.close();
  instance = undefined;
}

export { migrate };
