// Registry logic: search, resolve, publish, download and feedback. Storage is
// D1 (metadata + FTS5 search) and R2 (immutable gzipped bundles).
import semver from "semver";
import { satisfies as pipSatisfies } from "@renovatebot/pep440";
import { effectiveDependencies } from "../../shared/dependencies.ts";
import { checkBundle, type CheckReport, type Finding } from "../../shared/checks.ts";
import { checkCompat, describeCompat, parseStack, type CompatResult, type Profile } from "../../shared/compat.ts";
import { integrityOf, OWNER_RE, parseSpec, validateBundle, type Bundle, type Manifest } from "../../shared/manifest.ts";

export interface Env {
  DB: D1Database;
  BUNDLES: R2Bucket;
  /** Lets the operator publish into any namespace (seeding, moderation). */
  ADMIN_TOKEN?: string;
  IP_SALT?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export interface BuildRow {
  id: string;
  owner: string;
  name: string;
  kind: "module" | "foundation";
  description: string;
  keywords: string;
  requires: string;
  provides: string;
  license: string;
  repository: string | null;
  latest: string;
  risk: string;
  quality: number;
  downloads: number;
  successes: number;
  failures: number;
  reports: number;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  build_id: string;
  version: string;
  manifest: string;
  readme: string | null;
  integration: string | null;
  files: string;
  integrity: string;
  size: number;
  risk: string;
  quality: number;
  findings: string;
  publisher: string;
  published_at: string;
  yanked: number;
  bundle_key?: string | null;
}

const STOPWORDS = new Set("a an and app application build builds create for from i in into it make me my need of on or project simple some that the this to use using want we with".split(" "));
const MAX_UPLOAD = 5_000_000;

/** Bayesian success rate: starts at 50% and moves with evidence. */
export function successRate(b: Pick<BuildRow, "successes" | "failures">): number {
  return (b.successes + 1) / (b.successes + b.failures + 2);
}

/** 0-1 trust signal from usage, agent-reported outcomes, quality and reports. */
export function reputation(b: BuildRow): number {
  // Historical raw downloads are not evidence of independent successful installs.
  const penalty = b.reports >= 3 && b.reports > b.successes / 10 ? 0.5 : 1;
  return (successRate(b) * 0.5 + (b.quality / 100) * 0.5) * penalty;
}

export function publicBuild(b: BuildRow) {
  return {
    id: b.id,
    kind: b.kind,
    description: b.description,
    version: b.latest,
    keywords: JSON.parse(b.keywords) as string[],
    requires: JSON.parse(b.requires) as Record<string, string>,
    provides: JSON.parse(b.provides) as string[],
    license: b.license,
    repository: b.repository,
    risk: b.risk,
    quality: b.quality,
    downloads: b.downloads,
    agent_reports: { success: b.successes, failure: b.failures, success_rate: Math.round(successRate(b) * 100) / 100 },
    flags: b.reports,
    reputation: Math.round(reputation(b) * 100) / 100,
    updated_at: b.updated_at,
  };
}

/** Which builds provide each tag, e.g. {"hono": ["tneemo/hono-api"]}. */
async function providers(env: Env): Promise<Map<string, { id: string; kind: string }[]>> {
  const { results } = await env.DB.prepare("SELECT id, kind, provides FROM builds WHERE provides != '[]' ORDER BY quality DESC").all<Pick<BuildRow, "id" | "kind" | "provides">>();
  const map = new Map<string, { id: string; kind: string }[]>();
  for (const row of results) for (const tag of JSON.parse(row.provides) as string[]) {
    if (!map.has(tag)) map.set(tag, []);
    map.get(tag)!.push({ id: row.id, kind: row.kind });
  }
  return map;
}

export interface SearchParams {
  q?: string | null;
  stack?: string | null;
  kind?: string | null;
  limit?: number;
}

export async function search(env: Env, params: SearchParams) {
  const profile = parseStack(params.stack);
  const stackTags = Object.keys(profile).filter((t) => !t.includes(":"));
  const kind = params.kind === "module" || params.kind === "foundation" ? params.kind : null;
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const terms = [...new Set((params.q ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((t) => !STOPWORDS.has(t)).slice(0, 16);

  let rows: (BuildRow & { rank?: number })[];
  if (terms.length) {
    const match = terms.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(" OR ");
    const sql = `SELECT b.*, bm25(builds_fts, 0, 10, 4, 6, 1) AS rank FROM builds_fts JOIN builds b ON b.id = builds_fts.id
      WHERE builds_fts MATCH ?1 ${kind ? "AND b.kind = ?2" : ""} ORDER BY rank LIMIT 200`;
    const stmt = kind ? env.DB.prepare(sql).bind(match, kind) : env.DB.prepare(sql).bind(match);
    rows = (await stmt.all<BuildRow & { rank: number }>()).results;
  } else {
    const sql = `SELECT * FROM builds ${kind ? "WHERE kind = ?1" : ""} ORDER BY quality DESC, updated_at DESC LIMIT 200`;
    rows = (await (kind ? env.DB.prepare(sql).bind(kind) : env.DB.prepare(sql)).all<BuildRow>()).results;
  }

  const best = Math.min(-1e-9, ...rows.map((r) => r.rank ?? 0));
  const providerMap = stackTags.length ? await providers(env) : new Map();

  const results = rows.map((row) => {
    const b = publicBuild(row);
    const relevance = row.rank === undefined ? 0.5 : row.rank / best;
    let fit = 1;
    let compat: (CompatResult & { note: string; via?: Record<string, string[]> }) | undefined;
    if (stackTags.length) {
      const c = checkCompat(b.requires, profile);
      compat = { ...c, note: describeCompat(c) };
      if (c.missing.length) {
        const via: Record<string, string[]> = {};
        for (const tag of c.missing) {
          const ids = (providerMap.get(tag) ?? []).map((p: { id: string }) => p.id).filter((id: string) => id !== b.id).slice(0, 3);
          if (ids.length) via[tag] = ids;
        }
        if (Object.keys(via).length) compat.via = via;
      }
      // How much of the requested stack this build fits or establishes.
      const own = new Set([...b.provides, ...Object.keys(b.requires)]);
      const overlap = stackTags.filter((t) => own.has(t)).length / stackTags.length;
      const usable = c.ok || (compat.via && c.mismatched.length === 0 && c.missing.every((t) => compat!.via![t]));
      fit = (c.ok ? 1 : usable ? 0.85 : 0.3) * (0.6 + 0.4 * overlap);
      if (b.kind === "foundation" && overlap === 0 && own.size > 0) {
        // A foundation for another stack (e.g. FastAPI when TypeScript was asked for) is not a fit.
        fit *= 0.4;
        compat = { ok: false, missing: [], mismatched: [], note: `different stack (sets up ${b.provides.slice(0, 4).join(", ")})` };
      }
    }
    const riskFactor = row.risk === "warn" ? 0.9 : 1;
    const score = (relevance * 0.6 + reputation(row) * 0.4) * fit * riskFactor;
    return { ...b, score: Math.round(score * 1000) / 1000, compat, install: `npx -y @tneemo/pkg add ${b.id}` };
  });

  results.sort((a, b) => b.score - a.score);
  return { query: params.q ?? "", stack: profile, total: results.length, results: results.slice(0, limit) };
}

export async function getBuild(env: Env, id: string): Promise<BuildRow | null> {
  return env.DB.prepare("SELECT * FROM builds WHERE id = ?").bind(id).first<BuildRow>();
}

export async function getVersions(env: Env, id: string): Promise<Pick<VersionRow, "version" | "published_at" | "risk" | "quality" | "yanked">[]> {
  const { results } = await env.DB.prepare("SELECT version, published_at, risk, quality, yanked FROM versions WHERE build_id = ?").bind(id).all<VersionRow>();
  return results.sort((a, b) => semver.rcompare(a.version, b.version));
}

export async function getVersion(env: Env, id: string, version: string): Promise<VersionRow | null> {
  return env.DB.prepare("SELECT * FROM versions WHERE build_id = ? AND version = ?").bind(id, version).first<VersionRow>();
}

/** Full details for one build: metadata, docs, files, checks and versions. */
export async function buildInfo(env: Env, id: string, version?: string | null) {
  const build = await getBuild(env, id);
  if (!build) throw new HttpError(404, `build "${id}" not found`);
  const versions = await getVersions(env, id);
  const v = await getVersion(env, id, version || build.latest);
  if (!v || v.yanked) throw new HttpError(404, `version "${version}" of "${id}" not found`);
  const manifest = JSON.parse(v.manifest) as Manifest;
  return {
    ...publicBuild(build),
    version: v.version,
    latest: build.latest,
    manifest,
    readme: v.readme,
    integration: v.integration,
    files: JSON.parse(v.files) as { path: string; size: number }[],
    checks: { risk: v.risk, quality: v.quality, findings: JSON.parse(v.findings) as Finding[] },
    integrity: v.integrity,
    publisher: v.publisher,
    published_at: v.published_at,
    versions: versions.map((x) => ({ version: x.version, published_at: x.published_at, risk: x.risk, yanked: !!x.yanked })),
  };
}

/**
 * Resolves requested builds plus their transitive build dependencies to exact
 * versions (highest version satisfying every constraint), ordered so that
 * foundations come first and dependencies precede dependents.
 */
export async function resolve(env: Env, specs: string[]) {
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > 50) throw new HttpError(400, "send {\"builds\": [\"owner/name@range\", ...]} with 1-50 entries");
  const roots = specs.map((s) => {
    const p = typeof s === "string" ? parseSpec(s) : null;
    if (!p) throw new HttpError(400, `invalid build spec "${s}"`);
    return { id: p.id, range: p.range, from: "(requested)" };
  });
  const versionCache = new Map<string, VersionRow[]>();
  let steps = 0;
  let failure = "unsatisfiable build dependency graph";
  // Each candidate owns its pending edges. Backtracking discards its requirements too.
  const solve = async (pending: typeof roots, selected: Map<string, VersionRow>): Promise<Map<string, VersionRow> | null> => {
    if (++steps > 5000 || selected.size > 200) throw new HttpError(422, "dependency graph too large");
    if (!pending.length) return selected;
    const [edge, ...rest] = pending;
    const current = selected.get(edge.id);
    if (current) {
      if (!semver.satisfies(current.version, edge.range)) { failure = `conflicting constraints for ${edge.id} (needs ${edge.range}, selected ${current.version})`; return null; }
      return solve(rest, selected);
    }
    if (!versionCache.has(edge.id)) {
      const { results } = await env.DB.prepare("SELECT * FROM versions WHERE build_id = ? AND yanked = 0").bind(edge.id).all<VersionRow>();
      versionCache.set(edge.id, results.sort((a, b) => semver.rcompare(a.version, b.version)));
    }
    for (const row of versionCache.get(edge.id)!) {
      if (!semver.satisfies(row.version, edge.range)) continue;
      const manifest = JSON.parse(row.manifest) as Manifest;
      const next = new Map(selected).set(edge.id, row);
      const deps = Object.entries(manifest.builds ?? {}).map(([id, range]) => ({ id: id.toLowerCase(), range, from: edge.id }));
      const result = await solve([...rest, ...deps], next);
      if (result) return result;
    }
    failure = `no compatible version of ${edge.id} for ${edge.range}: ${failure}`;
    return null;
  };
  const chosen = await solve(roots, new Map());
  if (!chosen) throw new HttpError(409, failure);
  const requestedBy = new Map<string, Set<string>>([...chosen.keys()].map((id) => [id, new Set()]));
  for (const r of roots) requestedBy.get(r.id)!.add(r.from);
  for (const [id, row] of chosen) for (const dep of Object.keys((JSON.parse(row.manifest) as Manifest).builds ?? {})) requestedBy.get(dep.toLowerCase())!.add(id);

  // Topological order: dependencies first, foundations before modules.
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (order.includes(id)) return;
    if (visiting.has(id)) throw new HttpError(409, `circular build dependency involving "${id}"`);
    visiting.add(id);
    for (const dep of Object.keys((JSON.parse(chosen.get(id)!.manifest) as Manifest).builds ?? {})) visit(dep.toLowerCase());
    visiting.delete(id);
    order.push(id);
  };
  const ids = [...chosen.keys()].sort((a, b) => kindRank(chosen.get(a)!) - kindRank(chosen.get(b)!));
  ids.forEach(visit);

  return {
    builds: order.map((id) => {
      const v = chosen.get(id)!;
      const manifest = JSON.parse(v.manifest) as Manifest;
      const [owner, name] = id.split("/");
      return {
        id,
        version: v.version,
        kind: manifest.kind,
        manifest,
        integration: v.integration,
        integrity: v.integrity,
        bundle: `/api/bundles/${owner}/${name}/${encodeURIComponent(v.version)}`,
        risk: v.risk,
        warnings: (JSON.parse(v.findings) as Finding[]).filter((f) => f.level === "warn"),
        requested_by: [...requestedBy.get(id)!],
      };
    }),
  };
}

function kindRank(v: VersionRow): number {
  return (JSON.parse(v.manifest) as Manifest).kind === "foundation" ? 0 : 1;
}

/** Integrity is authoritative in D1; old releases retain their legacy key. */
async function storedBytes(env: Env, id: string, version: string): Promise<{ bytes: Uint8Array; integrity: string } | null> {
  const row = await getVersion(env, id, version);
  if (!row || row.yanked) return null;
  const obj = await env.BUNDLES.get(row.bundle_key || `bundles/${id}/${version}.json.gz`);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (await integrityOf(bytes) !== row.integrity) throw new HttpError(502, "stored bundle integrity mismatch");
  return { bytes, integrity: row.integrity };
}

/** Raw downloads are not installs and do not change trust or ranking. */
export async function downloadBundle(env: Env, _ctx: ExecutionContext, owner: string, name: string, version: string): Promise<Response> {
  const stored = await storedBytes(env, `${owner}/${name}`, version);
  if (!stored) throw new HttpError(404, "bundle not found");
  return new Response(stored.bytes, { headers: {
    "content-type": "application/gzip", "cache-control": "public, max-age=300",
    "x-pkg-integrity": stored.integrity,
  } });
}

export async function readBundle(env: Env, id: string, version: string): Promise<Bundle | null> {
  const stored = await storedBytes(env, id, version);
  if (!stored) return null;
  return JSON.parse(await gunzipLimited(stored.bytes.buffer as ArrayBuffer, 6_000_000));
}

// ---------------------------------------------------------------- publishing

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipLimited(body: ArrayBuffer, limit: number): Promise<string> {
  const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) throw new HttpError(413, `bundle is larger than ${limit / 1e6} MB uncompressed`);
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder().decode(all);
}

/** Maps a bearer token to the GitHub identity allowed to publish under `owner`. */
async function authorize(env: Env, token: string | null, owner: string): Promise<string> {
  if (!token) throw new HttpError(401, "publishing needs a GitHub token: run `gh auth login` or set GITHUB_TOKEN (pkg has no accounts of its own)");
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return `admin:${owner}`;
  const gh = (path: string) => fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, "user-agent": "pkg-registry", accept: "application/vnd.github+json" } });
  const res = await gh("/user");
  if (!res.ok) throw new HttpError(401, "GitHub rejected the token");
  const login = String(((await res.json()) as { login: string }).login).toLowerCase();
  if (login === owner) return login;
  const orgs = await gh("/user/orgs?per_page=100");
  const list = orgs.ok ? ((await orgs.json()) as { login: string }[]).map((o) => o.login.toLowerCase()) : [];
  if (list.includes(owner)) return login;
  throw new HttpError(403, `GitHub user "${login}" cannot publish as "${owner}"; use your own login or an organization you belong to (token needs read:org)`);
}

