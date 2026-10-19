// Bundles the CLI into a single dependency-free file so `npx @tneemo/pkg` starts fast.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const result = await build({
  entryPoints: ["src/pkg.ts"],
  outfile: "dist/pkg.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  metafile: true,
  loader: { ".md": "text" },
  define: { __PKG_VERSION__: JSON.stringify(version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __pkgRequire } from 'node:module';\nconst require = __pkgRequire(import.meta.url);",
  },
  logLevel: "warning",
});

// Preserve license notices for libraries incorporated into the standalone executable.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes("node_modules/")) continue;
  let dir = dirname(resolve(input));
  while (!existsSync(`${dir}/package.json`) && dirname(dir) !== dir) dir = dirname(dir);
  packages.add(dir);
}
const notices = [...packages].sort().flatMap((dir) => {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  return readdirSync(dir).filter((name) => /^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(name)).map((name) =>
    `\n--- ${pkg.name}@${pkg.version}: ${name} ---\n${readFileSync(`${dir}/${name}`, "utf8")}\n`);
});
writeFileSync("THIRD_PARTY_NOTICES.txt", notices.join(""));

mkdirSync("skill/pkg", { recursive: true });
cpSync("../skill/pkg/SKILL.md", "skill/pkg/SKILL.md");
cpSync("../LICENSE", "LICENSE");
console.log(`built dist/pkg.js (${version})`);
