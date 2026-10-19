import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { checkBundle } from "../shared/checks.ts";
import { effectiveDependencies } from "../shared/dependencies.ts";
import { integrityOf, unsafePathReason, validateManifest } from "../shared/manifest.ts";
import { safeTarget } from "../cli/src/paths.ts";

globalThis.__PKG_VERSION__ = "test";
const { add, update } = await import("../cli/src/install.ts");
const api = await import("../registry/src/api.ts");
const manifest = { name: "demo", version: "1.0.0", kind: "module", description: "Security regression fixture", license: "MIT" };
const bundle = (files = [], extra = {}) => ({ format: 1, manifest: { ...manifest, ...extra }, files });
const scratch = () => mkdtempSync(join(tmpdir(), "pkg-security-"));

test("F01: decoded configuration receives all text and filename checks", () => {
  const files = [
    { path: "package.json", content: Buffer.from('{"scripts":{"postinstall":"echo marker"}}').toString("base64"), encoding: "base64" },
    { path: ".claude/settings.json", content: Buffer.from('{"permissions":{}}').toString("base64"), encoding: "base64" },
  ];
  const report = checkBundle(bundle(files));
  assert.ok(report.findings.some((f) => f.code === "install-script"));
  assert.ok(report.findings.some((f) => f.code === "autorun"));
  for (const f of [{ path: "package.json", content: "/w==", encoding: "base64" }, { path: "a", content: "a", encoding: "garbage" }, null]) assert.equal(checkBundle(bundle([f])).risk, "error");
});

