// End-to-end test of the MCP server against a running registry.
// Start one first (npm run dev), then: PKG_REGISTRY=http://127.0.0.1:8787 npm test
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const registry = process.env.PKG_REGISTRY ?? "http://127.0.0.1:8787";
const cli = fileURLToPath(new URL("../cli/dist/pkg.js", import.meta.url));
const reachable = await fetch(`${registry}/api/search?q=`).then((r) => r.ok).catch(() => false);
const skip = !reachable && `no registry at ${registry}`;
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function connect(dir) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: dir, env: { ...process.env, PKG_REGISTRY: registry } });
  const client = new Client({ name: "pkg-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Calls a tool that must succeed and returns its text. */
async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, res.content[0].text);
  return res.content[0].text;
}

test("MCP: agent discovers and installs builds", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-mcp-"));
  const client = await connect(dir);
  try {
    assert.match(client.getInstructions() ?? "", /before writing code from scratch/i);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["detect_stack", "get_build", "install_builds", "publish_build", "remove_builds", "report_outcome", "search_builds", "update_builds"]);

    const search = await client.callTool({ name: "search_builds", arguments: { query: "user accounts login", stack: ["typescript", "hono"] } });
    const text = search.content[0].text;
    assert.match(text, /tneemo\/hono-auth/);

    const install = await client.callTool({ name: "install_builds", arguments: { builds: ["tneemo/hono-api", "tneemo/hono-auth"], skip_install: true } });
    assert.ok(!install.isError, install.content[0].text);
    assert.match(install.content[0].text, /tneemo\/sqlite-db@1\.\d+\.\d+ \(module\) — required by tneemo\/hono-auth/);
    assert.ok(existsSync(join(dir, "src/auth/routes.ts")));
    assert.ok(existsSync(join(dir, "db/migrations/20260101000000_auth_users.sql")));
    const lock = JSON.parse(readFileSync(join(dir, "pkg.lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.builds).sort(), ["tneemo/hono-api", "tneemo/hono-auth", "tneemo/sqlite-db"]);

    const detect = await client.callTool({ name: "detect_stack", arguments: {} });
    assert.match(detect.content[0].text, /hono/);

    // Installing a Python module into this TypeScript project is refused with a clear reason.
    const wrong = await client.callTool({ name: "install_builds", arguments: { builds: ["tneemo/fastapi-api-key"], skip_install: true } });
    assert.ok(wrong.isError);
    assert.match(wrong.content[0].text, /needs fastapi/);
  } finally {
    await client.close();
  }
});

test("MCP: update and remove never touch edited files", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-update-"));
  const client = await connect(dir);
  const file = (p) => join(dir, p);
  const lockPath = file("pkg.lock.json");
  try {
    await call(client, "install_builds", { builds: ["tneemo/hono-api", "tneemo/hono-auth"], skip_install: true });
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const auth = lock.builds["tneemo/hono-auth"];
    const current = auth.version;
    assert.deepEqual(auth.builds, { "tneemo/sqlite-db": "^1.0.0" });

    // Pretend an older hono-auth is installed and the user has worked on the project since.
    auth.version = "0.9.0";
    writeFileSync(file("src/auth/routes.ts"), readFileSync(file("src/auth/routes.ts"), "utf8") + "\n// my change\n");
    writeFileSync(file("src/auth/token.ts"), "// token.ts as 0.9.0 shipped it\n");
    auth.files["src/auth/token.ts"] = sha256("// token.ts as 0.9.0 shipped it\n");
    writeFileSync(file("src/auth/legacy.ts"), "// only in 0.9.0\n");
    auth.files["src/auth/legacy.ts"] = sha256("// only in 0.9.0\n");
    writeFileSync(file("src/auth/notes.ts"), "// only in 0.9.0, edited\n");
    auth.files["src/auth/notes.ts"] = sha256("// only in 0.9.0\n");
    rmSync(file("test/auth.test.ts"));
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));

    const updated = await call(client, "update_builds", { builds: ["tneemo/hono-auth"], latest: true, skip_install: true });
    assert.match(updated, new RegExp(`## tneemo/hono-auth@${current.replaceAll(".", "\\.")} \\(module, was 0\\.9\\.0\\)`));
    assert.match(updated, /CONFLICTS \(left untouched\): .*src\/auth\/routes\.ts/);
    assert.match(updated, /test\/auth\.test\.ts \(deleted locally\)/);
    assert.match(updated, /deleted \(no longer in the build\): src\/auth\/legacy\.ts/);
    assert.match(updated, /KEPT \(no longer in the build, edited locally\): src\/auth\/notes\.ts/);
    assert.match(updated, /tneemo\/sqlite-db@\S+: skipped \(up to date\)/);
    assert.match(readFileSync(file("src/auth/routes.ts"), "utf8"), /\/\/ my change/);
    assert.notEqual(readFileSync(file("src/auth/token.ts"), "utf8"), "// token.ts as 0.9.0 shipped it\n");
    assert.ok(!existsSync(file("src/auth/legacy.ts")));
    assert.ok(existsSync(file("src/auth/notes.ts")));
    assert.ok(!existsSync(file("test/auth.test.ts")));

    const entry = JSON.parse(readFileSync(lockPath, "utf8")).builds["tneemo/hono-auth"];
    assert.equal(entry.version, current);
    assert.equal(entry.files["src/auth/token.ts"], sha256(readFileSync(file("src/auth/token.ts"))));
    assert.notEqual(entry.files["src/auth/routes.ts"], sha256(readFileSync(file("src/auth/routes.ts"))), "the edit still counts as an edit");
    assert.ok(!("src/auth/legacy.ts" in entry.files) && !("src/auth/notes.ts" in entry.files));

    assert.match(await call(client, "update_builds", {}), /is up to date/);

    const refused = await client.callTool({ name: "remove_builds", arguments: { builds: ["tneemo/sqlite-db"] } });
    assert.ok(refused.isError);
    assert.match(refused.content[0].text, /tneemo\/hono-auth depends on tneemo\/sqlite-db/);

    const removed = await call(client, "remove_builds", { builds: ["tneemo/hono-auth"] });
    assert.match(removed, /KEPT: .*src\/auth\/routes\.ts \(edited\)/);
    assert.match(removed, /pkg remove tneemo\/sqlite-db/);
    assert.ok(existsSync(file("src/auth/routes.ts")));
    assert.ok(!existsSync(file("src/auth/token.ts")));
    assert.ok(!existsSync(file("db/migrations/20260101000000_auth_users.sql")));
    assert.ok(existsSync(file("src/db/index.ts")));
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(lockPath, "utf8")).builds).sort(), ["tneemo/hono-api", "tneemo/sqlite-db"]);
  } finally {
    await client.close();
  }
});
