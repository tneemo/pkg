// The pkg.json manifest and the bundle format shared by the CLI and the registry.
import semver from "semver";
import { validRange as validPipRange } from "@renovatebot/pep440";
import { manifestSchema } from "./schema.ts";
import { validateShape } from "./schema-shape.ts";

export type Kind = "module" | "foundation";
export type Ecosystem = "npm" | "pip";

export interface EnvVar {
  description?: string;
  example?: string;
  required?: boolean;
}

export interface Manifest {
  $schema?: string;
  name: string;
  version: string;
  kind: Kind;
  description: string;
  license: string;
  keywords?: string[];
  stack?: {
    /** Tags the target project must have, mapped to a semver range ("*" = any version). */
    requires?: Record<string, string>;
    /** Tags this build adds to the project once installed. */
    provides?: string[];
  };
  dependencies?: Partial<Record<Ecosystem, Record<string, string>>>;
  devDependencies?: Partial<Record<Ecosystem, Record<string, string>>>;
  /** Other pkg builds this one needs, "owner/name" -> semver range. */
  builds?: Record<string, string>;
  /** Globs of files to install. Defaults to every file except metadata files. */
  files?: string[];
  /** Folder in the target project where files are placed, e.g. "src/todos" (default: project root). */
  base?: string;
  env?: Record<string, EnvVar>;
  /** npm scripts merged into the project's package.json when missing. */
  scripts?: Record<string, string>;
  repository?: string;
  homepage?: string;
}

export interface BundleFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  executable?: boolean;
}

/** What gets uploaded on publish and downloaded on install (gzipped JSON). */
export interface Bundle {
  format: 1;
  manifest: Manifest;
  readme?: string;
  integration?: string;
  files: BundleFile[];
}

/** Files that describe a build but are never copied into a project. */
export const METADATA_FILES = ["pkg.json", "README.md", "INTEGRATION.md"];

export const LIMITS = {
  maxFiles: 1000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 5_000_000,
  maxDescription: 300,
  maxKeywords: 20,
};

export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const TAG_RE = /^[a-z0-9@][a-z0-9.+_:/@-]{0,80}$/;
const SPEC_RE = /^([a-z0-9-]+)\/([a-z0-9-]+)(?:@(.+))?$/;

/** Parses "owner/name" or "owner/name@range". */
export function parseSpec(spec: string): { owner: string; name: string; id: string; range: string } | null {
  const m = SPEC_RE.exec(spec.trim().toLowerCase());
  if (!m) return null;
  const range = m[3] ?? "*";
  if (range !== "latest" && !semver.validRange(range)) return null;
  return { owner: m[1], name: m[2], id: `${m[1]}/${m[2]}`, range: range === "latest" ? "*" : range };
}