test("F02/F03: Windows aliases and real junctions cannot cross the project boundary", () => {
  for (const p of [".GIT/config", "x/.Git/hooks/x", "NODE_MODULES/x", "a./x", "a /x", "con.txt", "COM1", "CONOUT$", "NUL .txt", "x:y", "git~1/config", "x\u0001/y"]) assert.ok(unsafePathReason(p), p);
  const dir = scratch(); const outside = scratch();
  try {
    symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => safeTarget(dir, "linked/marker"), /linked|aliased/);
    symlinkSync(join(outside, "missing"), join(dir, "package.json"), process.platform === "win32" ? "junction" : "file");
    assert.throws(() => safeTarget(dir, "package.json"), /linked|aliased/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("F04/F06/F10: reject nested invalid values, installer directives and hidden dependency inputs", () => {
  for (const bad of [{ env: { X: null } }, { stack: [] }, { scripts: [] }, { dependencies: { pip: [] } }, { builds: [] }, { env: { X: { required: "yes" } } }, { env: { X: { example: "x\nEVIL=yes" } } }, { dependencies: { pip: { requests: ">=2\n--extra-index-url https://example.invalid" } } }]) assert.ok(validateManifest({ ...manifest, ...bad }).length);
  for (const content of ["--extra-index-url https://example.invalid", "requests @ https://example.invalid/x.whl", "requests>=2; python_version > '3'", "-r outside.txt"]) assert.throws(() => effectiveDependencies(bundle([{ path: "requirements.txt", content }])));
  const deps = effectiveDependencies(bundle([{ path: "package.json", encoding: "base64", content: Buffer.from('{"optionalDependencies":{"left-pad":"^1"}}').toString("base64") }, { path: "pyproject.toml", content: '[project]\n  dependencies = ["requests>=2"]' }]));
  assert.deepEqual(deps.npm["left-pad"], ["^1"]);
  assert.deepEqual(deps.pip.requests, [">=2"]);
});

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../registry/migrations/0001_init.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../registry/migrations/0002_content_addressed_bundles.sql", import.meta.url), "utf8"));
  const prepare = (sql, args = []) => ({
    bind: (...values) => prepare(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
    sql, args,
  });
  return { db, DB: { prepare, batch: async (stmts) => {
    db.exec("BEGIN");
    try { const result = []; for (const stmt of stmts) result.push(db.prepare(stmt.sql).run(...stmt.args)); db.exec("COMMIT"); return result; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  } } };
}

function version(db, id, version, builds = {}) {
  db.prepare(`INSERT OR IGNORE INTO builds (id,owner,name,kind,description,license,latest,risk,quality,created_at,updated_at) VALUES (?, 'audit', ?, 'module','fixture','MIT',?,'ok',0,'now','now')`).run(id, id.split("/")[1], version);
  db.prepare(`INSERT INTO versions (build_id,version,manifest,files,integrity,size,risk,quality,findings,publisher,published_at) VALUES (?,?,?,'[]','sha256-fixture',0,'ok',0,'[]','audit','now')`).run(id, version, JSON.stringify({ ...manifest, name: id.split("/")[1], version, builds }));
}

test("F08: candidate backtracking removes stale edges and stale constraints", async () => {
  const { db, DB } = database();
  try {
    version(db, "audit/a", "2.0.0", { "audit/ghost": "*" });
    version(db, "audit/a", "1.0.0", { "audit/shared": "^1" });
    version(db, "audit/b", "1.0.0", { "audit/a": "^1" });
    version(db, "audit/shared", "1.0.0");
    const plan = await api.resolve({ DB }, ["audit/a", "audit/b"]);
    assert.deepEqual(plan.builds.map((b) => `${b.id}@${b.version}`), ["audit/shared@1.0.0", "audit/a@1.0.0", "audit/b@1.0.0"]);
  } finally { db.close(); }
});

test("F06: file-only dependencies, invalid versions and unavailable upstream checks block publishing", async () => {
  const { db, DB } = database(); const originalFetch = globalThis.fetch;
  const env = { DB, ADMIN_TOKEN: "synthetic", BUNDLES: { put: async () => assert.fail("must reject before storage") } };
  const req = () => new Request("http://localhost/api/publish", { method: "POST", headers: { "x-pkg-owner": "audit", authorization: "Bearer synthetic" }, body: gzipSync(JSON.stringify(bundle([{ path: "package.json", content: JSON.stringify({ dependencies: { "audit-missing": "^999" } }) }]))) });
  try {
    for (const response of [() => new Response("", { status: 404 }), () => Response.json({ versions: { "1.0.0": {} } }), () => { throw new Error("offline"); }]) {
      let checked = false;
      globalThis.fetch = async (url) => { assert.match(String(url), /audit-missing/); checked = true; return response(); };
      await assert.rejects(api.publish(env, req()), (e) => e.status === 422 && e.details.findings.some((f) => f.code === "unverified-dependency"));
      assert.ok(checked);
    }
    globalThis.fetch = async () => Response.json({ versions: { "1.0.0": {}, "999.0.0": {} } });
    const conflicting = bundle([{ path: "package.json", content: '{"dependencies":{"demo":"^999"}}' }], { dependencies: { npm: { demo: "^1" } } });
    const request = new Request("http://localhost/api/publish", { method: "POST", headers: { "x-pkg-owner": "audit", authorization: "Bearer synthetic" }, body: gzipSync(JSON.stringify(conflicting)) });
    await assert.rejects(api.publish(env, request), (e) => e.status === 422 && e.details.findings.some((f) => f.code === "unverified-dependency"));
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test("F07: partial update validates unchanged consumers of transitive dependencies", async () => {
  const { db, DB } = database(); const dir = scratch(); const originalFetch = globalThis.fetch;
  try {
    version(db, "audit/stays", "1.0.0", { "audit/shared": "^1" });
    version(db, "audit/moves", "1.0.0", { "audit/shared": "^1" });
    version(db, "audit/moves", "1.1.0", { "audit/shared": "^2" });
    version(db, "audit/shared", "1.0.0"); version(db, "audit/shared", "2.0.0");
    const builds = Object.fromEntries(["stays", "moves", "shared"].map((name) => [`audit/${name}`, { version: "1.0.0", kind: "module", integrity: "fixture", provides: [], files: {} }]));
    const lock = JSON.stringify({ lockfileVersion: 1, registry: "fixture", builds });
    writeFileSync(join(dir, "pkg.lock.json"), lock);
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /api\/resolve$/);
      try { return Response.json(await api.resolve({ DB }, JSON.parse(init.body).builds)); }
      catch (e) { return Response.json({ error: e.message }, { status: e.status }); }
    };
    // The solver can keep moves@1.0.0 for an unconstrained update, or reject an explicit incompatible update.
    await assert.rejects(update(["audit/moves@1.1.0"], { dir }), /conflict|compatible/);
    assert.equal(readFileSync(join(dir, "pkg.lock.json"), "utf8"), lock);
  } finally { globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("F09: failed dependency subprocess is reported and unchanged builds can retry", async () => {
  const dir = scratch(); const originalFetch = globalThis.fetch; const originalPath = process.env.PATH;
  try {
    writeFileSync(join(dir, "package.json"), '{"name":"fixture","private":true}');
    writeFileSync(join(dir, "pkg.lock.json"), JSON.stringify({ lockfileVersion: 1, registry: "fixture", builds: { "audit/demo": { version: "1.0.0", kind: "module", integrity: "fixture", provides: [], files: {} } } }));
    globalThis.fetch = async () => Response.json({ builds: [{ id: "audit/demo", version: "1.0.0", manifest, kind: "module" }] });
    process.env.PATH = dir;
    await assert.rejects(add(["audit/demo"], { dir, install: true }), (e) => /dependency installation failed/.test(e.message) && e.details.install[0].ok === false);
    process.env.PATH = originalPath;
    const result = await add(["audit/demo"], { dir, install: true });
    assert.equal(result.builds.length, 0);
    assert.equal(result.install[0].ok, true);
  } finally { globalThis.fetch = originalFetch; process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); }
});

test("F12/F13: concurrent publishers cannot replace committed bytes; downloads carry no trust weight", async () => {
  const { db, DB } = database(); const objects = new Map();
  let puts = 0; let unblock; const both = new Promise((r) => { unblock = r; });
  const env = { DB, ADMIN_TOKEN: "synthetic", BUNDLES: {
    put: async (key, bytes) => { if (++puts === 2) unblock(); await both; objects.set(key, bytes); },
    get: async (key) => objects.has(key) ? { arrayBuffer: async () => objects.get(key).buffer } : null,
  } };
  const req = (text) => new Request("http://localhost/api/publish", { method: "POST", headers: { "x-pkg-owner": "audit", authorization: "Bearer synthetic" }, body: gzipSync(JSON.stringify(bundle([{ path: "fixture.txt", content: text }]))) });
  try {
    const results = await Promise.allSettled([api.publish(env, req("A")), api.publish(env, req("B"))]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
    const winner = results.find((r) => r.status === "fulfilled").value;
    const stored = await api.readBundle(env, "audit/demo", "1.0.0");
    assert.ok(["A", "B"].includes(stored.files[0].content));
    for (let i = 0; i < 3; i++) {
      const res = await api.downloadBundle(env, {}, "audit", "demo", "1.0.0");
      assert.equal(await integrityOf(new Uint8Array(await res.arrayBuffer())), winner.integrity);
    }
    const build = await api.getBuild(env, "audit/demo");
    assert.equal(build.downloads, 0);
    assert.equal(api.reputation(build), api.reputation({ ...build, downloads: 1_000_000 }));
    db.prepare("UPDATE versions SET yanked = 1").run();
    assert.equal(await api.readBundle(env, "audit/demo", "1.0.0"), null);
  } finally { db.close(); }
});

test("F01/F07/F09/F10: installer defaults to inspection, preflights, preserves constraints and retries", async () => {
  const dir = scratch(); const originalFetch = globalThis.fetch;
  let resolvedSpecs; let specMode = "initial";
  const fixture = bundle([{ path: "fixture.txt", content: "hello" }, { path: "package.json", content: '{"name":"fixture","scripts":{"postinstall":"node -e \\\"require(\'fs\').writeFileSync(\'executed\',\'yes\')\\\""}}' }]);
  fixture.files[1].content = JSON.stringify({ name: "fixture", scripts: { postinstall: "node -e \"require('fs').writeFileSync('executed','yes')\"" } });
  const gz = gzipSync(JSON.stringify(fixture)); const integrity = await integrityOf(gz);
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/resolve")) {
      resolvedSpecs = JSON.parse(init.body).builds;
      if (specMode === "conflict") return Response.json({ error: "conflicting installed graph" }, { status: 409 });
      return Response.json({ builds: [{ id: "audit/demo", version: "1.0.0", kind: "module", manifest: fixture.manifest, warnings: [], requested_by: ["(requested)"], integrity, bundle: "/fixture.gz" }] });
    }
    return new Response(gz);
  };
  try {
    const result = await add(["audit/demo"], { dir });
    assert.deepEqual(result.install, []);
    assert.ok(!existsSync(join(dir, "executed")));
    assert.ok(result.builds[0].warnings.some((f) => f.code === "install-script"));
    const explicit = await add(["audit/demo"], { dir, install: true });
    assert.equal(explicit.install[0].ok, true);
    assert.ok(!existsSync(join(dir, "executed")), "npm lifecycle scripts remain disabled after explicit opt-in");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10", dependencies: {} }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    await assert.rejects(add(["audit/demo"], { dir, install: true }), /supports npm only/);
    specMode = "conflict";
    await assert.rejects(add(["audit/other"], { dir }), /conflicting installed graph/);
    assert.ok(resolvedSpecs.includes("audit/demo@1.0.0"));
    assert.ok(!existsSync(join(dir, "other.txt")));
  } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
});
