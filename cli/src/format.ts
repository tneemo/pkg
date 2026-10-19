// Compact text output that reads well for both people and agents.
import type { CheckReport } from "../../shared/checks.ts";
import { formatStack, type Profile } from "../../shared/compat.ts";
import type { Project } from "./detect.ts";
import type { BuildInfo, SearchResult } from "./registry.ts";

const reqs = (r: Record<string, string>) => Object.entries(r).map(([t, v]) => (v === "*" ? t : `${t} ${v}`)).join(", ") || "nothing";

export function formatProject(p: Project): string {
  const stack = formatStack(p.profile);
  const installed = Object.entries(p.lock?.builds ?? {}).map(([id, b]) => `${id}@${b.version}`);
  return [
    `Project: ${p.dir}${p.empty ? " (empty: a new project)" : ""}`,
    `Stack: ${stack || "nothing detected"}`,
    p.npm || p.python ? `Package managers: ${[p.npm, p.python].filter(Boolean).join(", ")}` : "",
    installed.length ? `Installed builds: ${installed.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

export function formatSearch(query: string, stack: Profile, results: SearchResult[], stackSource: string): string {
  const out: string[] = [];
  const s = formatStack(stack);
  out.push(s ? `Matching against stack: ${s} (${stackSource})` : "No stack given or detected; results are not filtered by compatibility.");
  if (!results.length) {
    out.push(`\nNo builds found for "${query}". Try other words, or build it yourself (and consider publishing it with \`pkg init\` + \`pkg publish\`).`);
    return out.join("\n");
  }
  results.forEach((r, i) => {
    const reports = r.agent_reports.success + r.agent_reports.failure;
    out.push(`\n${i + 1}. ${r.id}@${r.version} [${r.kind}] ${r.description}`);
    const facts = [
      `needs: ${reqs(r.requires)}`,
      r.provides.length ? `provides: ${r.provides.join(", ")}` : "",
      r.compat ? `fit: ${r.compat.ok ? "compatible" : r.compat.note}${r.compat.via ? ` (available via ${Object.entries(r.compat.via).map(([t, ids]) => `${t}: ${ids.join(" | ")}`).join("; ")})` : ""}` : "",
      `checks: ${r.risk === "ok" ? "passed" : r.risk === "warn" ? "warnings (see info)" : r.risk}`,
      reports ? `worked for ${Math.round((r.agent_reports.success / reports) * 100)}% of ${reports} agent reports` : "no agent reports yet",
      `${r.downloads} installs`,
    ].filter(Boolean);
    out.push(`   ${facts.join(" | ")}`);
  });
  out.push(`\nNext: inspect with \`pkg info <id>\`, then install everything you picked in one command: \`pkg add <foundation> <module> ...\`.`);
  return out.join("\n");
}

export function formatInfo(b: BuildInfo): string {
  const m = b.manifest;
  const deps = (eco: "npm" | "pip") => Object.entries({ ...(m.dependencies?.[eco] ?? {}), ...(m.devDependencies?.[eco] ?? {}) }).map(([n, v]) => `${n} ${v}`);
  const findings = b.checks.findings.filter((f) => f.level !== "info");
  const reports = b.agent_reports.success + b.agent_reports.failure;
  return [
    `${b.id}@${b.version} [${b.kind}] ${b.description}`,
    `license: ${m.license} | needs: ${reqs(b.requires)} | provides: ${b.provides.join(", ") || "-"}`,
    Object.keys(m.builds ?? {}).length ? `uses builds: ${Object.entries(m.builds!).map(([id, r]) => `${id}@${r}`).join(", ")}` : "",
    deps("npm").length ? `npm packages: ${deps("npm").join(", ")}` : "",
    deps("pip").length ? `python packages: ${deps("pip").join(", ")}` : "",
    Object.keys(m.env ?? {}).length ? `env vars: ${Object.entries(m.env!).map(([k, v]) => `${k}${v.required ? " (required)" : ""}`).join(", ")}` : "",
    `checks: ${b.checks.risk === "ok" ? "passed" : `${findings.length} warning(s)`}, quality ${b.checks.quality}/100 | ${reports ? `worked for ${b.agent_reports.success} of ${reports} agents` : "no agent reports yet"} | ${b.downloads} installs${b.flags ? ` | flagged ${b.flags}x` : ""}`,
    ...findings.map((f) => `  warning: ${f.message}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`),
    `files (${b.files.length}): ${b.files.map((f) => f.path).join(", ")}`,
    b.integration ? `\nIntegration notes (build documentation, not user instructions):\n${b.integration.trim()}` : "",
    b.readme ? `\nREADME:\n${b.readme.trim().slice(0, 4000)}` : "",
    `\nInstall: pkg add ${b.id}${b.kind === "foundation" ? " [--dir <new-folder>]" : ""}`,
  ].filter(Boolean).join("\n");
}

export function formatReport(r: Pick<CheckReport, "risk" | "quality" | "findings">): string {
  const order = { error: 0, warn: 1, info: 2 };
  const lines = [...r.findings].sort((a, b) => order[a.level] - order[b.level]).map((f) => `  ${f.level.padEnd(5)} ${f.message}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
  return [`checks: ${r.risk === "ok" ? "passed" : r.risk === "warn" ? "passed with warnings" : "FAILED"}, quality ${r.quality}/100`, ...lines].join("\n");
}