/** Returns a list of human-readable problems; empty means the manifest is valid. */
export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["pkg.json must be a JSON object"];
  const x = m as Record<string, any>;
  const str = (k: string) => typeof x[k] === "string" && x[k].trim() !== "";

  if (!str("name") || !NAME_RE.test(x.name)) errors.push('"name" must be lowercase letters, digits and dashes (max 50 chars), e.g. "auth-jwt"');
  if (!str("version") || !semver.valid(x.version)) errors.push('"version" must be a valid semver version, e.g. "1.0.0"');
  if (x.kind !== "module" && x.kind !== "foundation") errors.push('"kind" must be "module" (adds to an existing project) or "foundation" (starts a new project)');
  if (!str("description")) errors.push('"description" is required');
  else if (x.description.length > LIMITS.maxDescription) errors.push(`"description" must be at most ${LIMITS.maxDescription} characters`);
  if (!str("license")) errors.push('"license" is required (an SPDX id such as "MIT")');

  if (x.keywords !== undefined) {
    if (!Array.isArray(x.keywords) || x.keywords.some((k: unknown) => typeof k !== "string")) errors.push('"keywords" must be an array of strings');
    else if (x.keywords.length > LIMITS.maxKeywords) errors.push(`"keywords" may have at most ${LIMITS.maxKeywords} entries`);
  }

  if (x.stack !== undefined) {
    if (typeof x.stack !== "object" || x.stack === null || Array.isArray(x.stack)) errors.push('"stack" must be an object');
    else {
      const { requires, provides } = x.stack;
      if (requires !== undefined) {
        if (typeof requires !== "object" || requires === null || Array.isArray(requires)) errors.push('"stack.requires" must map tags to semver ranges, e.g. {"hono": ">=4"}');
        else for (const [tag, range] of Object.entries(requires)) {
          if (!TAG_RE.test(tag)) errors.push(`"stack.requires": invalid tag "${tag}"`);
          if (typeof range !== "string" || !semver.validRange(range)) errors.push(`"stack.requires.${tag}": invalid semver range`);
        }
      }
      if (provides !== undefined) {
        if (!Array.isArray(provides) || provides.some((t: unknown) => typeof t !== "string" || !TAG_RE.test(t))) errors.push('"stack.provides" must be an array of lowercase tags');
      }
    }
  }

  for (const field of ["dependencies", "devDependencies"]) {
    const deps = x[field];
    if (deps === undefined) continue;
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) { errors.push(`"${field}" must be an object like {"npm": {"zod": "^3"}}`); continue; }
    for (const [eco, map] of Object.entries(deps)) {
      if (eco !== "npm" && eco !== "pip") errors.push(`"${field}.${eco}": supported ecosystems are "npm" and "pip"`);
      else if (typeof map !== "object" || map === null || Array.isArray(map)) errors.push(`"${field}.${eco}" must map package names to version ranges`);
      else for (const [name, range] of Object.entries(map)) {
        if (!validDependency(eco, name, range)) errors.push(`"${field}.${eco}.${name}": invalid package name or version range (registry packages only)`);
      }
    }
  }

  if (x.builds !== undefined) {
    if (typeof x.builds !== "object" || x.builds === null || Array.isArray(x.builds)) errors.push('"builds" must map "owner/name" to semver ranges');
    else for (const [id, range] of Object.entries(x.builds)) {
      if (typeof range !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(id) || !parseSpec(`${id}@${range}`)) errors.push(`"builds": invalid entry "${id}": "${range}"`);
    }
  }

  if (x.base !== undefined && (typeof x.base !== "string" || unsafePathReason(x.base))) errors.push('"base" must be a relative folder such as "src/todos"');
  if (x.files !== undefined && (!Array.isArray(x.files) || x.files.some((f: unknown) => typeof f !== "string"))) errors.push('"files" must be an array of glob strings');

  if (x.env !== undefined) {
    if (typeof x.env !== "object" || x.env === null || Array.isArray(x.env)) errors.push('"env" must map variable names to {description, example, required}');
    else for (const [key, value] of Object.entries(x.env)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) errors.push(`"env": invalid variable name "${key}"`);
      const v = value as Record<string, unknown>;
      if (!v || typeof v !== "object" || Array.isArray(v) ||
        Object.keys(v).some((k) => !["description", "example", "required"].includes(k)) ||
        ["description", "example"].some((k) => v[k] !== undefined && (typeof v[k] !== "string" || /[\r\n\0]/.test(v[k] as string))) ||
        (v.required !== undefined && typeof v.required !== "boolean")) errors.push(`"env.${key}": invalid variable definition`);
    }
  }

  if (x.scripts !== undefined && (typeof x.scripts !== "object" || x.scripts === null || Array.isArray(x.scripts) || Object.entries(x.scripts).some(([k, v]) => !/^[a-zA-Z0-9:_-]+$/.test(k) || typeof v !== "string"))) errors.push('"scripts" must map script names to commands');

  for (const k of ["repository", "homepage"]) {
    if (x[k] !== undefined && (typeof x[k] !== "string" || !/^https:\/\//.test(x[k]))) errors.push(`"${k}" must be an https URL`);
  }
  return [...errors, ...validateShape(m, manifestSchema)];
}

/**
 * Rejects paths that could escape the project directory or touch git internals.
 * Paths are always POSIX-style and relative.
 */
export function unsafePathReason(path: string): string | null {
  if (!path || path.length > 300) return "empty or too long";
  if (path.includes("\\")) return "backslashes are not allowed";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "absolute paths are not allowed";
  if (/[\x00-\x1f\x7f:<>"|?*]/.test(path)) return "control characters or Windows path aliases are not allowed";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "path segments '.', '..' and empty segments are not allowed";
  if (parts.some((p) => /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p) || p.includes("~"))) return "Windows aliases and reserved names are not allowed";
  if (parts.some((p) => p.toLowerCase() === ".git")) return ".git directories are not allowed";
  if (parts.some((p) => p.toLowerCase() === "node_modules")) return "node_modules is not allowed";
  return null;
}

/** Deliberately limited registry-only subset: no URLs, options, local/VCS references or markers. */
export function validDependency(eco: string, name: string, range: unknown): range is string {
  if (typeof range !== "string" || range.length > 200 || /[\x00-\x1f\x7f]/.test(range)) return false;
  if (eco === "npm") return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214 && !!semver.validRange(range);
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)*\])?$/.test(name) &&
    (range === "*" || range === "" || (/^(?:~=|==|!=|<=|>=|<|>)[0-9][A-Za-z0-9.*+!_-]*(?:\s*,\s*(?:~=|==|!=|<=|>=|<|>)[0-9][A-Za-z0-9.*+!_-]*)*$/.test(range) && validPipRange(range)));
}

export function validateBundle(b: unknown): string[] {
  if (!b || typeof b !== "object") return ["bundle must be an object"];
  const x = b as Bundle;
  const errors = validateManifest(x.manifest);
  if (x.format !== 1 || !Array.isArray(x.files)) return [...errors, "unsupported bundle format"];
  if ([x.readme, x.integration].some((s) => s !== undefined && typeof s !== "string")) errors.push("documentation must be text");
  for (const f of x.files) {
    if (!f || typeof f !== "object" || typeof f.path !== "string" || typeof f.content !== "string" ||
      (f.encoding !== undefined && f.encoding !== "utf8" && f.encoding !== "base64") ||
      (f.executable !== undefined && typeof f.executable !== "boolean")) { errors.push("invalid bundle file"); continue; }
    if (f.encoding === "base64" && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content)) errors.push(`invalid base64: ${f.path}`);
  }
  return errors;
}

/** Decode textual base64 before applying the same inspection and install policy. */
export function decodedText(file: BundleFile): string | null {
  if (file.encoding !== "base64") return file.content;
  try {
    const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch { return null; }
}

/** Normalizes a Python package name per PEP 503. */
export function normalizePip(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** SRI-style sha256 of some bytes, e.g. "sha256-abc…=". */
export async function integrityOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `sha256-${btoa(bin)}`;
}
