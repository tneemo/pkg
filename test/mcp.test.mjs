// End-to-end test of the MCP server against a running registry.
// Start one first (npm run dev), then: PKG_REGISTRY=http://127.0.0.1:8787 npm test
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const registry = process.env.PKG_REGISTRY ?? "http://127.0.0.1:8787";
const cli = fileURLToPath(new URL("../cli/dist/pkg.js", import.meta.url));
const reachable = await fetch(`${registry}/api/search?q=`).then((r) => r.ok).catch(() => false);

test("MCP: agent discovers and installs builds", { skip: !reachable && `no registry at ${registry}` }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-mcp-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: dir, env: { ...process.env, PKG_REGISTRY: registry } });
  const client = new Client({ name: "pkg-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    assert.match(client.getInstructions() ?? "", /before writing code from scratch/i);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["detect_stack", "get_build", "install_builds", "publish_build", "report_outcome", "search_builds"]);

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
