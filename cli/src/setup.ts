// `pkg setup`: registers the pkg MCP server (and Agent Skill) with coding agents found on this machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import SKILL from "../../skill/pkg/SKILL.md";

const isWin = process.platform === "win32";
// The claude CLI may be a .cmd shim on Windows, which needs a shell; arguments here are fixed strings.
const claudeCli = (args: string[]) => (isWin ? spawnSync(["claude", ...args].join(" "), { encoding: "utf8", shell: true }) : spawnSync("claude", args, { encoding: "utf8" }));
const SERVER = { command: "npx", args: ["-y", "@tneemo/pkg", "mcp"] };

function mergeJsonServers(path: string, key = "mcpServers"): string {
  let config: any = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return `skipped ${path} (not valid JSON; add the server by hand)`;
    }
  }
  config[key] ??= {};
  if (config[key].pkg) return `${path}: already configured`;
  config[key].pkg = SERVER;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return `${path}: added the pkg MCP server`;
}

export function setup(opts: { skill?: boolean } = {}): string[] {
  const home = homedir();
  const done: string[] = [];

  const claude = claudeCli(["--version"]);
  if (claude.status === 0 || existsSync(join(home, ".claude"))) {
    if (claude.status === 0) {
      const res = claudeCli(["mcp", "add", "--scope", "user", "pkg", "--", SERVER.command, ...SERVER.args]);
      done.push(res.status === 0 ? "Claude Code: added the pkg MCP server (user scope)" : `Claude Code: ${/already exists/i.test(res.stderr + res.stdout) ? "MCP server already configured" : `could not add MCP server: ${(res.stderr || res.stdout).trim()}`}`);
    } else {
      done.push("Claude Code: `claude` is not on PATH; run `claude mcp add pkg -- npx -y @tneemo/pkg mcp` yourself");
    }
    if (opts.skill !== false) {
      const path = join(home, ".claude", "skills", "pkg", "SKILL.md");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, SKILL);
      done.push(`Claude Code: installed the pkg skill at ${path}`);
    }
  }
  if (existsSync(join(home, ".cursor"))) done.push(`Cursor: ${mergeJsonServers(join(home, ".cursor", "mcp.json"))}`);
  if (existsSync(join(home, ".codeium", "windsurf"))) done.push(`Windsurf: ${mergeJsonServers(join(home, ".codeium", "windsurf", "mcp_config.json"))}`);
  if (existsSync(join(home, ".gemini"))) done.push(`Gemini CLI: ${mergeJsonServers(join(home, ".gemini", "settings.json"))}`);
  const codex = join(home, ".codex", "config.toml");
  if (existsSync(join(home, ".codex"))) {
    const toml = existsSync(codex) ? readFileSync(codex, "utf8") : "";
    if (/^\[mcp_servers\.pkg\]/m.test(toml)) done.push(`Codex: ${codex}: already configured`);
    else {
      writeFileSync(codex, `${toml}${toml && !toml.endsWith("\n") ? "\n" : ""}\n[mcp_servers.pkg]\ncommand = "npx"\nargs = ["-y", "@tneemo/pkg", "mcp"]\n`);
      done.push(`Codex: ${codex}: added the pkg MCP server`);
    }
  }
  if (!done.length) done.push("No supported coding agents found. Point any MCP client at: npx -y @tneemo/pkg mcp");
  return done;
}
