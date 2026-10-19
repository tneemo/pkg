// Stack profiles and compatibility checks, shared by the CLI (real project on disk)
// and the registry (search ranking against the stack an agent sends).
import semver from "semver";
import { parse as parseToml } from "smol-toml";
import { normalizePip, type Manifest } from "./manifest.ts";

/** A project's stack: tag -> known version (or null when the version is unknown). */
export type Profile = Record<string, string | null>;

/** Friendly tags for well-known npm packages. Every dependency is also tagged "npm:<name>". */
export const NPM_TAGS: Record<string, string> = {
  next: "nextjs", react: "react", "react-dom": "react", vue: "vue", nuxt: "nuxt", svelte: "svelte",
  "@sveltejs/kit": "sveltekit", astro: "astro", "solid-js": "solid", "@angular/core": "angular",
  "react-router": "react-router", "@remix-run/react": "remix", vite: "vite", expo: "expo", "react-native": "react-native",
  electron: "electron", express: "express", hono: "hono", fastify: "fastify", koa: "koa", "@nestjs/core": "nestjs",
  "@trpc/server": "trpc", graphql: "graphql", tailwindcss: "tailwind", "drizzle-orm": "drizzle",
  prisma: "prisma", "@prisma/client": "prisma", mongoose: "mongodb", mongodb: "mongodb", pg: "postgres",
  postgres: "postgres", "better-sqlite3": "sqlite", "@libsql/client": "libsql", redis: "redis", ioredis: "redis",
  zod: "zod", vitest: "vitest", jest: "jest", "@playwright/test": "playwright", typescript: "typescript",
  wrangler: "cloudflare-workers", "@cloudflare/workers-types": "cloudflare-workers", stripe: "stripe",
  "@anthropic-ai/sdk": "anthropic", openai: "openai", "socket.io": "socket.io", "better-auth": "better-auth",
};

/** Friendly tags for well-known Python packages. Every dependency is also tagged "pip:<name>". */
export const PIP_TAGS: Record<string, string> = {
  fastapi: "fastapi", django: "django", flask: "flask", starlette: "starlette", sqlalchemy: "sqlalchemy",
  pydantic: "pydantic", pytest: "pytest", celery: "celery", "psycopg": "postgres", "psycopg2": "postgres",
  "psycopg2-binary": "postgres", redis: "redis", httpx: "httpx", uvicorn: "uvicorn", anthropic: "anthropic", openai: "openai",
};

/** Lowest version a range or version string allows, or null. */
export function versionOf(spec: string | undefined | null): string | null {
  if (!spec) return null;
  const v = semver.valid(spec) ?? (semver.validRange(spec) ? semver.minVersion(spec)?.version : null) ?? semver.coerce(spec)?.version;
  return v ?? null;
}

function put(profile: Profile, tag: string, version: string | null) {
  // Keep a known version over an unknown one.
  if (!(tag in profile) || (profile[tag] === null && version)) profile[tag] = version;
}

/** Tags implied by a package.json object (plus what we know about installed versions). */
export function profileFromPackageJson(pkg: any, installed: Record<string, string> = {}): Profile {
  const profile: Profile = { javascript: null };
  const deps: Record<string, string> = { ...(pkg?.devDependencies ?? {}), ...(pkg?.dependencies ?? {}) };
  for (const [name, range] of Object.entries(deps)) {
    const version = installed[name] ?? versionOf(String(range));
    put(profile, `npm:${name}`, version);
    const tag = NPM_TAGS[name];
    if (tag) put(profile, tag, version);
  }
  return profile;
}

/** Parses PEP 508 requirement strings like "fastapi[standard]>=0.110". */
export function parsePipRequirement(line: string): { name: string; spec: string } | null {
  const clean = line.split("#")[0].split(";")[0].trim();
  if (!clean || clean.startsWith("-")) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(clean);
  if (!m) return null;
  return { name: normalizePip(m[1]), spec: m[3].trim() };
}

/** Converts a PEP 440 specifier like ">=0.110,<1" into the lowest version it allows. */
function pipVersion(spec: string): string | null {
  const m = /(?:==|>=|~=|>)\s*([0-9][0-9a-zA-Z.]*)/.exec(spec);
  return m ? versionOf(m[1]) : null;
}

