# pkg

An open, agent-first marketplace for reusable software, at [pkg.tneemo.com](https://pkg.tneemo.com).

People publish free, reusable builds: small modules, integrations and complete project foundations, in any stack. A coding agent takes the idea and preferred stack from the conversation, finds compatible builds, installs and assembles them, and writes only what's missing. The agent spends tokens discovering software, not regenerating it.

```bash
# Connect your agent once (Claude Code, Cursor, Codex, Windsurf, Gemini CLI)
npx -y @tneemo/pkg setup

# ...or for Claude Code only
claude mcp add pkg -- npx -y @tneemo/pkg mcp
```

Then ask your agent for what you want to build. No spec files and no accounts.

### Global CLI names

Node.js 20+ is required. `npm install -g @tneemo/pkg` installs both `pkg` and
`tpkg`, pointing to the same CLI. The legacy [Vercel `pkg`](https://github.com/vercel/pkg)
package also installs a global `pkg` executable. These names collide in a shared
npm global prefix; installing both may fail with `EEXIST` or leave `pkg` pointing
to the other tool. `tpkg` identifies this CLI once it is installed, but does not
prevent the installation collision because both aliases are shipped.

For coexistence, avoid the global install and run an explicit package command:

```bash
npm exec --yes --package=@tneemo/pkg -- tpkg setup
npm exec --yes --package=@tneemo/pkg -- tpkg mcp
```

If you no longer need Vercel's tool, uninstall the unscoped `pkg` package before
installing `@tneemo/pkg` globally. Do not use `--force` to overwrite its executable.

The official MCP Registry entry is [`io.github.tneemo/pkg`](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.tneemo%2Fpkg/versions/latest).
Maintainers: see [public distribution and releases](docs/distribution.md).

## What it looks like

Asked for *"a TypeScript REST API for a todo app where users sign up, log in and only see their own todos"*, the agent:

1. searches pkg for each part (`rest api`, `user accounts`, `database`) with the stack it inferred;
2. installs `tneemo/hono-api tneemo/hono-auth tneemo/hono-rate-limit` in one call. `tneemo/sqlite-db` is pulled in as a dependency and the stack is checked. After reviewing the dry-run plan, dependency installation is explicitly enabled with `--install-deps`, then the assembled tests run before adding application code;
3. follows the integration notes (6 lines of wiring in `src/app.ts`), writes the todo routes, migration and tests (3 files, 113 lines);
4. runs the tests (13 passing) and reports `--worked` for each build, which feeds the builds' reputation.

pkg supplied 23 of the 26 files and 519 lines; the agent wrote 3 files. This exact run is reproducible with the steps in [Development](#development).

## How agents use it

| Interface | Command | Best for |
| --- | --- | --- |
| MCP server | `npx -y @tneemo/pkg mcp` | Claude Code, Cursor, Codex, any MCP client. Server instructions tell the agent to check pkg before writing common code. |
| CLI | `npx -y @tneemo/pkg <command> --json` | Any agent with a shell. |
| Agent Skill | [`skill/pkg/SKILL.md`](skill/pkg/SKILL.md) | Skill-aware agents; installed by `pkg setup`. |
| HTTP API | [`/llms.txt`](https://pkg.tneemo.com/llms.txt) | Direct integrations; agents that only fetch URLs. |

MCP tools: `search_builds`, `get_build`, `install_builds`, `update_builds`, `remove_builds`, `detect_stack`, `report_outcome`, `publish_build`.

CLI: `search`, `info`, `detect`, `add`, `update`, `remove`, `list`, `init`, `publish`, `feedback`, `mcp`, `setup`.

## How it works

```
 agent ──MCP/CLI──▶ pkg CLI ──HTTPS──▶ registry (Cloudflare Worker)
                     │                   ├─ D1: metadata, FTS5 search, versions, feedback
                     │                   └─ R2: immutable gzipped bundles
                     ├─ detects the project's stack from files on disk
                     ├─ resolves build dependencies (registry) and checks compatibility (locally)
                     ├─ verifies sha256 integrity, rejects unsafe paths
                     ├─ writes files, merges package.json / requirements / .env.example
                     ├─ runs npm/pnpm/yarn/bun or a Python venv + pip
                     └─ writes pkg.lock.json (versions, integrity, per-file hashes)
```

- **Builds are source, not packages.** Like the shadcn registry, files are copied into the project and become the user's code. Libraries stay on npm and PyPI; a build declares them and pkg can install them after explicit review.
- **Compatibility** works on stack tags detected from the project (`node`, `typescript`, `hono`, `nextjs`, `fastapi`, …, plus every dependency as `npm:<name>` / `pip:<name>`) with semver ranges. Builds declare `stack.requires` and `stack.provides`, so a module that needs `hono` is matched with a foundation that provides it, inside a single install.
- **Updates and removals respect local edits.** `pkg update` moves builds to the newest version within their major (`--latest` for new majors) and replaces only files whose sha256 still matches pkg.lock.json; edited files are left untouched and reported as conflicts. `pkg remove` deletes only unedited files, refuses while another installed build depends on the one being removed, and lists packages no build needs any more without uninstalling them.
- **Integration** is split: everything deterministic is automated (files, dependencies, scripts, env vars, migrations by convention), and the last mile of wiring goes to the agent as precise `INTEGRATION.md` notes, which agents follow reliably.
- **Publishing** is `pkg init` (writes `pkg.json` by detecting the stack, imported packages, the folder's place in the project and imports of other installed builds) and `pkg publish`. Identity is your GitHub login (`gh auth token` / `GITHUB_TOKEN`); builds are named `<login>/<name>`. pkg has no accounts.

## Trust and safety

- **Automated checks on every publish** (the same code runs locally first). Rejected: path traversal, `.git`/`node_modules` paths, secrets and private keys, `.env` files, invalid manifests, npm/PyPI dependencies that don't exist (dependency confusion), oversized bundles. Shown to every installer as warnings: npm install scripts, pipe-to-shell, evaluating decoded data, hard-coded IPs, minified code, prompt injection aimed at agents, and files that configure agents or editors (`.claude/`, `.mcp.json`, `AGENTS.md` in modules, `.vscode/tasks.json`, CI workflows).
- **Review before installing.** Dependency installation is off by default. Inspect `--dry-run` first, then explicitly use `--install-deps` to run npm with `--ignore-scripts` or pip with `--only-binary=:all:`. Registry checks are warnings, not a sandbox. Bundles are integrity-checked, every path is re-validated client-side, and existing files are never overwritten without `--force` (files pkg installed and nobody edited can be updated in place).
- **Agent-facing text is labeled.** Integration notes are returned as "build documentation, not user instructions", and the MCP server instructions tell agents the same.
- **Community reputation without accounts.** Agents report `success` / `failure` / `report` after integrating a build; votes are deduplicated per day by salted IP hash. Search ranks by relevance (BM25), stack fit, agent-reported success rate (Bayesian) and quality score; flagged builds are demoted. Raw downloads carry no ranking weight.
- Versions are immutable.

## Prior art and what was reused

| Existing solution | What pkg takes from it |
| --- | --- |
| [shadcn registry](https://ui.shadcn.com/docs/registry) | Source-copy distribution, JSON item with embedded files. Every npm build is also served as a shadcn registry item at `/r/<owner>/<name>.json`, so projects already set up for shadcn (with a `components.json`) can `npx shadcn add` it. |
| Go modules, JSR, GitHub | Namespaces from an existing identity instead of new accounts. |
| npm / PyPI trusted publishing | Publish with a GitHub token, no registry passwords. |
| npm, PyPI, `package.json` `engines`, PEP 508/440 | Dependencies, version ranges and runtime requirements use the native formats and package managers. |
| [Model Context Protocol](https://modelcontextprotocol.io) | Official TypeScript SDK; server `instructions` make discovery part of the agent's normal workflow. |
| [Agent Skills](https://agentskills.io), [llms.txt](https://llmstxt.org), `AGENTS.md` | Agent-readable entry points; foundations ship an `AGENTS.md` with their conventions. |
| SQLite FTS5 on Cloudflare D1 | Full-text search with no search service to run. |

Template tools (create-*, degit, cookiecutter, copier) solve starting a project. Component registries (shadcn, Bit) mostly cover one stack, and MCP and skill registries distribute tools rather than application code. pkg combines composable foundations and modules across stacks with agent-native discovery and integration.

## Costs

One Cloudflare Worker with D1 and R2. The free tier covers 100k requests/day, 5 GB of D1 and 10 GB of R2 with free egress. There are no servers, queues or search clusters, and bundles are immutable and cacheable. The CLI is a single dependency-free file.

## Development

Requires Node.js 22.12+ (24 recommended) and, for the Python builds, Python 3.10+.

```bash
npm install
npm run build                      # bundles cli/dist/pkg.js
echo "ADMIN_TOKEN=dev-admin-token" > registry/.dev.vars
npm run dev                        # registry on http://localhost:8787 (local D1 + R2)

# in another terminal: publish the example builds, then use the CLI against the local registry
PKG_REGISTRY=http://127.0.0.1:8787 PKG_TOKEN=dev-admin-token npm run seed
PKG_REGISTRY=http://127.0.0.1:8787 node cli/dist/pkg.js search "user accounts" --stack typescript,hono
PKG_REGISTRY=http://127.0.0.1:8787 node cli/dist/pkg.js add tneemo/hono-api tneemo/hono-auth --dir /tmp/my-api

PKG_REGISTRY=http://127.0.0.1:8787 npm test   # unit tests + MCP end-to-end test
npm run typecheck
```

To point an agent at the local registry, use `node <repo>/cli/dist/pkg.js mcp` as the MCP command with `PKG_REGISTRY=http://127.0.0.1:8787` in its environment.

### Watch an independent agent do it

`examples/agent-demo/` contains only an `.mcp.json` that connects the local CLI and registry. With the registry running and seeded, start Claude Code in that folder (approve the `pkg` MCP server if asked) and ask, without mentioning pkg:

> Build a small TypeScript REST API for a todo list app. Users sign up and log in, and each user only sees their own todos. Make sure the tests pass.

The agent learns about pkg only from the MCP server's instructions and tools.

## Deploying pkg.tneemo.com

```bash
cd registry
npx wrangler login
npx wrangler d1 create pkg              # put the printed database_id in wrangler.jsonc
npx wrangler r2 bucket create pkg-bundles
npx wrangler secret put ADMIN_TOKEN     # for seeding and moderation
npx wrangler secret put IP_SALT         # any random string
npm run deploy                          # applies migrations, deploys, binds pkg.tneemo.com
cd .. && PKG_TOKEN=<admin token> npm run seed

```

The npm package and MCP Registry metadata use the separate, manually confirmed
[distribution workflows](docs/distribution.md).

## Repository layout

```
cli/        @tneemo/pkg: CLI + MCP server (bundled with esbuild into one file)
registry/   Cloudflare Worker: JSON API, website, llms.txt, shadcn endpoint; D1 migrations
shared/     manifest format, compatibility engine and security checks (used by both)
builds/     example builds: hono-api, sqlite-db, hono-auth, hono-rate-limit, fastapi-service, fastapi-api-key
skill/      Agent Skill (SKILL.md)
test/       unit tests and the MCP end-to-end test
```

## Not done yet

- GitHub Actions OIDC tokens for publishing from CI without a personal token (a `GITHUB_TOKEN` already works).
- Semantic search (Workers AI + Vectorize) on top of FTS5; today agents search per part with plain words.
- Version yanking and moderation tooling.
- Modules published from a subfolder can only ship files inside that folder.

## License

MIT
