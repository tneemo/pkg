// `pkg remove`: delete the files a build installed that nobody edited since, drop
// it from pkg.lock.json, and list the packages no installed build needs any more.
// package.json and requirements files are left alone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parsePipRequirement, pyprojectDependencies } from "../../shared/compat.ts";
import { parseSpec, unsafePathReason } from "../../shared/manifest.ts";
import { detectProject, readJson } from "./detect.ts";
import { AddError, deleteFiles, fileHash, lockFacts } from "./install.ts";
import { checkProjectPaths, safeTarget } from "./paths.ts";

export interface RemoveOptions {
  dir: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface RemovedBuild {
  id: string;
  version: string;
  deleted: string[];
  /** Files left in place, with the reason (edited locally, or shared with a build that stays). */
  kept: string[];
}

export interface RemoveResult {
  dir: string;
  dryRun: boolean;
  builds: RemovedBuild[];
  /** Installed builds that depend on a removed one (only when forced). */
  dependents: string[];
  /** Installed builds only the removed ones depended on. */
  orphans: string[];
  /** Packages the removed builds needed and no remaining build declares; still in package.json / requirements. */
  unused: { npm: string[]; pip: string[] };
  nextSteps: string[];
}

export async function remove(specs: string[], opts: RemoveOptions): Promise<RemoveResult> {
  const dir = resolve(opts.dir);
  checkProjectPaths(dir);
  const project = detectProject(dir);
  const lock = project.lock;
  if (!lock) throw new AddError(`no builds are installed in ${dir} (no pkg.lock.json)`);
  const removing = new Set<string>();
  for (const spec of specs) {
    const p = parseSpec(spec);
    if (!p) throw new AddError(`invalid build "${spec}"; expected owner/name`);
    if (!lock.builds[p.id]) throw new AddError(`${p.id} is not installed in ${dir}`);
    removing.add(p.id);
  }

  const facts = new Map(await Promise.all(Object.entries(lock.builds).map(async ([id, e]) => [id, await lockFacts(id, e)] as const)));
  const staying = [...facts.keys()].filter((id) => !removing.has(id));
  const dependents = staying.flatMap((id) => Object.keys(facts.get(id)!.builds).filter((dep) => removing.has(dep)).map((dep) => `${id} depends on ${dep}`));
  if (dependents.length && !opts.force) {
    throw new AddError(`refusing to remove: ${dependents.join("; ")}. Remove those builds in the same command, or pass --force.`, { dependents });
  }

  const root = dir.endsWith(sep) ? dir : dir + sep;
  const sharedWith = new Map(staying.flatMap((id) => Object.keys(lock.builds[id].files).map((path) => [path.toLowerCase(), id] as const)));
  const builds: RemovedBuild[] = [];
  const targets = new Set<string>();
  for (const id of removing) {
    const entry = lock.builds[id];
    const r: RemovedBuild = { id, version: entry.version, deleted: [], kept: [] };
    for (const [path, hash] of Object.entries(entry.files)) {
      const target = safeTarget(dir, path);
      if (unsafePathReason(path) || !target.startsWith(root)) { r.kept.push(`${path} (unsafe path in pkg.lock.json)`); continue; }
      const current = fileHash(target);
      if (current === null) continue;
      if (sharedWith.has(path.toLowerCase())) r.kept.push(`${path} (also in ${sharedWith.get(path.toLowerCase())})`);
      else if (current !== hash) r.kept.push(`${path} (edited)`);
      else { r.deleted.push(path); targets.add(target); }
    }
    builds.push(r);
  }

  const orphans = [...new Set([...removing].flatMap((id) => Object.keys(facts.get(id)!.builds)))]
    .filter((dep) => staying.includes(dep) && !staying.some((id) => dep in facts.get(id)!.builds));

  // Packages are reported, never uninstalled: the user's own code may use them too.
  const needed = (eco: "npm" | "pip", ids: string[]) => new Set(ids.flatMap((id) => Object.keys(facts.get(id)!.dependencies[eco] ?? {})));
  const pkg = readJson(join(dir, "package.json"));
  const npmHave = new Set(Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }));
  const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : "");
  const pipLines = [...read("requirements.txt").split(/\r?\n/), ...read("requirements-dev.txt").split(/\r?\n/), ...pyprojectDependencies(read("pyproject.toml"))];
  const pipHave = new Set(pipLines.map((l) => parsePipRequirement(l)?.name));
  const unusedOf = (eco: "npm" | "pip", have: Set<string | undefined>) => {
    const keep = needed(eco, staying);
    return [...needed(eco, [...removing])].filter((n) => !keep.has(n) && have.has(n)).sort();
  };

  const result: RemoveResult = { dir, dryRun: !!opts.dryRun, builds, dependents, orphans, unused: { npm: unusedOf("npm", npmHave), pip: unusedOf("pip", pipHave) }, nextSteps: [] };
  result.nextSteps = nextSteps(result, project.npm ?? "npm");
  if (opts.dryRun) return result;

  // Files first: if a delete fails, the lock entry is still there to retry with.
  deleteFiles(dir, [...targets]);
  for (const id of removing) delete lock.builds[id];
  writeFileSync(safeTarget(dir, "pkg.lock.json"), JSON.stringify(lock, null, 2) + "\n");
  return result;
}

function nextSteps(r: RemoveResult, pm: string): string[] {
  const steps = ["Remove the code that still uses the removed builds (imports, routes or middleware wired in while integrating them), then run the tests."];
  if (r.builds.some((b) => b.kept.some((k) => k.endsWith("(edited)")))) steps.push("The kept files were edited after install; delete them by hand once nothing uses them.");
  if (r.dependents.length) steps.push(`Fix or remove the builds that depended on them: ${r.dependents.join("; ")}.`);
  if (r.orphans.length) steps.push(`Nothing else needs ${r.orphans.join(", ")} now; if your own code doesn't use it either: pkg remove ${r.orphans.join(" ")}`);
  if (r.unused.npm.length) steps.push(`If your own code doesn't use them, uninstall the npm packages no build needs any more: ${pm} ${pm === "npm" ? "uninstall" : "remove"} ${r.unused.npm.join(" ")}`);
  if (r.unused.pip.length) steps.push(`If your own code doesn't use them, delete these from your Python requirements: ${r.unused.pip.join(", ")}`);
  return steps;
}

/** Human/agent-readable summary of a removal. */
export function formatRemoveResult(r: RemoveResult): string {
  const out = [r.dryRun ? `Dry run in ${r.dir} (nothing deleted):` : `Removed from ${r.dir}:`];
  for (const b of r.builds) {
    out.push(`\n## ${b.id}@${b.version}`);
    out.push(b.deleted.length ? `${r.dryRun ? "would delete" : "deleted"} ${b.deleted.length} file(s): ${b.deleted.join(", ")}` : "no files deleted");
    if (b.kept.length) out.push(`KEPT: ${b.kept.join(", ")}`);
  }
  if (r.dependents.length) out.push(`\nwarning: removed although ${r.dependents.join("; ")} (--force)`);
  if (r.unused.npm.length) out.push(`\nnpm packages no installed build needs (left in package.json): ${r.unused.npm.join(", ")}`);
  if (r.unused.pip.length) out.push(`Python packages no installed build needs (left in place): ${r.unused.pip.join(", ")}`);
  out.push(`\nNext steps:\n${r.nextSteps.map((s) => `- ${s}`).join("\n")}`);
  return out.join("\n");
}
