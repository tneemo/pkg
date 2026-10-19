// Verify a packed CLI in a fresh isolated HOME, including both bins and MCP startup.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Accept a tarball path or an explicit public package version after release.
let artifact = process.argv[2];
if (!artifact) throw new Error("usage: node scripts/release-smoke.mjs <tarball|@tneemo/pkg@version>");
const dir = mkdtempSync(join(tmpdir(), "pkg-release-"));
const home = join(dir, "home"); mkdirSync(home);
mkdirSync(join(home, ".cursor")); mkdirSync(join(home, ".codex"));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
if (artifact === "--pack") {
  const pack = spawnSync(npm, ["pack", "--workspace", "cli", "--ignore-scripts", "--json", "--pack-destination", dir], { encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(pack.status, 0, pack.stderr);
  artifact = join(dir, JSON.parse(pack.stdout)[0].filename);
}
const install = spawnSync(npm, ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", artifact.startsWith("@") ? artifact : resolve(artifact)], { encoding: "utf8", shell: process.platform === "win32", env });
try {
  assert.equal(install.status, 0, install.stderr);
  const root = join(dir, "node_modules", "@tneemo", "pkg");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.bin).sort(), ["pkg", "tpkg"]);
  for (const bin of ["pkg", "tpkg"]) {
    const command = join(dir, "node_modules", ".bin", bin + (process.platform === "win32" ? ".cmd" : ""));
    const run = spawnSync(command, ["help"], { cwd: home, env, encoding: "utf8", shell: process.platform === "win32" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /search|Discover/);
  }
  const entry = join(root, pkg.bin.pkg);
  const setup = spawnSync(process.execPath, [entry, "setup", "--no-skill"], { cwd: home, env: { ...env, PATH: home }, encoding: "utf8" });
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.pkg);
  assert.match(readFileSync(join(home, ".codex", "config.toml"), "utf8"), /mcp_servers.pkg/);
  const { StdioClientTransport: Transport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "release-smoke", version: "1" });
  try {
    await client.connect(new Transport({ command: process.execPath, args: [entry, "mcp"], cwd: home, env }));
    assert.ok((await client.listTools()).tools.some((t) => t.name === "install_builds"));
  } finally { await client.close(); }
  console.log(`Release smoke passed: ${pkg.name}@${pkg.version} (pkg, tpkg, setup, MCP)`);
} finally { rmSync(dir, { recursive: true, force: true }); }
