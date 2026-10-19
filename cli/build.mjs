// Bundles the CLI into a single dependency-free file so `npx @tneemo/pkg` starts fast.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

await build({
  entryPoints: ["src/pkg.ts"],
  outfile: "dist/pkg.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  legalComments: "none",
  loader: { ".md": "text" },
  define: { __PKG_VERSION__: JSON.stringify(version) },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __pkgRequire } from 'node:module';\nconst require = __pkgRequire(import.meta.url);",
  },
  logLevel: "warning",
});

mkdirSync("skill/pkg", { recursive: true });
cpSync("../skill/pkg/SKILL.md", "skill/pkg/SKILL.md");
cpSync("../LICENSE", "LICENSE");
console.log(`built dist/pkg.js (${version})`);
