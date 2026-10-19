// `pkg init` (write pkg.json from what's on disk) and `pkg publish` (bundle, check, upload).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { checkBundle, type CheckReport } from "../../shared/checks.ts";
import { NPM_TAGS, PIP_TAGS, parsePipRequirement, pyprojectDependencies } from "../../shared/compat.ts";
import { NAME_RE, validateManifest, type Bundle, type BundleFile, type Manifest } from "../../shared/manifest.ts";
import { detectProject, readJson } from "./detect.ts";
import { publish as upload, REGISTRY } from "./registry.ts";

const ALWAYS_EXCLUDED = /(?:^|\/)(?:\.git|node_modules)(?:\/|$)|(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]*)?$|^pkg\.lock\.json$/;
const DEFAULT_EXCLUDED = /(?:^|\/)(?:dist|coverage|\.next|\.turbo|\.wrangler|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.DS_Store|Thumbs\.db)(?:\/|$)|\.pyc$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|\.env)$|\.log$/;

/** Minimal glob support: ** (any depth), * (within a segment), ? (one char). A bare directory matches its contents. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, "");
  if (!/[*?]/.test(g) && !/\.[^/]+$/.test(g)) g = g.replace(/\/?$/, "/**");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(base, full).split("\\").join("/");
    if (ALWAYS_EXCLUDED.test(rel) || DEFAULT_EXCLUDED.test(rel)) continue;
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** Files that would be published: git-tracked + untracked-but-not-ignored when in a repo, else a filtered walk. */
export function listFiles(dir: string, manifest: Pick<Manifest, "files">): string[] {
  const git = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: dir, encoding: "utf8" });
  let files = git.status === 0 ? git.stdout.split("\0").filter(Boolean) : walk(dir);
  // README.md is installable only when listed in "files"; pkg.json and INTEGRATION.md never are.
  files = files.filter((f) => existsSync(join(dir, f)) && !ALWAYS_EXCLUDED.test(f) && f !== "pkg.json" && f !== "INTEGRATION.md");
  if (manifest.files?.length) {
    const patterns = manifest.files.map(globToRegExp);
    return files.filter((f) => patterns.some((re) => re.test(f))).sort();
  }
  return files.filter((f) => !DEFAULT_EXCLUDED.test(f) && f !== "README.md").sort();
}

function readFile(dir: string, path: string): BundleFile {
  const buf = readFileSync(join(dir, path));
  const executable = process.platform !== "win32" && (statSync(join(dir, path)).mode & 0o111) !== 0;
  let text: string | null = null;
  if (!buf.subarray(0, 8000).includes(0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      text = null;
    }
  }
  return text === null
    ? { path, content: buf.toString("base64"), encoding: "base64", ...(executable ? { executable } : {}) }
    : { path, content: text, ...(executable ? { executable } : {}) };
}

export function loadManifest(dir: string): Manifest {
  const path = join(dir, "pkg.json");
  if (!existsSync(path)) throw new Error(`no pkg.json in ${dir}; run \`pkg init\` first`);
  const m = readJson(path);
  if (!m) throw new Error(`${path} is not valid JSON`);
  return m;
}

