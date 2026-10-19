// `pkg add` and `pkg update`: resolve builds, verify, check compatibility, copy
// files, merge dependencies/scripts/env, run the package manager, write
// pkg.lock.json. Code inside a build is never executed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import semver from "semver";
import type { Finding } from "../../shared/checks.ts";
import { checkCompat, describeCompat, mergeProfiles, parsePipRequirement, profileFromManifest, pyprojectDependencies, type Profile } from "../../shared/compat.ts";
import { normalizePip, parseSpec, unsafePathReason, type Bundle, type EnvVar } from "../../shared/manifest.ts";
import { detectProject, profileFromNodeFiles, profileFromPythonFiles, readJson, readLock, type LockEntry, type Lockfile } from "./detect.ts";
import { fetchBundle, info, REGISTRY, resolve as resolvePlan, search, type ResolvedBuild } from "./registry.ts";

export interface AddOptions {
  dir: string;
  force?: boolean;
  install?: boolean;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface UpdateOptions extends AddOptions {
  /** Allow new major versions (default: newest within the installed major). */
  latest?: boolean;
}

export interface InstalledBuild {
  id: string;
  version: string;
  /** The version this one replaced, if it was installed before. */
  previous: string | null;
  kind: string;
  requestedBy: string[];
  written: string[];
  unchanged: string[];
  conflicts: string[];
  /** Files the previous version installed and this one no longer ships: deleted when untouched... */
  removed: string[];
  /** ...and kept when edited locally. */
  kept: string[];
  integration: string | null;
  warnings: Finding[];
  env: Record<string, EnvVar>;
}

export interface AddResult {
  mode: "add" | "update";
  dir: string;
  dryRun: boolean;
  builds: InstalledBuild[];
  skipped: { id: string; version: string; reason: string }[];
  dependencies: { npm: string[]; pip: string[]; conflicts: string[] };
  scripts: string[];
  env: string[];
  install: { command: string; ok: boolean; output?: string }[];
  nextSteps: string[];
}

export class AddError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
  }
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const isWin = process.platform === "win32";
const ENV_LINE = /^\s*([A-Z_][A-Z0-9_]*)\s*=/;

function fileBytes(f: Bundle["files"][number]): Buffer {
  return f.encoding === "base64" ? Buffer.from(f.content, "base64") : Buffer.from(f.content, "utf8");
}

/** sha256 of a file on disk, or null when it is missing or not a regular file. */
export function fileHash(path: string): string | null {
  try {
    return statSync(path).isFile() ? sha256(readFileSync(path)) : null;
  } catch {
    return null;
  }
}

