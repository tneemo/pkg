import { parsePipRequirement, pyprojectDependencies } from "./compat.ts";
import { decodedText, validDependency, type Bundle } from "./manifest.ts";
import { parse as parseToml } from "smol-toml";

/** All installable dependency sources. Unsupported installer inputs fail closed. */
export function effectiveDependencies(bundle: Bundle): { npm: Record<string, string[]>; pip: Record<string, string[]> } {
  const out = { npm: Object.create(null) as Record<string, string[]>, pip: Object.create(null) as Record<string, string[]> };
  const add = (eco: "npm" | "pip", name: string, range: unknown) => {
    if (!validDependency(eco, name, range)) throw new Error(`invalid ${eco} dependency ${name}: ${String(range)}`);
    const key = eco === "pip" ? name.replace(/\[.*$/, "").toLowerCase().replace(/[-_.]+/g, "-") : name;
    (out[eco][key] ??= []).push(range);
  };
  for (const deps of [bundle.manifest.dependencies, bundle.manifest.devDependencies]) {
    for (const eco of ["npm", "pip"] as const) for (const [name, range] of Object.entries(deps?.[eco] ?? {})) add(eco, name, range);
  }
  for (const f of bundle.files) {
    const text = decodedText(f);
    if (text === null) continue;
    if (/(?:^|\/)package\.json$/i.test(f.path)) {
      const pkg = JSON.parse(text);
      for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
        for (const [name, range] of Object.entries(pkg[field] ?? {})) add("npm", name, range);
      }
      if (pkg.workspaces || pkg.overrides || pkg.resolutions) throw new Error("workspaces and dependency overrides require separate review and are not supported in bundles");
    }
    let lines: string[] = [];
    if (/(?:^|\/)requirements[^/]*\.txt$/i.test(f.path)) lines = text.split(/\r?\n/);
    if (/(?:^|\/)pyproject\.toml$/i.test(f.path)) {
      const toml = parseToml(text) as Record<string, any>;
      const project = toml.project ?? {};
      if (toml["build-system"] || toml["dependency-groups"] || toml.tool?.poetry || toml.tool?.uv || project.dynamic || project["optional-dependencies"]) throw new Error("unsupported pyproject dependency source; use static project.dependencies");
      if (project.dependencies !== undefined && (!Array.isArray(project.dependencies) || project.dependencies.some((x: unknown) => typeof x !== "string"))) throw new Error("project.dependencies must be an array of strings");
      lines = project.dependencies ?? [];
    }
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      // Only the conventional runtime include is allowed; its contents are checked separately.
      if (/^-r\s+requirements\.txt$/.test(line) && bundle.files.some((x) => x.path === "requirements.txt")) continue;
      const r = parsePipRequirement(line);
      if (!r || !validDependency("pip", r.name, r.spec) || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?\s*(?:(?:~=|==|!=|<=|>=|<|>)[0-9][A-Za-z0-9.*+!_,<>=~ -]*)?$/.test(line)) throw new Error(`unsupported requirement: ${line}`);
      add("pip", r.name, r.spec);
    }
  }
  if (Object.keys(out.npm).length + Object.keys(out.pip).length > 80) throw new Error("at most 80 upstream packages are supported; split this build");
  return out;
}
