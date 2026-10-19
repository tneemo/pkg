// JSON Schema for pkg.json, served at /schema/pkg.json for editor completion.
const deps = {
  type: "object",
  properties: {
    npm: { type: "object", additionalProperties: { type: "string" }, description: "npm package -> version range" },
    pip: { type: "object", additionalProperties: { type: "string" }, description: "PyPI package -> PEP 440 specifier (e.g. \">=0.110\") or \"*\"" },
  },
  additionalProperties: false,
};

export const manifestSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "pkg.json",
  description: "Manifest of a reusable build published to pkg (https://pkg.tneemo.com/docs).",
  type: "object",
  required: ["name", "version", "kind", "description", "license"],
  properties: {
    $schema: { type: "string" },
    name: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$", description: "Published as <github-owner>/<name>." },
    version: { type: "string", description: "Semver. Published versions are immutable." },
    kind: { enum: ["module", "foundation"], description: "module: adds to an existing project. foundation: starts a new project." },
    description: { type: "string", maxLength: 300 },
    license: { type: "string", description: "SPDX license id, e.g. MIT." },
    keywords: { type: "array", items: { type: "string" }, maxItems: 20 },
    stack: {
      type: "object",
      properties: {
        requires: { type: "object", additionalProperties: { type: "string" }, description: "Stack tags the project must have -> semver range, e.g. {\"hono\": \">=4\", \"node\": \">=22\"}." },
        provides: { type: "array", items: { type: "string" }, description: "Stack tags this build adds, e.g. [\"auth\"]." },
      },
      additionalProperties: false,
    },
    dependencies: deps,
    devDependencies: deps,
    builds: { type: "object", additionalProperties: { type: "string" }, description: "Other pkg builds required, \"owner/name\" -> semver range." },
    files: { type: "array", items: { type: "string" }, description: "Globs of files to install (default: everything except pkg.json, README.md and INTEGRATION.md)." },
    base: { type: "string", description: "Folder in the target project where the files go, e.g. \"src/todos\" (default: project root). Set by `pkg init` when publishing a subfolder." },
    env: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { description: { type: "string" }, example: { type: "string" }, required: { type: "boolean" } },
        additionalProperties: false,
      },
    },
    scripts: { type: "object", additionalProperties: { type: "string" }, description: "npm scripts merged into package.json when absent." },
    repository: { type: "string", format: "uri" },
    homepage: { type: "string", format: "uri" },
  },
  additionalProperties: false,
};