export function buildBundle(dir: string): { bundle: Bundle; report: CheckReport } {
  const manifest = loadManifest(dir);
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`pkg.json is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
  const bundle: Bundle = {
    format: 1,
    manifest,
    readme: read("README.md"),
    integration: read("INTEGRATION.md"),
    files: listFiles(dir, manifest).map((f) => ({ ...readFile(dir, f), path: manifest.base ? `${manifest.base}/${f}` : f })),
  };
  return { bundle, report: checkBundle(bundle) };
}

/** GitHub token from the environment or the gh CLI. pkg has no accounts of its own. */
export function findToken(): string | null {
  for (const key of ["PKG_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) if (process.env[key]) return process.env[key]!;
  const gh = process.platform === "win32" ? spawnSync("gh auth token", { encoding: "utf8", shell: true }) : spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return gh.status === 0 && gh.stdout.trim() ? gh.stdout.trim() : null;
}

async function githubLogin(token: string): Promise<string | null> {
  const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, "user-agent": "pkg-cli" } }).catch(() => null);
  if (!res?.ok) return null;
  return String(((await res.json()) as { login: string }).login).toLowerCase();
}

export async function publish(dir: string, opts: { owner?: string; dryRun?: boolean }) {
  const { bundle, report } = buildBundle(resolve(dir));
  const id = `${opts.owner ?? "<you>"}/${bundle.manifest.name}@${bundle.manifest.version}`;
  if (report.risk === "error" || opts.dryRun) return { published: false as const, id, bundle, report };

  const token = findToken();
  if (!token) throw new Error("publishing needs a GitHub identity: run `gh auth login`, or set GITHUB_TOKEN. pkg has no separate accounts.");
  const owner = opts.owner?.toLowerCase() ?? (await githubLogin(token));
  if (!owner) throw new Error("could not determine your GitHub login from the token; pass --owner <login-or-org>");
  const gz = gzipSync(JSON.stringify(bundle));
  const res = await upload(gz, token, owner);
  return { published: true as const, id: `${res.id}@${res.version}`, url: `${REGISTRY}/${res.id}`, bundle, report: { risk: res.risk as CheckReport["risk"], quality: res.quality, findings: res.findings } };
}

// ---------------------------------------------------------------- pkg init

const FRAMEWORK_TAGS = new Set(["nextjs", "react", "vue", "nuxt", "svelte", "sveltekit", "astro", "solid", "angular", "express", "hono", "fastify", "koa", "nestjs", "remix", "react-router", "expo", "react-native", "electron", "tailwind", "drizzle", "prisma", "trpc", "fastapi", "django", "flask", "sqlalchemy", "cloudflare-workers"]);

/** Packages imported by JS/TS or Python sources in a folder, plus the project files they import. */
function scanImports(dir: string, root: string): { npm: Set<string>; pip: Set<string>; local: Set<string> } {
  const npm = new Set<string>();
  const pip = new Set<string>();
  const local = new Set<string>();
  const firstExisting = (base: string, exts: string[]) => exts.map((e) => base + e).find((p) => existsSync(p) && statSync(p).isFile());
  for (const file of walk(dir)) {
    const full = join(dir, file);
    if (/\.[cm]?[jt]sx?$/.test(file)) {
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith("node:")) continue;
        if (spec.startsWith(".")) {
          const target = firstExisting(resolve(dirname(full), spec), ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"]);
          if (target) local.add(relative(root, target).split("\\").join("/"));
        } else npm.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    } else if (file.endsWith(".py")) {
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm)) {
        const mod = m[1] ?? m[2];
        const target = firstExisting(join(root, ...mod.split(".")), [".py", "/__init__.py"]);
        if (target) local.add(relative(root, target).split("\\").join("/"));
        else pip.add(mod.split(".")[0].toLowerCase());
      }
    }
  }
  return { npm, pip, local };
}

/** Walks up to find the project a folder belongs to (for modules published from inside a project). */
function findProjectRoot(dir: string): string {
  let cur = dir;
  for (;;) {
    if (["package.json", "pyproject.toml", "requirements.txt"].some((f) => existsSync(join(cur, f)))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
}

export function init(dir: string, opts: { name?: string; kind?: "module" | "foundation"; force?: boolean }) {
  dir = resolve(dir);
  const path = join(dir, "pkg.json");
  if (existsSync(path) && !opts.force) throw new Error(`${path} already exists (use --force to overwrite)`);
  const ownPkg = readJson(join(dir, "package.json"));
  const ownPy = existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "requirements.txt"));
  const kind = opts.kind ?? (ownPkg || ownPy ? "foundation" : "module");
  const root = findProjectRoot(dir);
  const project = detectProject(root);
  const rootPkg = readJson(join(root, "package.json"));

  const rawName = opts.name ?? String(ownPkg?.name ?? basename(dir)).replace(/^@[^/]+\//, "");
  const name = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

  // Requirements: the language plus the frameworks the code is built on, pinned to the major in use.
  const requires: Record<string, string> = {};
  const provides: string[] = [];
  for (const [tag, version] of Object.entries(project.profile)) {
    if (!(FRAMEWORK_TAGS.has(tag) || tag === "typescript" || tag === "python")) continue;
    const range = version ? `>=${version.split(".")[0]}` : "*";
    if (kind === "foundation") provides.push(tag);
    else requires[tag] = tag === "typescript" ? "*" : range;
  }
  if (kind === "foundation") {
    if (project.profile.node) { requires.node = `>=${project.profile.node.split(".")[0]}`; provides.unshift("node"); }
    if (project.profile.python !== undefined) requires.python = project.profile.python ? `>=${project.profile.python.split(".").slice(0, 2).join(".")}` : "*";
  }

  // Dependencies a module actually imports, with the version range the project uses.
  const dependencies: Manifest["dependencies"] = {};
  if (kind === "module") {
    const imports = scanImports(dir, root);
    const known = { ...(rootPkg?.devDependencies ?? {}), ...(rootPkg?.dependencies ?? {}) } as Record<string, string>;
    const npmDeps = Object.fromEntries([...imports.npm].filter((n) => known[n] && !NPM_TAGS[n] && n !== "typescript").map((n) => [n, known[n]]));
    // Framework packages are covered by stack.requires; everything else imported becomes a dependency.
    for (const n of imports.npm) if (known[n] && NPM_TAGS[n] && !FRAMEWORK_TAGS.has(NPM_TAGS[n]) && NPM_TAGS[n] !== "typescript") npmDeps[n] = known[n];
    if (Object.keys(npmDeps).length) dependencies.npm = npmDeps;
    const pyLines = [
      ...(existsSync(join(root, "pyproject.toml")) ? pyprojectDependencies(readFileSync(join(root, "pyproject.toml"), "utf8")) : []),
      ...(existsSync(join(root, "requirements.txt")) ? readFileSync(join(root, "requirements.txt"), "utf8").split(/\r?\n/) : []),
    ].map(parsePipRequirement).filter((r): r is { name: string; spec: string } => !!r);
    const pipDeps = Object.fromEntries(pyLines.filter((r) => imports.pip.has(r.name.replace(/-/g, "_")) && !(PIP_TAGS[r.name] && FRAMEWORK_TAGS.has(PIP_TAGS[r.name]))).map((r) => [r.name, r.spec || "*"]));
    if (Object.keys(pipDeps).length) dependencies.pip = pipDeps;
  }

  // Files inside the module that other code imports keep their place in the project layout.
  const base = kind === "module" && root !== dir ? relative(root, dir).split("\\").join("/") : "";
  // Imports of files that came from installed builds become build dependencies.
  const builds: Record<string, string> = {};
  if (kind === "module") {
    const lock = project.lock?.builds ?? {};
    for (const file of scanImports(dir, root).local) {
      if (base && file.startsWith(`${base}/`)) continue;
      const owner = Object.entries(lock).find(([, b]) => file in b.files);
      if (owner) builds[owner[0]] = `^${owner[1].version}`;
    }
  }

  const manifest: Manifest = {
    $schema: `${REGISTRY}/schema/pkg.json`,
    name: NAME_RE.test(name) ? name : "my-build",
    version: typeof ownPkg?.version === "string" && /^\d+\.\d+\.\d+/.test(ownPkg.version) ? ownPkg.version : "0.1.0",
    kind,
    description: String(ownPkg?.description ?? ""),
    license: String(ownPkg?.license ?? "MIT"),
    keywords: Array.isArray(ownPkg?.keywords) ? ownPkg.keywords.slice(0, 20) : [],
    stack: { requires, provides },
    ...(base ? { base } : {}),
    ...(Object.keys(builds).length ? { builds } : {}),
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
  };
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  const todo = [
    !manifest.description && 'write a "description" in pkg.json',
    !existsSync(join(dir, "README.md")) && "add README.md (what the build does, shown on its page)",
    !existsSync(join(dir, "INTEGRATION.md")) && "add INTEGRATION.md (exact steps an agent takes after installing: imports, wiring, config)",
    "review stack.requires / stack.provides and dependencies",
    "run `pkg publish --dry-run` to see the checks, then `pkg publish`",
  ].filter(Boolean) as string[];
  return { path, manifest, files: listFiles(dir, manifest), todo };
}
