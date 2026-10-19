// pkg CLI entry point.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { mergeProfiles, parseStack, withImpliedRuntime } from "../../shared/compat.ts";
import { detectProject } from "./detect.ts";
import { formatInfo, formatProject, formatReport, formatSearch } from "./format.ts";
import { add, AddError, formatAddResult, update } from "./install.ts";
import { init, publish } from "./publish.ts";
import * as registry from "./registry.ts";
import { formatRemoveResult, remove } from "./remove.ts";
import { setup } from "./setup.ts";

const HELP = `pkg ${registry.VERSION}: find, install and publish reusable software builds
Registry: ${registry.REGISTRY}

Discover
  pkg search <query...>      search builds   [--stack typescript,hono] [--kind foundation|module] [--limit 10]
  pkg info <owner/name>      details, integration notes and check results   [--version x.y.z]
  pkg detect                 show the stack detected in this project

Install
  pkg add <owner/name...>    install builds and their dependencies
                             [--dir path] [--dry-run] [--force] [--install-deps] [--no-install]
  pkg update [owner/name...] update installed builds (all by default) within their major version;
                             files edited since install are kept and reported as conflicts
                             [--latest] [--dry-run] [--force] [--install-deps] [--no-install]
  pkg remove <owner/name...> delete the files a build installed (edited ones are kept) and its
                             lock entry; lists dependencies no build needs any more
                             [--dry-run] [--force]
  pkg list                   builds installed in this project (pkg.lock.json)

Publish
  pkg init                   create pkg.json for this folder   [--name n] [--kind module|foundation]
  pkg publish                check and publish this folder   [--dry-run] [--owner org]
  pkg feedback <id...>       --worked | --failed "what broke" | --report "why it's harmful"

Agents
  pkg mcp                    run the MCP server over stdio
  pkg setup                  connect pkg to the coding agents on this machine

Options: --json for machine-readable output, --dir <path> to target another folder.
Set PKG_REGISTRY to use another registry. Docs: ${registry.REGISTRY}/llms.txt`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    dir: { type: "string" },
    stack: { type: "string" },
    kind: { type: "string" },
    limit: { type: "string" },
    version: { type: "string" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    "no-install": { type: "boolean" },
    "install-deps": { type: "boolean" },
    latest: { type: "boolean" },
    name: { type: "string" },
    owner: { type: "string" },
    worked: { type: "boolean" },
    failed: { type: "string" },
    report: { type: "string" },
    note: { type: "string" },
    "no-skill": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, ...args] = positionals;
const json = !!opts.json;
const dir = resolve(String(opts.dir ?? "."));
const out = (data: unknown, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text);
const log = (msg: string) => { if (!json) console.error(msg); };

async function main() {
  switch (command) {
    case "search":
    case "s": {
      const query = args.join(" ");
      const project = detectProject(dir);
      const profile = withImpliedRuntime(mergeProfiles(project.profile, parseStack(opts.stack as string | undefined)), process.versions.node);
      const res = await registry.search(query, { stack: registry.stackParam(profile), kind: opts.kind as string | undefined, limit: Number(opts.limit) || 10 });
      return out(res, formatSearch(query, profile, res.results, opts.stack ? "--stack + detected" : project.empty ? "empty project" : "detected"));
    }
    case "info":
    case "show": {
      if (!args[0]) throw new Error("usage: pkg info <owner/name>");
      const [id, v] = args[0].split("@");
      const res = await registry.info(id, (opts.version as string | undefined) ?? v);
      return out(res, formatInfo(res));
    }
    case "detect": {
      const project = detectProject(dir);
      return out(project, formatProject(project));
    }
    case "add":
    case "install":
    case "i": {
      if (!args.length) throw new Error("usage: pkg add <owner/name> [more builds...]");
      const res = await add(args, { dir, force: !!opts.force, dryRun: !!opts["dry-run"], install: !!opts["install-deps"] && !opts["no-install"], log });
      return out(res, formatAddResult(res));
    }
    case "update":
    case "upgrade":
    case "up": {
      const res = await update(args, { dir, force: !!opts.force, dryRun: !!opts["dry-run"], install: !!opts["install-deps"] && !opts["no-install"], latest: !!opts.latest, log });
      return out(res, formatAddResult(res));
    }
    case "remove":
    case "uninstall":
    case "rm": {
      if (!args.length) throw new Error("usage: pkg remove <owner/name> [more builds...]");
      const res = await remove(args, { dir, force: !!opts.force, dryRun: !!opts["dry-run"] });
      return out(res, formatRemoveResult(res));
    }
    case "list":
    case "ls": {
      const lock = detectProject(dir).lock;
      const builds = Object.entries(lock?.builds ?? {}).map(([id, b]) => ({ id, version: b.version, kind: b.kind, files: Object.keys(b.files).length }));
      return out(builds, builds.length ? builds.map((b) => `${b.id}@${b.version} (${b.kind}, ${b.files} files)`).join("\n") : "No builds installed here (no pkg.lock.json).");
    }
    case "init": {
      const res = init(dir, { name: opts.name as string | undefined, kind: opts.kind as "module" | "foundation" | undefined, force: !!opts.force });
      return out(res, `Created ${res.path}:\n${JSON.stringify(res.manifest, null, 2)}\n\nFiles that would be published (${res.files.length}): ${res.files.join(", ")}\n\nTo do:\n${res.todo.map((t) => `- ${t}`).join("\n")}`);
    }
    case "publish": {
      const res = await publish(dir, { owner: opts.owner as string | undefined, dryRun: !!opts["dry-run"] });
      const files = res.bundle.files.map((f) => f.path);
      const head = res.published
        ? `Published ${res.id}\n${res.url}`
        : res.report.risk === "error"
          ? `Not published: fix the errors below and try again.`
          : `Dry run: ${res.id} would publish ${files.length} file(s): ${files.join(", ")}`;
      out({ ...res, bundle: undefined, files }, `${head}\n${formatReport(res.report)}`);
      if (res.report.risk === "error") process.exitCode = 1;
      return;
    }
    case "feedback": {
      const outcome = opts.worked ? "success" : opts.report !== undefined ? "report" : opts.failed !== undefined ? "failure" : null;
      if (!outcome || !args.length) throw new Error('usage: pkg feedback <owner/name...> --worked | --failed "what broke" | --report "why"');
      const note = (opts.failed ?? opts.report ?? opts.note) as string | undefined;
      const lock = detectProject(dir).lock;
      const results = [];
      for (const id of args) results.push({ id, ...(await registry.feedback(id, { outcome, note: note || undefined, version: lock?.builds[id]?.version })) });
      return out(results, results.map((r) => `${r.id}: ${r.message}`).join("\n"));
    }
    case "mcp": {
      const { startMcp } = await import("./mcp.ts");
      return startMcp();
    }
    case "setup": {
      const res = setup({ skill: !opts["no-skill"] });
      return out(res, res.join("\n"));
    }
    case undefined:
    case "help":
      return console.log(HELP);
    default:
      throw new Error(`unknown command "${command}". Run \`pkg help\`.`);
  }
}

if (opts.help) console.log(HELP);
else main().catch((e) => {
  const details: any = e instanceof AddError || e instanceof registry.RegistryError ? (e as AddError).details : undefined;
  if (json) console.log(JSON.stringify({ error: e.message, details }, null, 2));
  else console.error(`pkg: ${e.message}${details?.install ? `\n${formatAddResult(details)}` : details?.findings ? `\n${formatReport(details)}` : ""}`);
  process.exitCode = 1;
});