/** Deletes files, then the folders they leave empty (never the project directory itself). */
export function deleteFiles(dir: string, targets: string[]) {
  const root = dir.endsWith(sep) ? dir : dir + sep;
  for (const target of targets) {
    rmSync(target, { force: true });
    for (let d = dirname(target); d.startsWith(root); d = dirname(d)) {
      try {
        if (readdirSync(d).length) break;
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
}

const appendLines = (text: string, lines: string[]) => text + (text && !text.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n";

/**
 * Replacing package.json, requirements or .env.example wholesale would drop what pkg
 * merged in for other builds (and, with --force, what the user added): keep the
 * entries the new file lacks.
 */
function keepMerged(path: string, current: Buffer, next: Buffer): Buffer {
  const cur = current.toString("utf8");
  const nxt = next.toString("utf8");
  if (path === "package.json") {
    try {
      const [a, b] = [JSON.parse(cur), JSON.parse(nxt)];
      const has = new Set(Object.keys({ ...b.dependencies, ...b.devDependencies }));
      let changed = false;
      for (const section of ["dependencies", "devDependencies", "scripts"]) {
        const extra = Object.entries(a[section] ?? {}).filter(([n]) => (section === "scripts" ? b.scripts?.[n] === undefined : !has.has(n)));
        if (!extra.length) continue;
        const merged = [...Object.entries(b[section] ?? {}), ...extra];
        b[section] = Object.fromEntries(section === "scripts" ? merged : merged.sort(([x], [y]) => x.localeCompare(y)));
        changed = true;
      }
      return changed ? Buffer.from(JSON.stringify(b, null, 2) + "\n") : next;
    } catch {
      return next;
    }
  }
  if (/^requirements(?:-dev)?\.txt$/.test(path)) {
    const have = new Set(nxt.split(/\r?\n/).map((l) => parsePipRequirement(l)?.name));
    const extra = cur.split(/\r?\n/).filter((l) => { const r = parsePipRequirement(l); return r && !have.has(r.name); });
    return extra.length ? Buffer.from(appendLines(nxt, extra)) : next;
  }
  if (path === "pyproject.toml") {
    const { toml, added } = addToPyproject(nxt, pyprojectDependencies(cur));
    return added.length ? Buffer.from(toml) : next;
  }
  if (path === ".env.example") {
    const have = new Set(nxt.split(/\r?\n/).map((l) => ENV_LINE.exec(l)?.[1]));
    const lines = cur.split(/\r?\n/);
    const extra = lines.flatMap((l, i) => {
      const key = ENV_LINE.exec(l)?.[1];
      if (!key || have.has(key)) return [];
      return lines[i - 1]?.startsWith("#") ? [lines[i - 1], l] : [l];
    });
    return extra.length ? Buffer.from(appendLines(nxt, extra)) : next;
  }
  return next;
}

type LockFacts = Required<Pick<LockEntry, "builds" | "dependencies">>;

/** The build dependencies and npm/pip packages a build needs, including those in a foundation's own package.json or requirements. */
function factsFromBundle(bundle: Bundle): LockFacts {
  const m = bundle.manifest;
  const text = (p: string) => bundle.files.find((f) => f.path === p && f.encoding !== "base64")?.content ?? "";
  const npm: Record<string, string> = { ...m.dependencies?.npm, ...m.devDependencies?.npm };
  try {
    const pkg = JSON.parse(text("package.json") || "{}");
    Object.assign(npm, pkg.dependencies, pkg.devDependencies);
  } catch {
    // Invalid package.json in a bundle is caught by the registry checks.
  }
  const pip: Record<string, string> = {};
  for (const line of [...text("requirements.txt").split(/\r?\n/), ...text("requirements-dev.txt").split(/\r?\n/), ...pyprojectDependencies(text("pyproject.toml"))]) {
    const r = parsePipRequirement(line);
    if (r) pip[r.name] = r.spec || "*";
  }
  for (const [name, spec] of Object.entries({ ...m.dependencies?.pip, ...m.devDependencies?.pip })) pip[normalizePip(name)] = spec;
  return {
    builds: Object.fromEntries(Object.entries(m.builds ?? {}).map(([id, range]) => [id.toLowerCase(), range])),
    dependencies: { ...(Object.keys(npm).length ? { npm } : {}), ...(Object.keys(pip).length ? { pip } : {}) },
  };
}

/** What pkg.lock.json records about a build's needs; lockfiles from pkg <= 0.1.0 lack it, so ask the registry. */
export async function lockFacts(id: string, entry: LockEntry): Promise<LockFacts> {
  if (entry.builds && entry.dependencies) return { builds: entry.builds, dependencies: entry.dependencies };
  return factsFromBundle({ format: 1, manifest: (await info(id, entry.version)).manifest, files: [] });
}

/** Tags a bundle adds to the project, so later builds in the same install can rely on them. */
function profileFromBundle(bundle: Bundle): Profile {
  const file = (p: string) => bundle.files.find((f) => f.path === p && f.encoding !== "base64")?.content ?? null;
  const parts: Profile[] = [profileFromManifest(bundle.manifest)];
  const pkg = file("package.json");
  if (pkg) {
    try {
      parts.push(profileFromNodeFiles(JSON.parse(pkg), !!file("tsconfig.json")));
    } catch {
      // Invalid package.json in a bundle is caught by the registry checks.
    }
  } else if (file("tsconfig.json")) parts.push({ typescript: null });
  if (file("pyproject.toml") || file("requirements.txt")) parts.push(profileFromPythonFiles(file("pyproject.toml"), file("requirements.txt")));
  return mergeProfiles(...parts);
}

function run(command: string, args: string[], cwd: string, shell: boolean) {
  const options = { cwd, encoding: "utf8" as const, timeout: 600_000, env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" } };
  // Package-manager shims (npm.cmd) need a shell on Windows; only fixed, trusted arguments go through it.
  const res = shell ? spawnSync([command, ...args].join(" "), { ...options, shell: true }) : spawnSync(command, args, options);
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return { ok: res.status === 0, output: res.error ? res.error.message : output.slice(-3000) };
}

function findPython(): string | null {
  for (const cmd of isWin ? ["python", "py"] : ["python3", "python"]) {
    const res = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (res.status === 0) return cmd;
  }
  return null;
}

function venvPython(dir: string): string | null {
  const p = isWin ? join(dir, ".venv", "Scripts", "python.exe") : join(dir, ".venv", "bin", "python");
  return existsSync(p) ? p : null;
}

export function add(specs: string[], opts: AddOptions): Promise<AddResult> {
  return install(specs, opts, "add");
}

/**
 * `pkg update`: moves installed builds to the newest version within their installed
 * major (any version with `latest`). Only files nobody edited since they were
 * installed are replaced; edited ones are left alone and reported as conflicts.
 */
export async function update(specs: string[], opts: UpdateOptions): Promise<AddResult> {
  const dir = resolve(opts.dir);
  const lock = readLock(dir);
  if (!lock || !Object.keys(lock.builds).length) throw new AddError(`no builds are installed in ${dir} (no pkg.lock.json)`);
  const ranges = new Map<string, string>();
  for (const spec of specs.length ? specs : Object.keys(lock.builds)) {
    const p = parseSpec(spec);
    if (!p) throw new AddError(`invalid build "${spec}"; expected owner/name or owner/name@range`);
    const entry = lock.builds[p.id];
    if (!entry) throw new AddError(`${p.id} is not installed in ${dir}; install it with pkg add`);
    ranges.set(p.id, spec.includes("@") ? p.range : opts.latest ? "*" : `^${semver.major(entry.version)}`);
  }
  // Installed builds that stay as they are still need their build dependencies in range.
  const wanted = [...ranges].map(([id, range]) => `${id}@${range}`);
  for (const [id, entry] of Object.entries(lock.builds)) {
    if (ranges.has(id)) continue;
    for (const [dep, range] of Object.entries((await lockFacts(id, entry)).builds)) if (ranges.has(dep)) wanted.push(`${dep}@${range}`);
  }
  return install(wanted, { ...opts, dir }, "update");
}

async function install(specs: string[], opts: AddOptions, mode: AddResult["mode"]): Promise<AddResult> {
  const log = opts.log ?? (() => {});
  const dir = resolve(opts.dir);
  const project = detectProject(dir);
  const lock: Lockfile = project.lock ?? { lockfileVersion: 1, registry: REGISTRY, builds: {} };

  log(`Resolving ${specs.join(", ")} ...`);
  const plan = (await resolvePlan(specs)).builds;

  const skipped: AddResult["skipped"] = [];
  const todo: ResolvedBuild[] = [];
  for (const b of plan) {
    const current = lock.builds[b.id];
    if (current?.version === b.version && (mode === "update" || !opts.force)) skipped.push({ id: b.id, version: b.version, reason: mode === "update" ? "up to date" : "already installed" });
    else todo.push(b);
  }

  log(`Downloading ${todo.map((b) => `${b.id}@${b.version}`).join(", ") || "nothing"} ...`);
  const bundles = await Promise.all(todo.map((b) => fetchBundle(b)));
  for (const [i, bundle] of bundles.entries()) {
    for (const f of bundle.files) {
      const bad = unsafePathReason(f.path);
      if (bad) throw new AddError(`${todo[i].id} contains an unsafe path "${f.path}" (${bad}); refusing to install`);
    }
  }

  // Compatibility: every build must fit the project as it will be once earlier builds are in.
  let profile = project.profile;
  const problems: { id: string; note: string; missing: string[] }[] = [];
  for (const [i, b] of todo.entries()) {
    const c = checkCompat(b.manifest.stack?.requires, profile);
    if (!c.ok) problems.push({ id: b.id, note: describeCompat(c), missing: c.missing });
    // Foundations state their runtime in package.json "engines", the established place for it.
    const engines = bundles[i].files.find((f) => f.path === "package.json")?.content;
    const nodeRange = engines ? (() => { try { return JSON.parse(engines).engines?.node; } catch { return undefined; } })() : undefined;
    if (nodeRange && !semver.satisfies(process.versions.node, nodeRange)) problems.push({ id: b.id, note: `needs Node.js ${nodeRange} (running ${process.versions.node})`, missing: [] });
    profile = mergeProfiles(profile, profileFromBundle(bundles[i]));
  }
  if (problems.length && !opts.force) {
    const missing = [...new Set(problems.flatMap((p) => p.missing))];
    const hints: string[] = [];
    for (const tag of missing.slice(0, 5)) {
      const found = await search(tag, { limit: 5 }).catch(() => null);
      const providers = found?.results.filter((r) => r.provides.includes(tag)).map((r) => r.id) ?? [];
      if (providers.length) hints.push(`"${tag}" is provided by ${providers.join(", ")}`);
    }
    const lines = problems.map((p) => `  ${p.id}: ${p.note}`);
    throw new AddError(
      `these builds don't fit the project${project.empty ? " (the directory is empty: install a foundation first or in the same command)" : ""}:\n${lines.join("\n")}` +
        (hints.length ? `\n${hints.map((h) => `  hint: ${h}`).join("\n")}` : "") +
        `\nInstall the missing pieces in the same command, or pass --force to install anyway.`,
      { problems, hints },
    );
  }

  // Plan file writes and detect conflicts before touching the disk.
  const results: InstalledBuild[] = [];
  const writes: { target: string; bytes: Buffer; executable: boolean; path: string }[] = [];
  const deletes: string[] = [];
  const claimed = new Map<string, { id: string; bytes: Buffer }>();
  const root = dir.endsWith(sep) ? dir : dir + sep;
  const inRun = new Set(todo.map((b) => b.id));
  const shipped = new Set(bundles.flatMap((bundle) => bundle.files.map((f) => f.path)));
  for (const [i, b] of todo.entries()) {
    const bundle = bundles[i];
    const previous = lock.builds[b.id];
    const r: InstalledBuild = { id: b.id, version: b.version, previous: previous?.version ?? null, kind: b.kind, requestedBy: b.requested_by, written: [], unchanged: [], conflicts: [], removed: [], kept: [], integration: bundle.integration ?? null, warnings: b.warnings, env: b.manifest.env ?? {} };
    for (const f of bundle.files) {
      const target = resolve(dir, f.path);
      if (!target.startsWith(root)) throw new AddError(`${b.id}: path escapes the project: ${f.path}`);
      const bytes = fileBytes(f);
      let content = bytes;
      const other = claimed.get(f.path);
      if (other && other.id !== b.id) {
        if (other.bytes.equals(bytes)) { r.unchanged.push(f.path); continue; }
        if (!opts.force) { r.conflicts.push(`${f.path} (also in ${other.id})`); continue; }
      }
      if (existsSync(target)) {
        const current = readFileSync(target);
        if (current.equals(bytes)) { r.unchanged.push(f.path); continue; }
        // A file we installed earlier and nobody edited since can be updated in place.
        const untouched = previous?.files[f.path] === sha256(current);
        if (!untouched && !opts.force) { r.conflicts.push(f.path); continue; }
        content = keepMerged(f.path, current, bytes);
      } else if (previous?.files[f.path] && !opts.force) {
        // Installed earlier and deleted since: that was deliberate.
        r.conflicts.push(`${f.path} (deleted locally)`);
        continue;
      }
      claimed.set(f.path, { id: b.id, bytes });
      writes.push({ target, bytes: content, executable: !!f.executable, path: f.path });
      r.written.push(f.path);
    }
    // Files the installed version had and this one dropped go too, unless edited or still used by another build.
    for (const [path, hash] of Object.entries(previous?.files ?? {})) {
      const target = resolve(dir, path);
      if (shipped.has(path) || unsafePathReason(path) || !target.startsWith(root)) continue;
      if (Object.entries(lock.builds).some(([id, e]) => !inRun.has(id) && path in e.files)) continue;
      const current = fileHash(target);
      if (current === hash) { deletes.push(target); r.removed.push(path); }
      else if (current) r.kept.push(path);
    }
    results.push(r);
  }

  const result: AddResult = { mode, dir, dryRun: !!opts.dryRun, builds: results, skipped, dependencies: { npm: [], pip: [], conflicts: [] }, scripts: [], env: [], install: [], nextSteps: [] };
  if (opts.dryRun || (mode === "update" && !todo.length)) return result;

  for (const w of writes) {
    mkdirSync(dirname(w.target), { recursive: true });
    writeFileSync(w.target, w.bytes);
    if (w.executable && !isWin) chmodSync(w.target, 0o755);
  }
  deleteFiles(dir, deletes);
  const projectName = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "") || "app";
  for (const [i, b] of todo.entries()) {
    if (b.kind !== "foundation") continue;
    if (results[i].written.includes("package.json")) {
      const pkg = readJson(join(dir, "package.json"));
      if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, name: projectName }, null, 2) + "\n");
    }
    if (results[i].written.includes("pyproject.toml")) {
      const toml = readFileSync(join(dir, "pyproject.toml"), "utf8");
      writeFileSync(join(dir, "pyproject.toml"), toml.replace(/^(\[project\][\s\S]*?^name\s*=\s*)["'][^"']*["']/m, `$1"${projectName}"`));
    }
  }

  mergeNpm(dir, todo, result, lock.builds);
  mergePip(dir, todo, result, lock.builds);
  mergeEnv(dir, todo, result);

  // Lockfile: exact versions, integrity and file hashes (lets later updates detect local edits).
  for (const [i, b] of todo.entries()) {
    const files: Record<string, string> = {};
    for (const f of bundles[i].files) {
      const target = join(dir, f.path);
      if (results[i].written.includes(f.path) || results[i].unchanged.includes(f.path)) files[f.path] = sha256(readFileSync(target));
      // Still part of the build but edited or deleted locally: the new version is the base it differs from.
      else if (lock.builds[b.id]?.files[f.path]) files[f.path] = sha256(fileBytes(f));
    }
    const entry: LockEntry = { version: b.version, kind: b.kind, integrity: b.integrity, provides: b.manifest.stack?.provides ?? [], ...factsFromBundle(bundles[i]), files };
    lock.builds[b.id] = entry;
  }
  lock.registry = REGISTRY;
  writeFileSync(join(dir, "pkg.lock.json"), JSON.stringify(lock, null, 2) + "\n");

  if (opts.install !== false) installDependencies(dir, todo, result, log);
  result.nextSteps = nextSteps(dir, result);
  return result;
}

/** A range the previous version of `id` put in the project, that no other installed build relies on, follows that build's updates. */
function ownRange(installed: Record<string, LockEntry>, id: string, eco: "npm" | "pip", name: string): string | undefined {
  if (Object.entries(installed).some(([other, e]) => other !== id && e.dependencies?.[eco]?.[name] !== undefined)) return undefined;
  return installed[id]?.dependencies?.[eco]?.[name];
}

function mergeNpm(dir: string, todo: ResolvedBuild[], result: AddResult, installed: Record<string, LockEntry>) {
  const wanted = todo.filter((b) => b.manifest.dependencies?.npm || b.manifest.devDependencies?.npm || b.manifest.scripts);
  if (!wanted.length) return;
  const path = join(dir, "package.json");
  const pkg = readJson(path) ?? { name: basename(dir).toLowerCase(), version: "0.1.0", private: true, type: "module" };
  for (const b of wanted) {
    for (const [section, deps] of [["dependencies", b.manifest.dependencies?.npm], ["devDependencies", b.manifest.devDependencies?.npm]] as const) {
      for (const [name, range] of Object.entries(deps ?? {})) {
        const existing = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
        if (existing && existing !== range && existing === ownRange(installed, b.id, "npm", name)) {
          pkg[pkg.dependencies?.[name] !== undefined ? "dependencies" : "devDependencies"][name] = range;
          result.dependencies.npm.push(`${name}@${range}`);
          continue;
        }
        if (existing) {
          const compatible = (() => { try { return semver.intersects(existing, range); } catch { return true; } })();
          if (!compatible) result.dependencies.conflicts.push(`${name}: project has ${existing}, ${b.id} wants ${range}`);
          continue;
        }
        pkg[section] = Object.fromEntries(Object.entries({ ...(pkg[section] ?? {}), [name]: range }).sort(([a], [z]) => a.localeCompare(z)));
        result.dependencies.npm.push(`${name}@${range}`);
      }
    }
    for (const [name, script] of Object.entries(b.manifest.scripts ?? {})) {
      pkg.scripts ??= {};
      if (pkg.scripts[name] === undefined) {
        pkg.scripts[name] = script;
        result.scripts.push(name);
      }
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
}

/** Adds requirement lines to [project].dependencies, skipping packages already listed. */
function addToPyproject(toml: string, lines: string[]): { toml: string; added: string[] } {
  const m = /^(\[project\][\s\S]*?^dependencies\s*=\s*\[)([\s\S]*?)(\])/m.exec(toml);
  const have = new Set(m ? [...m[2].matchAll(/["']([^"']+)["']/g)].map((x) => parsePipRequirement(x[1])?.name) : []);
  const added = lines.filter((l) => !have.has(normalizePip(parsePipRequirement(l)?.name ?? "")));
  if (!added.length) return { toml, added };
  if (m) {
    const body = m[2].trimEnd();
    const sep = body && !body.endsWith(",") ? "," : "";
    toml = toml.replace(m[0], `${m[1]}${body}${sep}\n${added.map((l) => `    "${l}",`).join("\n")}\n${m[3]}`);
  } else {
    toml = toml.replace(/^\[project\]\s*$/m, `[project]\ndependencies = [\n${added.map((l) => `    "${l}",`).join("\n")}\n]`);
  }
  return { toml, added };
}

function mergePip(dir: string, todo: ResolvedBuild[], result: AddResult, installed: Record<string, LockEntry>) {
  const reqs = (dev: boolean) => todo.flatMap((b) => Object.entries((dev ? b.manifest.devDependencies : b.manifest.dependencies)?.pip ?? {})
    .map(([n, s]) => ({ line: `${n}${s === "*" ? "" : s}`, own: ownRange(installed, b.id, "pip", normalizePip(n)) })));
  const runtime = reqs(false);
  const dev = reqs(true);
  if (!runtime.length && !dev.length) return;

  const pyprojectPath = join(dir, "pyproject.toml");
  const reqPath = join(dir, "requirements.txt");
  const devPath = join(dir, "requirements-dev.txt");
  const appendTo = (path: string, wanted: typeof runtime) => {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const lines = current.split(/\r?\n/);
    const add: string[] = [];
    let bumped = false;
    for (const { line, own } of wanted) {
      const name = parsePipRequirement(line)?.name;
      const at = lines.findIndex((l) => parsePipRequirement(l)?.name === name);
      if (at === -1) {
        if (!add.some((l) => parsePipRequirement(l)?.name === name)) add.push(line);
      } else if (own !== undefined && parsePipRequirement(lines[at])!.spec === (own === "*" ? "" : own) && lines[at].trim() !== line) {
        // Pinned by this build's previous version: move the pin along with the update.
        lines[at] = line;
        bumped = true;
        result.dependencies.pip.push(line);
      }
    }
    if (!add.length && !bumped) return;
    const text = lines.join(current.includes("\r\n") ? "\r\n" : "\n");
    writeFileSync(path, add.length ? appendLines(text, add) : text);
    result.dependencies.pip.push(...add);
  };

  if (existsSync(reqPath) || !existsSync(pyprojectPath)) {
    appendTo(reqPath, runtime);
    appendTo(existsSync(devPath) ? devPath : reqPath, dev);
    return;
  }
  // pyproject.toml without requirements.txt: insert into [project].dependencies.
  const { toml, added } = addToPyproject(readFileSync(pyprojectPath, "utf8"), [...runtime, ...dev].map((r) => r.line));
  if (!added.length) return;
  writeFileSync(pyprojectPath, toml);
  result.dependencies.pip.push(...added);
}

function mergeEnv(dir: string, todo: ResolvedBuild[], result: AddResult) {
  const path = join(dir, ".env.example");
  let current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => ENV_LINE.exec(l)?.[1]).filter(Boolean));
  let changed = false;
  for (const b of todo) {
    for (const [key, v] of Object.entries(b.manifest.env ?? {})) {
      if (have.has(key)) continue;
      current += `${current && !current.endsWith("\n") ? "\n" : ""}# ${b.id}: ${v.description ?? ""}${v.required ? " (required)" : ""}\n${key}=${v.example ?? ""}\n`;
      have.add(key);
      result.env.push(key);
      changed = true;
    }
  }
  if (changed) writeFileSync(path, current);
}

function installDependencies(dir: string, todo: ResolvedBuild[], result: AddResult, log: (m: string) => void) {
  const project = detectProject(dir);
  const wroteNode = result.builds.some((b) => b.written.includes("package.json"));
  if (project.npm && (result.dependencies.npm.length || wroteNode || !existsSync(join(dir, "node_modules")))) {
    const pm = project.npm;
    log(`Installing npm dependencies with ${pm} ...`);
    const res = run(pm, ["install"], dir, isWin);
    result.install.push({ command: `${pm} install`, ok: res.ok, output: res.ok ? undefined : res.output });
  }

  const wrotePython = result.builds.some((b) => b.written.some((p) => /^(?:pyproject\.toml|requirements(?:-dev)?\.txt)$/.test(p)));
  if (project.python && (result.dependencies.pip.length || wrotePython)) {
    let py = venvPython(dir);
    if (!py) {
      const system = findPython();
      if (!system) {
        result.install.push({ command: "python -m venv .venv", ok: false, output: "Python was not found on PATH" });
        return;
      }
      log("Creating .venv ...");
      const res = run(system, ["-m", "venv", ".venv"], dir, false);
      py = venvPython(dir);
      if (!res.ok || !py) {
        result.install.push({ command: `${system} -m venv .venv`, ok: false, output: res.output });
        return;
      }
    }
    const reqFile = existsSync(join(dir, "requirements-dev.txt")) ? "requirements-dev.txt" : existsSync(join(dir, "requirements.txt")) ? "requirements.txt" : null;
    const args = reqFile
      ? ["-m", "pip", "install", "-q", "-r", reqFile]
      : ["-m", "pip", "install", "-q", ...pyprojectDependencies(readFileSync(join(dir, "pyproject.toml"), "utf8"))];
    log(`Installing Python dependencies into .venv ...`);
    const res = run(py, args, dir, false);
    result.install.push({ command: `.venv python ${args.join(" ")}`, ok: res.ok, output: res.ok ? undefined : res.output });
  }
}

function nextSteps(dir: string, r: AddResult): string[] {
  const steps: string[] = [];
  if (r.builds.some((b) => b.integration)) steps.push(r.mode === "update" ? "Check the integration notes (above) for changes the new versions need in your code." : "Follow the integration notes for each build (above).");
  const conflicted = r.builds.filter((b) => b.conflicts.length);
  if (conflicted.length) {
    const urls = conflicted.map((b) => `${REGISTRY}/api/builds/${b.id}/files/<path>?version=${b.version}`);
    steps.push(`Resolve the conflicting files: they already existed or were edited locally, and were left untouched. Merge in the build's version by hand (${urls.join(", ")}) or rerun with --force to overwrite them.`);
  }
  if (r.builds.some((b) => b.kept.length)) steps.push("Files the new versions no longer ship were kept because they were edited locally; delete them once nothing uses them.");
  if (r.dependencies.conflicts.length) steps.push(`Check dependency version conflicts: ${r.dependencies.conflicts.join("; ")}.`);
  const required = r.builds.flatMap((b) => Object.entries(b.env).filter(([, v]) => v.required).map(([k]) => k));
  if (required.length) steps.push(`Set ${required.join(", ")} for production (examples were added to .env.example).`);
  if (r.install.some((i) => !i.ok)) steps.push("Dependency installation failed; see the output and install manually.");
  const pkg = readJson(join(dir, "package.json"));
  if (pkg?.scripts?.test) steps.push("Run the tests: npm test");
  else if (existsSync(join(dir, ".venv"))) steps.push(`Run the tests: ${isWin ? ".venv\\Scripts\\python" : ".venv/bin/python"} -m pytest`);
  const ids = r.builds.map((b) => b.id);
  if (ids.length) steps.push(`When it works (or doesn't), report it so others benefit: pkg feedback ${ids.join(" ")} --worked  (or --failed "what went wrong")`);
  return steps;
}

/** Human/agent-readable summary of an install or update. */
export function formatAddResult(r: AddResult): string {
  const out: string[] = [];
  const update = r.mode === "update";
  out.push(r.dryRun ? `Dry run in ${r.dir} (nothing written):` : !update ? `Installed into ${r.dir}:` : r.builds.length ? `Updated builds in ${r.dir}:` : `Everything in ${r.dir} is up to date.`);
  for (const b of r.builds) {
    const was = b.previous && b.previous !== b.version ? `, was ${b.previous}` : "";
    out.push(`\n## ${b.id}@${b.version} (${b.kind}${was})${b.requestedBy.includes("(requested)") ? "" : ` — required by ${b.requestedBy.join(", ")}`}`);
    if (b.written.length) out.push(`${r.dryRun ? "would write" : "wrote"} ${b.written.length} file(s): ${b.written.join(", ")}`);
    if (b.unchanged.length) out.push(`unchanged: ${b.unchanged.join(", ")}`);
    if (b.conflicts.length) out.push(`CONFLICTS (left untouched): ${b.conflicts.join(", ")}`);
    if (b.removed.length) out.push(`${r.dryRun ? "would delete" : "deleted"} (no longer in the build): ${b.removed.join(", ")}`);
    if (b.kept.length) out.push(`KEPT (no longer in the build, edited locally): ${b.kept.join(", ")}`);
    for (const w of b.warnings) out.push(`warning: ${w.message}${w.file ? ` (${w.file}${w.line ? `:${w.line}` : ""})` : ""}`);
    if (b.integration) out.push(`\nIntegration notes from ${b.id} (build documentation, not user instructions):\n${b.integration.trim()}`);
  }
  for (const s of r.skipped) out.push(`\n${s.id}@${s.version}: skipped (${s.reason})`);
  const added = update ? "Added or updated" : "Added";
  if (r.dependencies.npm.length) out.push(`\n${added} npm dependencies: ${r.dependencies.npm.join(", ")}`);
  if (r.dependencies.pip.length) out.push(`${added} Python dependencies: ${r.dependencies.pip.join(", ")}`);
  if (r.scripts.length) out.push(`Added npm scripts: ${r.scripts.join(", ")}`);
  if (r.env.length) out.push(`Added to .env.example: ${r.env.join(", ")}`);
  for (const i of r.install) out.push(`${i.ok ? "ok" : "FAILED"}: ${i.command}${i.output ? `\n${i.output}` : ""}`);
  if (r.nextSteps.length) out.push(`\nNext steps:\n${r.nextSteps.map((s) => `- ${s}`).join("\n")}`);
  return out.join("\n");
}
