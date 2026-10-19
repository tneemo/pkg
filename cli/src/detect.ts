// Detects a project's stack from the files on disk. No configuration needed.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeProfiles,
  profileFromPackageJson,
  profileFromPythonDeps,
  pyprojectDependencies,
  versionOf,
  type Profile,
} from "../../shared/compat.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "uv" | "poetry";

export interface LockEntry {
  version: string;
  kind: string;
  integrity: string;
  provides: string[];
  files: Record<string, string>;
}

export interface Lockfile {
  lockfileVersion: 1;
  registry: string;
  builds: Record<string, LockEntry>;
}

export interface Project {
  dir: string;
  /** True when the directory has no project files yet (a new project). */
  empty: boolean;
  profile: Profile;
  npm: PackageManager | null;
  python: PackageManager | null;
  lock: Lockfile | null;
}

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export function readJson(path: string): any {
  const text = read(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function readLock(dir: string): Lockfile | null {
  const lock = readJson(join(dir, "pkg.lock.json"));
  return lock && typeof lock.builds === "object" ? lock : null;
}

function installedVersions(dir: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = readJson(join(dir, "node_modules", name, "package.json"))?.version;
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

/** Stack tags implied by a package.json, tsconfig and friends (on disk or inside a bundle). */
export function profileFromNodeFiles(pkg: any, hasTsconfig: boolean, installed: Record<string, string> = {}, lockfiles: string[] = []): Profile {
  const profile = profileFromPackageJson(pkg, installed);
  const isBun = lockfiles.some((f) => f.startsWith("bun.lock")) || String(pkg?.packageManager ?? "").startsWith("bun");
  if (isBun) profile.bun = null;
  else profile.node = process.versions.node;
  if (hasTsconfig && !("typescript" in profile)) profile.typescript = null;
  return profile;
}

export function profileFromPythonFiles(pyproject: string | null, requirements: string | null): Profile {
  const lines = [...(pyproject ? pyprojectDependencies(pyproject) : []), ...(requirements ? requirements.split(/\r?\n/) : [])];
  const profile = profileFromPythonDeps(lines);
  const requiresPython = pyproject ? /requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject)?.[1] : undefined;
  if (requiresPython) profile.python = versionOf(requiresPython.replace(/[~=<>!,\s]+/g, " ").trim().split(" ")[0]);
  return profile;
}

export function detectProject(dir: string): Project {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory does not exist yet: a new project.
  }
  const has = (f: string) => entries.includes(f);
  const profiles: Profile[] = [];
  let npm: PackageManager | null = null;
  let python: PackageManager | null = null;

  const pkg = has("package.json") ? readJson(join(dir, "package.json")) : null;
  if (pkg) {
    const names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    profiles.push(profileFromNodeFiles(pkg, has("tsconfig.json"), installedVersions(dir, names), entries));
    npm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    const declared = String(pkg.packageManager ?? "").split("@")[0];
    if (!entries.some((f) => /lock/.test(f)) && ["pnpm", "yarn", "bun", "npm"].includes(declared)) npm = declared as PackageManager;
  } else if (has("tsconfig.json")) {
    profiles.push({ typescript: null });
  }

  if (has("pyproject.toml") || has("requirements.txt")) {
    const pyproject = has("pyproject.toml") ? read(join(dir, "pyproject.toml")) : null;
    profiles.push(profileFromPythonFiles(pyproject, has("requirements.txt") ? read(join(dir, "requirements.txt")) : null));
    python = has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : "pip";
  }
  if (has("go.mod")) profiles.push({ go: versionOf(/^go\s+(\S+)/m.exec(read(join(dir, "go.mod")) ?? "")?.[1]) });
  if (has("Cargo.toml")) profiles.push({ rust: null });
  if (has("deno.json") || has("deno.jsonc")) profiles.push({ deno: null, typescript: null });
  if (has("wrangler.toml") || has("wrangler.jsonc") || has("wrangler.json")) profiles.push({ "cloudflare-workers": null });

  // Builds already installed contribute the tags they provide (e.g. "db", "auth").
  const lock = readLock(dir);
  for (const entry of Object.values(lock?.builds ?? {})) profiles.push(Object.fromEntries(entry.provides.map((t) => [t, null])));

  const meaningful = entries.filter((e) => !e.startsWith(".") && !["README.md", "LICENSE", "node_modules", "pkg.lock.json"].includes(e));
  return { dir, empty: meaningful.length === 0, profile: mergeProfiles(...profiles), npm, python, lock };
}
