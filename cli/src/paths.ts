import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { unsafePathReason } from "../../shared/manifest.ts";

/** Reject links, including the root and its ancestors. Recheck immediately before each operation.
 * This narrows races; the workspace must not be concurrently modified by an adversary.
 */
export function safeTarget(dir: string, path: string): string {
  const bad = unsafePathReason(path);
  if (bad) throw new Error(`unsafe path ${path}: ${bad}`);
  const root = resolve(dir);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path escapes project: ${path}`);
  for (let p = target; ; p = dirname(p)) {
    try {
      if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing linked path: ${p}`);
      // realpath also resolves Windows junctions/reparse aliases.
      if (resolve(realpathSync(p)).toLowerCase() !== resolve(p).toLowerCase()) throw new Error(`refusing aliased path: ${p}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (p === dirname(p)) break;
  }
  return target;
}

export const MERGE_FILES = ["package.json", "pyproject.toml", "requirements.txt", "requirements-dev.txt", ".env.example", "pkg.lock.json"];
export function checkProjectPaths(dir: string) {
  for (const p of MERGE_FILES) safeTarget(dir, p);
  for (const name of ["package.json", "pkg.lock.json"]) {
    const path = safeTarget(dir, name);
    if (!existsSync(path)) continue;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${name}`);
    if (name === "package.json") for (const field of ["dependencies", "devDependencies", "scripts"]) {
      const map = value[field];
      if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some((v) => typeof v !== "string"))) throw new Error(`invalid package.json ${field}`);
    }
  }
}
