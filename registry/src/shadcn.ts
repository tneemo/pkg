// Serves npm-based builds as shadcn registry items, so `npx shadcn add <url>` works too.
// https://ui.shadcn.com/docs/registry/registry-item-json
import type { Bundle } from "../../shared/manifest.ts";
import { HttpError, type buildInfo } from "./api.ts";

type Info = Awaited<ReturnType<typeof buildInfo>>;

export function shadcnItem(info: Info, bundle: Bundle, origin: string) {
  const m = info.manifest;
  if (m.dependencies?.pip || m.devDependencies?.pip) throw new HttpError(422, "shadcn items only support npm builds; use `npx -y @tneemo/pkg add` instead");
  const deps = (map?: Record<string, string>) => Object.entries(map ?? {}).map(([name, range]) => (range === "*" ? name : `${name}@${range}`));
  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: m.name,
    type: m.kind === "foundation" ? "registry:base" : "registry:block",
    title: info.id,
    description: m.description,
    author: info.id.split("/")[0],
    dependencies: deps(m.dependencies?.npm),
    devDependencies: deps(m.devDependencies?.npm),
    registryDependencies: Object.keys(m.builds ?? {}).map((id) => `${origin}/r/${id}.json`),
    files: bundle.files
      .filter((f) => f.encoding !== "base64")
      .map((f) => ({ path: f.path, type: "registry:file", target: `~/${f.path}`, content: f.content })),
    envVars: Object.fromEntries(Object.entries(m.env ?? {}).map(([k, v]) => [k, v.example ?? ""])),
    docs: bundle.integration ?? "",
    categories: m.keywords ?? [],
    meta: { pkg: `${origin}/${info.id}`, version: info.version, license: m.license },
  };
}