/** Check every supported install source, with bounded requests and visible failures. */
async function checkUpstream(env: Env, bundle: Bundle): Promise<Finding[]> {
  const findings: Finding[] = [];
  const effective = effectiveDependencies(bundle);
  // Sequential requests avoid an unbounded fan-out and stay within runtime connection limits.
  for (const eco of ["npm", "pip"] as const) for (const [name, ranges] of Object.entries(effective[eco])) {
    const url = eco === "npm" ? `https://registry.npmjs.org/${encodeURIComponent(name)}` : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { versions?: Record<string, unknown>; releases?: Record<string, { yanked?: boolean }[]> };
      const versions = eco === "npm" ? Object.keys(data.versions ?? {}) : Object.entries(data.releases ?? {}).filter(([, files]) => files.some((f) => !f.yanked)).map(([v]) => v);
      if (!versions.some((v) => ranges.every((r) => eco === "npm" ? semver.satisfies(v, r) : pipSatisfies(v, r === "*" ? "" : r)))) throw new Error(`no released version matches ${ranges.join(" and ")}`);
    } catch (e) { findings.push({ level: "error", code: "unverified-dependency", message: `${eco} ${name}: ${(e as Error).message}; retry when upstream verification is available` }); }
  }
  for (const [dep, range] of Object.entries(bundle.manifest.builds ?? {})) {
    const { results } = await env.DB.prepare("SELECT version FROM versions WHERE build_id = ? AND yanked = 0").bind(dep.toLowerCase()).all<{ version: string }>();
    if (!results.some((r) => semver.satisfies(r.version, range))) findings.push({ level: "error", code: "unknown-build", message: `no published version of ${dep} satisfies ${range}` });
  }
  return findings;
}

