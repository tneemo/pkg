// Exercise the files users receive, rather than only the monorepo source.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli/dist/pkg.js", import.meta.url));
const owner = process.env.PKG_EXAMPLE_OWNER ?? "tneemo";
const root = mkdtempSync(join(tmpdir(), "pkg-assembly-"));
const run = (command, args, cwd) => {
  const res = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env, shell: process.platform === "win32" && command.endsWith(".cmd") });
  console.log(res.stdout ?? "");
  assert.equal(res.status, 0, `${command}: ${res.stderr ?? res.error}`);
};
try {
  const node = join(root, "node");
  run(process.execPath, [cli, "add", `${owner}/hono-api`, `${owner}/hono-auth`, `${owner}/hono-rate-limit`, "--dir", node, "--install-deps"], root);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["test"], node);
  run(npm, ["run", "typecheck"], node);
  const python = join(root, "python");
  run(process.execPath, [cli, "add", `${owner}/fastapi-service`, `${owner}/fastapi-api-key`, "--dir", python, "--install-deps"], root);
  run(join(python, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"), ["-m", "pytest", "-q"], python);
  console.log("Both assembled application suites passed.");
} finally { rmSync(root, { recursive: true, force: true }); }
