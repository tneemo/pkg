// Automated security and quality checks. The registry runs them on every publish
// (errors reject the publish); the CLI runs the same code locally as a preview.
import { decodedText, LIMITS, METADATA_FILES, unsafePathReason, validateBundle, type Bundle } from "./manifest.ts";
import { effectiveDependencies } from "./dependencies.ts";

export type Level = "error" | "warn" | "info";

export interface Finding {
  level: Level;
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface CheckReport {
  /** "error" findings block publishing; "warn" findings are shown to everyone who installs. */
  risk: "ok" | "warn" | "error";
  /** 0-100, based on documentation, tests and metadata completeness. */
  quality: number;
  findings: Finding[];
}

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\b[sr]k_live_[0-9a-zA-Z]{20,}\b/, "Stripe live key"],
  [/\bsk-ant-[A-Za-z0-9_-]{30,}\b/, "Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/, "OpenAI API key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm token"],
];

const CODE_PATTERNS: [RegExp, Level, string, string][] = [
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, "warn", "pipe-to-shell", "downloads and pipes a script into a shell"],
  [/\b(?:Invoke-Expression|iex)\s*[(\s]/i, "warn", "invoke-expression", "evaluates a string as PowerShell"],
  [/powershell(?:\.exe)?\s+[^\n]*-e(?:nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, "warn", "encoded-command", "runs an encoded PowerShell command"],
  [/\beval\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent)\s*\(/, "warn", "eval-decoded", "evaluates decoded data"],
  [/\b(?:exec|eval)\s*\(\s*(?:base64\.b64decode|codecs\.decode|bytes\.fromhex|zlib\.decompress)/, "warn", "eval-decoded", "evaluates decoded data"],
  [/\bnew\s+Function\s*\(/, "info", "dynamic-function", "creates functions from strings"],
  [/\beval\s*\(/, "info", "eval", "uses eval"],
  [/\b(?:child_process|execSync|spawnSync|subprocess\.(?:run|Popen|call)|os\.system)\b/, "info", "shell", "runs external commands"],
  [/https?:\/\/(?!(?:127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.))\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, "warn", "raw-ip", "contacts a hard-coded IP address"],
  [/\b(?:process\.env|os\.environ)\b[^\n]{0,80}\b(?:fetch|axios|request|urlopen|requests\.(?:post|get))\s*\(/, "warn", "env-exfiltration", "sends environment variables over the network"],
];

const PROMPT_INJECTION = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts|messages)\b/i,
  /\bdisregard (?:all |any |the |your )?(?:previous|prior|system|above) (?:instructions|prompt)/i,
  /\byou are now (?:in )?(?:developer|dan|jailbreak|unrestricted)/i,
  /\bdo not (?:tell|inform|mention (?:this )?to) the user\b/i,
];

/** Files that steer coding agents or editors. Fine in a foundation, suspicious in a module. */
const AGENT_FILES = [/^AGENTS\.md$/i, /^CLAUDE\.md$/i, /^GEMINI\.md$/i, /^\.cursorrules$/, /^\.cursor\/rules\//, /^\.github\/copilot-instructions\.md$/, /^\.windsurfrules$/];
/** Files that can grant permissions or run code automatically. Always flagged. */
const AUTORUN_FILES: [RegExp, string][] = [
  [/^\.claude\//, "configures Claude Code (permissions, hooks)"],
  [/^\.mcp\.json$/, "registers MCP servers that agents will launch"],
  [/^\.vscode\/tasks\.json$/, "defines editor tasks that can run on folder open"],
  [/^\.github\/workflows\//, "adds CI workflows that run with repository secrets"],
  [/^\.husky\//, "adds git hooks"],
  [/^\.(?:npmrc|yarnrc(?:\.yml)?|pypirc)$|(?:^|\/)pip\.conf$/, "changes package registry configuration"],
];
const BINARY_EXEC = /\.(?:exe|dll|so|dylib|bin|jar|class|pyc|node|scr|bat|cmd|ps1|msi|app|apk)$/i;
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;
const LONG_LINE_OK = /\.(?:json|lock|svg|map|csv|txt|md)$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function checkBundle(bundle: Bundle): CheckReport {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  for (const e of validateBundle(bundle)) add({ level: "error", code: "manifest", message: e });
  if (findings.length) return { risk: "error", quality: 0, findings };
  const m = bundle.manifest;

  const isFoundation = m.kind === "foundation";
  if (bundle.files.length === 0 && !Object.keys(m.builds ?? {}).length) add({ level: "error", code: "empty", message: "the build has no files to install" });
  if (bundle.files.length > LIMITS.maxFiles) add({ level: "error", code: "too-many-files", message: `at most ${LIMITS.maxFiles} files are allowed` });

  let total = 0;
  const seen = new Set<string>();
  for (const file of bundle.files) {
    const path = file.path;
    const bad = unsafePathReason(path);
    if (bad) { add({ level: "error", code: "path", file: path, message: `unsafe path: ${bad}` }); continue; }
    if (seen.has(path.toLowerCase())) add({ level: "error", code: "duplicate", file: path, message: "duplicate path (paths are case-insensitive on some systems)" });
    seen.add(path.toLowerCase());
    if (METADATA_FILES.some((p) => p.toLowerCase() === path.toLowerCase()) && path.toLowerCase() !== "readme.md") add({ level: "error", code: "metadata-file", file: path, message: "metadata files are not installable" });

    const size = file.encoding === "base64" ? Math.floor((file.content.length * 3) / 4) : new TextEncoder().encode(file.content).length;
    total += size;
    if (size > LIMITS.maxFileBytes) add({ level: "error", code: "file-too-large", file: path, message: `files must be under ${LIMITS.maxFileBytes / 1e6} MB` });
    if (/(?:^|\/)\.env(?:\.(?!example$|sample$|template$)[^/]*)?$/i.test(path)) add({ level: "error", code: "env-file", file: path, message: "do not ship .env files; declare variables in pkg.json \"env\" instead" });

    const text = decodedText(file);
    if (file.encoding === "base64" && text === null) {
      add({ level: BINARY_EXEC.test(path) ? "warn" : "info", code: "binary", file: path, message: BINARY_EXEC.test(path) ? "ships an executable or compiled binary" : "binary file" });
    }

    if (AGENT_FILES.some((re) => re.test(path.toLowerCase()))) add({ level: isFoundation ? "info" : "warn", code: "agent-instructions", file: path, message: "writes instructions that coding agents will follow" });
    for (const [re, why] of AUTORUN_FILES) if (re.test(path.toLowerCase())) add({ level: "warn", code: "autorun", file: path, message: why });
    if (BINARY_EXEC.test(path)) add({ level: "warn", code: "script", file: path, message: "ships a platform script or executable" });

    if (text === null) {
      if (/\.(?:json|toml|txt|md|[cm]?[jt]sx?|py|ya?ml)$/i.test(path) || path.split("/").some((p) => p.startsWith("."))) add({ level: "error", code: "encoding", file: path, message: "configuration and text files must contain valid UTF-8 text" });
      continue;
    }
    scanText(path, text, add);
    if (path.toLowerCase() === "package.json" || path.toLowerCase().endsWith("/package.json")) {
      try {
        const pkg = JSON.parse(text);
        if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("invalid package object");
        for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "scripts"]) {
          const v = pkg[field];
          if (v !== undefined && (!v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some((s) => typeof s !== "string"))) throw new Error(`invalid ${field}`);
        }
        const scripts = pkg.scripts ?? {};
        for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
          if (scripts[hook]) add({ level: "warn", code: "install-script", file: path, message: `"${hook}" script runs automatically during npm install: ${String(scripts[hook]).slice(0, 120)}` });
        }
      } catch {
        add({ level: "error", code: "invalid-json", file: path, message: "package.json is not valid JSON" });
      }
    }
  }
  if (total > LIMITS.maxTotalBytes) add({ level: "error", code: "too-large", message: `builds must be under ${LIMITS.maxTotalBytes / 1e6} MB uncompressed` });

  for (const [name, text] of [["README.md", bundle.readme], ["INTEGRATION.md", bundle.integration]] as const) {
    if (text) scanText(name, text, add, true);
  }
  for (const [name, script] of Object.entries(m.scripts ?? {})) {
    if (/^(?:pre|post)?install$|^prepare$/.test(name)) add({ level: "warn", code: "install-script", message: `adds a "${name}" npm script that runs automatically during install` });
    scanText(`pkg.json#scripts.${name}`, script, add);
  }

  try { effectiveDependencies(bundle); }
  catch (e) { add({ level: "error", code: "dependencies", message: (e as Error).message }); }
  // Quality score: documentation, declared compatibility, tests and metadata.
  const hasTests = bundle.files.some((f) => TEST_FILE.test(f.path));
  const quality =
    ((bundle.readme?.trim().length ?? 0) >= 200 ? 20 : bundle.readme ? 10 : 0) +
    ((bundle.integration?.trim().length ?? 0) >= 50 ? 15 : 0) +
    (Object.keys(m.stack?.requires ?? {}).length || (m.stack?.provides ?? []).length ? 15 : 0) +
    (hasTests ? 20 : 0) +
    ((m.keywords?.length ?? 0) >= 2 ? 10 : 0) +
    (m.description.length >= 30 ? 10 : 0) +
    (m.repository ? 10 : 0);
  if (!bundle.readme) add({ level: "info", code: "no-readme", message: "add a README.md so people and agents know what this build does" });
  if (!bundle.integration) add({ level: "info", code: "no-integration", message: "add an INTEGRATION.md with the exact steps an agent should take after installing" });
  if (!hasTests) add({ level: "info", code: "no-tests", message: "builds with tests rank higher" });

  const risk = findings.some((f) => f.level === "error") ? "error" : findings.some((f) => f.level === "warn") ? "warn" : "ok";
  return { risk, quality, findings };
}

function scanText(path: string, text: string, add: (f: Finding) => void, docsOnly = false) {
  for (const [re, label] of SECRETS) {
    const m = re.exec(text);
    if (m) add({ level: "error", code: "secret", file: path, line: lineOf(text, m.index), message: `contains what looks like a ${label}` });
  }
  for (const re of PROMPT_INJECTION) {
    const m = re.exec(text);
    if (m) { add({ level: "warn", code: "prompt-injection", file: path, line: lineOf(text, m.index), message: `text that tries to steer AI agents: "${m[0]}"` }); break; }
  }
  if (docsOnly) return;
  for (const [re, level, code, message] of CODE_PATTERNS) {
    const m = re.exec(text);
    if (m) add({ level, code, file: path, line: lineOf(text, m.index), message });
  }
  if (!LONG_LINE_OK.test(path)) {
    const lines = text.split("\n");
    const i = lines.findIndex((l) => l.length > 1500);
    if (i >= 0) add({ level: "warn", code: "minified", file: path, line: i + 1, message: "very long line; minified or obfuscated code cannot be reviewed" });
  }
}

/** One-line summary such as "2 warnings, quality 85/100". */
export function summarizeReport(r: CheckReport): string {
  const n = (level: Level) => r.findings.filter((f) => f.level === level).length;
  const parts = [];
  if (n("error")) parts.push(`${n("error")} error(s)`);
  if (n("warn")) parts.push(`${n("warn")} warning(s)`);
  if (!parts.length) parts.push("no warnings");
  return `${parts.join(", ")}, quality ${r.quality}/100`;
}