export async function publish(env: Env, request: Request) {
  const owner = (request.headers.get("x-pkg-owner") ?? "").toLowerCase();
  if (!OWNER_RE.test(owner)) throw new HttpError(400, "missing or invalid X-Pkg-Owner header (your GitHub login or organization)");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const publisher = await authorize(env, token, owner);

  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "missing upload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_UPLOAD) { await reader.cancel(); throw new HttpError(413, "upload larger than 5 MB"); }
    chunks.push(value);
  }
  const body = await new Blob(chunks).arrayBuffer();
  if (body.byteLength > MAX_UPLOAD) throw new HttpError(413, "upload larger than 5 MB");
  let raw: Bundle;
  try {
    raw = JSON.parse(await gunzipLimited(body, 6_000_000));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "body must be a gzipped JSON bundle (use `pkg publish`)");
  }
  if (raw?.format !== 1 || !Array.isArray(raw.files)) throw new HttpError(400, "unsupported bundle format");

  const errors = validateBundle(raw);
  if (errors.length) throw new HttpError(422, "invalid bundle", { errors });
  const bundle: Bundle = raw;

  const report: CheckReport = checkBundle(bundle);
  if (report.risk !== "error") report.findings.push(...(await checkUpstream(env, bundle)));
  if (report.findings.some((f) => f.level === "error")) report.risk = "error";
  if (report.risk === "error") throw new HttpError(422, "build failed automated checks", report);

  const m = bundle.manifest;
  const id = `${owner}/${m.name}`;
  if (await getVersion(env, id, m.version)) throw new HttpError(409, `${id}@${m.version} already exists; versions are immutable, bump "version" in pkg.json`);

  const bytes = await gzip(JSON.stringify(bundle));
  const integrity = await integrityOf(bytes);
  const bundleKey = `objects/${integrity.slice(7).replace(/[^a-zA-Z0-9]/g, (c) => c === "+" ? "-" : c === "/" ? "_" : "")}.json.gz`;
  await env.BUNDLES.put(bundleKey, bytes, { customMetadata: { integrity }, httpMetadata: { contentType: "application/gzip" } });

  const now = new Date().toISOString();
  const files = bundle.files.map((f) => ({ path: f.path, size: f.encoding === "base64" ? Math.floor((f.content.length * 3) / 4) : new TextEncoder().encode(f.content).length }));
  const existing = await getBuild(env, id);
  const isLatest = !existing || semver.gt(m.version, existing.latest);

  // The build row must exist before its version row (foreign key).
  const stmts: D1PreparedStatement[] = [];
  if (isLatest) {
    const cols = [m.kind, m.description, JSON.stringify(m.keywords ?? []), JSON.stringify(m.stack?.requires ?? {}), JSON.stringify((m.stack?.provides ?? []).map((t) => t.toLowerCase())),
      m.license, m.repository ?? null, m.version, report.risk, report.quality];
    stmts.push(existing
      ? env.DB.prepare(`UPDATE builds SET kind = ?, description = ?, keywords = ?, requires = ?, provides = ?, license = ?, repository = ?, latest = ?, risk = ?, quality = ?, updated_at = ? WHERE id = ?`).bind(...cols, now, id)
      : env.DB.prepare(`INSERT INTO builds (kind, description, keywords, requires, provides, license, repository, latest, risk, quality, created_at, updated_at, id, owner, name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...cols, now, now, id, owner, m.name));
    stmts.push(env.DB.prepare("DELETE FROM builds_fts WHERE id = ?").bind(id));
    stmts.push(env.DB.prepare("INSERT INTO builds_fts (id, name, description, keywords, readme) VALUES (?, ?, ?, ?, ?)")
      .bind(id, `${owner} ${m.name}`, m.description, [...(m.keywords ?? []), ...(m.stack?.provides ?? []), ...Object.keys(m.stack?.requires ?? {})].join(" "), bundle.readme ?? ""));
  }
  stmts.push(
    env.DB.prepare(`INSERT INTO versions (build_id, version, manifest, readme, integration, files, integrity, size, risk, quality, findings, publisher, published_at, bundle_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, m.version, JSON.stringify(m), bundle.readme ?? null, bundle.integration ?? null,
      JSON.stringify(files), integrity, bytes.length, report.risk, report.quality, JSON.stringify(report.findings), publisher, now, bundleKey),
  );
  try { await env.DB.batch(stmts); }
  catch (e) {
    // The losing upload can leave an unreferenced content-addressed object, never corrupt a version.
    if (await getVersion(env, id, m.version)) throw new HttpError(409, `${id}@${m.version} already exists`);
    throw e;
  }
  return { id, version: m.version, integrity, risk: report.risk, quality: report.quality, findings: report.findings, publisher };
}

// ---------------------------------------------------------------- feedback

export async function feedback(env: Env, request: Request, id: string) {
  const body = (await request.json().catch(() => null)) as { outcome?: string; version?: string; note?: string; client?: string } | null;
  const kind = body?.outcome;
  if (kind !== "success" && kind !== "failure" && kind !== "report") throw new HttpError(400, 'send {"outcome": "success" | "failure" | "report", "note"?: "...", "version"?: "x.y.z"}');
  if (kind === "report" && !body?.note) throw new HttpError(400, "reports need a note explaining the problem");
  if (!(await getBuild(env, id))) throw new HttpError(404, `build "${id}" not found`);

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const ipHash = (await integrityOf(new TextEncoder().encode(`${env.IP_SALT ?? "pkg"}:${day}:${ip}`))).slice(7, 27);
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO feedback (build_id, version, kind, note, client, ip_hash, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, body?.version ?? null, kind, body?.note?.slice(0, 1000) ?? null, body?.client?.slice(0, 100) ?? null, ipHash, day, new Date().toISOString()).run();
  const counted = res.meta.changes > 0;
  if (counted) {
    const column = kind === "success" ? "successes" : kind === "failure" ? "failures" : "reports";
    await env.DB.prepare(`UPDATE builds SET ${column} = ${column} + 1 WHERE id = ?`).bind(id).run();
  }
  return { ok: true, counted, message: counted ? "thanks, recorded" : "already recorded today" };
}

export async function recentFeedback(env: Env, id: string) {
  const { results } = await env.DB.prepare("SELECT kind, version, note, client, created_at FROM feedback WHERE build_id = ? AND note IS NOT NULL ORDER BY created_at DESC LIMIT 20").bind(id).all();
  return results;
}

export type { Profile };
