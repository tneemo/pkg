import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getDb, migrate, transaction } from "../src/db";

describe("db", () => {
  it("applies migrations once, in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrations-"));
    writeFileSync(join(dir, "20260102000000_b.sql"), "INSERT INTO t (v) VALUES ('b');");
    writeFileSync(join(dir, "20260101000000_a.sql"), "CREATE TABLE t (v TEXT);");
    const db = new DatabaseSync(":memory:");
    expect(migrate(db, dir)).toEqual(["20260101000000_a.sql", "20260102000000_b.sql"]);
    expect(migrate(db, dir)).toEqual([]);
    expect(db.prepare("SELECT v FROM t").all()).toEqual([{ v: "b" }]);
  });

  it("rolls back failed transactions", () => {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS items (name TEXT NOT NULL)");
    expect(() =>
      transaction((tx) => {
        tx.prepare("INSERT INTO items (name) VALUES (?)").run("kept?");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
  });
});
