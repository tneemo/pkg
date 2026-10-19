// Bundles the CLI into a single dependency-free file so `npx @tneemo/pkg` starts fast.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

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
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __pkgRequire } from 'node:module';\nconst require = __pkgRequire(import.meta.url);",
  },
  logLevel: "warning",
});

mkdirSync("skill/pkg", { recursive: true });
cpSync("../skill/pkg/SKILL.md", "skill/pkg/SKILL.md");
console.log("built dist/pkg.js");
