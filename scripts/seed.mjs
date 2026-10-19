// Publishes the example builds in builds/ to a registry.
// Usage: PKG_REGISTRY=http://127.0.0.1:8787 PKG_TOKEN=<admin token> node scripts/seed.mjs [owner]
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const owner = process.argv[2] ?? "tneemo";
// Dependencies first: hono-auth needs sqlite-db to exist.
const builds = ["sqlite-db", "hono-api", "hono-auth", "hono-rate-limit", "fastapi-service", "fastapi-api-key"];

let failed = 0;
for (const name of builds) {
  const res = spawnSync(process.execPath, ["cli/dist/pkg.js", "publish", "--dir", `builds/${name}`, "--owner", owner], { cwd: root, encoding: "utf8" });
  const out = `${res.stdout}${res.stderr}`.trim();
  console.log(`--- ${name}\n${out}`);
  if (res.status !== 0 && !/already exists/.test(out)) failed++;
}
process.exitCode = failed ? 1 : 0;