export function profileFromPythonDeps(lines: string[]): Profile {
  const profile: Profile = { python: null };
  for (const line of lines) {
    const req = parsePipRequirement(line);
    if (!req) continue;
    const version = pipVersion(req.spec);
    put(profile, `pip:${req.name}`, version);
    const tag = PIP_TAGS[req.name];
    if (tag) put(profile, tag, version);
  }
  return profile;
}

/** Extracts [project].dependencies from a pyproject.toml without a TOML parser. */
export function pyprojectDependencies(toml: string): string[] {
  if (!toml.trim()) return [];
  const data = parseToml(toml) as Record<string, any>;
  const deps = data.project?.dependencies ?? [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string")) throw new Error("project.dependencies must be an array of strings");
  return deps;
}

export function mergeProfiles(...profiles: Profile[]): Profile {
  const out: Profile = {};
  for (const p of profiles) for (const [tag, v] of Object.entries(p)) put(out, tag, v);
  return out;
}

/** Tags a build adds to a project: its declared "provides" plus its own dependencies. */
export function profileFromManifest(m: Manifest): Profile {
  const parts: Profile[] = [Object.fromEntries((m.stack?.provides ?? []).map((t) => [t.toLowerCase(), null]))];
  for (const deps of [m.dependencies, m.devDependencies]) {
    if (deps?.npm) parts.push(profileFromPackageJson({ dependencies: deps.npm }));
    if (deps?.pip) parts.push(profileFromPythonDeps(Object.entries(deps.pip).map(([n, s]) => `${n}${s === "*" ? "" : s}`)));
  }
  return mergeProfiles(...parts);
}

/** "node@24.1.0,typescript,hono@4" -> Profile. Accepts arrays too. */
export function parseStack(input: string | string[] | undefined | null): Profile {
  const items = (Array.isArray(input) ? input : (input ?? "").split(/[,\s]+/)).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const profile: Profile = {};
  for (const item of items) {
    // Allow a leading "@" for scoped npm names such as "npm:@hono/node-server@1.2.0".
    const at = item.lastIndexOf("@");
    const hasVersion = at > 0 && /^[0-9]/.test(item.slice(at + 1));
    put(profile, hasVersion ? item.slice(0, at) : item, hasVersion ? versionOf(item.slice(at + 1)) : null);
  }
  return profile;
}

const JS_TAGS = new Set(["javascript", "typescript", ...Object.values(NPM_TAGS)]);
const JS_RUNTIMES = ["node", "bun", "deno", "cloudflare-workers"];

/** A JavaScript stack with no runtime named runs on Node; add it so Node-only builds match. */
export function withImpliedRuntime(profile: Profile, nodeVersion: string): Profile {
  const tags = Object.keys(profile);
  if (tags.some((t) => JS_RUNTIMES.includes(t)) || !tags.some((t) => JS_TAGS.has(t) || t.startsWith("npm:"))) return profile;
  return { ...profile, node: nodeVersion };
}

export function formatStack(profile: Profile): string {
  return Object.entries(profile)
    .filter(([tag]) => !tag.includes(":"))
    .map(([tag, v]) => (v ? `${tag}@${v}` : tag))
    .join(", ");
}

export interface CompatResult {
  ok: boolean;
  missing: string[];
  mismatched: { tag: string; range: string; version: string }[];
}

/** Does a profile satisfy a build's stack.requires? Unknown versions are given the benefit of the doubt. */
export function checkCompat(requires: Record<string, string> | undefined, profile: Profile): CompatResult {
  const missing: string[] = [];
  const mismatched: CompatResult["mismatched"] = [];
  for (const [rawTag, range] of Object.entries(requires ?? {})) {
    const tag = rawTag.toLowerCase();
    if (!(tag in profile)) { missing.push(tag); continue; }
    const version = profile[tag];
    if (version && range !== "*" && !semver.satisfies(version, range, { includePrerelease: true })) {
      mismatched.push({ tag, range, version });
    }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

export function describeCompat(c: CompatResult): string {
  if (c.ok) return "compatible";
  const parts = [];
  if (c.missing.length) parts.push(`needs ${c.missing.join(", ")}`);
  for (const m of c.mismatched) parts.push(`needs ${m.tag} ${m.range} (have ${m.version})`);
  return parts.join("; ");
}
