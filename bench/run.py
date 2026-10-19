#!/usr/bin/env python3
"""Run the pkg A/B benchmark: identical headless Claude Code agents, with and without the pkg MCP server.

    python3 -I bench/run.py --out bench/results/<label> [--model M] [--reps 5] [--tasks small,medium,large]

Each (task, rep) is a pair: the control and pkg runs start at the same moment, so both
see the same API load, network and machine conditions. Pair order is shuffled with --seed.
Every run gets a fresh HOME (cold npm/pip caches, no user settings, skills, hooks or
CLAUDE.md), a fresh empty project directory and the same prompt, model, effort, tools,
permissions, budget and timeout. The only difference: the pkg arm has the published
@tneemo/pkg MCP server configured, exactly as `claude mcp add pkg -- npx -y @tneemo/pkg mcp`
would, pinned to --pkg-version. Its prompt does not mention pkg.
"""
import argparse
import concurrent.futures
import datetime
import gzip
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tarfile
import threading
import time
import uuid

BENCH = os.path.dirname(os.path.abspath(__file__))
TIMEOUTS = {"small": 1200, "medium": 2400, "large": 3600}
TOOLS = "Bash,Read,Edit,Write,Glob,Grep,ToolSearch,TodoWrite"
ENV_ALLOW = [
    "PATH", "LANG", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
    "CURL_CA_BUNDLE", "PIP_CERT", "REQUESTS_CA_BUNDLE", "UV_NATIVE_TLS", "GIT_SSL_CAINFO", "npm_config_https_proxy",
    "npm_config_noproxy", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
]
CONTAMINATION = ("/home/user/pkg", "bench/grade.py", "bench/results", "bench/tasks")
LOCK = threading.Lock()


def log(msg):
    with LOCK:
        print(f"[{datetime.datetime.now():%H:%M:%S}] {msg}", flush=True)


def sh(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    return p.returncode, (p.stdout + p.stderr).strip()


def preflight(args):
    info = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    info["claude_version"] = sh(["claude", "--version"])[1]
    info["node_version"] = sh(["node", "--version"])[1]
    info["python_version"] = sh(["python3", "--version"])[1]
    rc, v = sh(["npm", "view", f"@tneemo/pkg@{args.pkg_version}", "version"])
    info["pkg_npm_version"] = v if rc == 0 else None
    rc, latest = sh(["npm", "view", "@tneemo/pkg", "version"])
    info["pkg_npm_latest"] = latest
    rc, code = sh(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20",
                   f"{args.registry}/llms.txt"])
    info["registry_http_status"] = code
    problems = []
    if info["pkg_npm_version"] != args.pkg_version:
        problems.append(f"@tneemo/pkg@{args.pkg_version} is not published on npm ({v})")
    if "pkg" in args.arms and code != "200":
        problems.append(f"pkg registry {args.registry} unreachable from this machine ({code}); "
                        "the pkg arm would run without any builds, which is not the intervention being measured")
    return info, problems


def run_env(home):
    env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
    env["HOME"] = home
    return env


def write_mcp_config(path, arm, args):
    servers = {}
    if arm == "pkg":
        servers["pkg"] = {"command": "npx", "args": ["-y", f"@tneemo/pkg@{args.pkg_version}", "mcp"]}
    with open(path, "w") as fh:
        json.dump({"mcpServers": servers}, fh, indent=2)


def run_one(task, arm, rep, args, out_dir):
    name = f"{task}-{arm}-r{rep}"
    # Agents work in an opaque directory outside any git repo: no path names that hint at
    # the arm or at pkg, no parent CLAUDE.md, no view of this benchmark. Evidence is copied
    # to out_dir afterwards.
    rdir = os.path.join(args.work_root, uuid.uuid4().hex[:12])
    keep = os.path.join(out_dir, "runs", name)
    shutil.rmtree(keep, ignore_errors=True)
    os.makedirs(keep)
    home, project = os.path.join(rdir, "home"), os.path.join(rdir, "project")
    os.makedirs(home)
    os.makedirs(project)
    with open(os.path.join(home, ".gitconfig"), "w") as fh:
        fh.write("[user]\n\tname = bench\n\temail = bench@example.com\n[init]\n\tdefaultBranch = main\n")
    mcp_path = os.path.join(rdir, "mcp.json")
    write_mcp_config(mcp_path, arm, args)
    prompt = open(os.path.join(BENCH, "tasks", f"{task}.md")).read()
    cmd = ["claude", "-p", prompt, "--model", args.model, "--effort", args.effort,
           "--output-format", "stream-json", "--verbose", "--no-session-persistence",
           "--strict-mcp-config", "--mcp-config", mcp_path,
           "--tools", TOOLS, "--permission-mode", "acceptEdits",
           "--allowedTools", *TOOLS.split(","), "mcp__pkg",
           "--disallowedTools", "mcp__pkg__publish_build",
           "--max-budget-usd", str(args.max_budget_usd)]
    transcript = os.path.join(rdir, "transcript.jsonl")
    log(f"start {name}")
    t0 = time.monotonic()
    timed_out = False
    with open(transcript, "wb") as out, open(os.path.join(rdir, "stderr.log"), "wb") as err:
        p = subprocess.Popen(cmd, cwd=project, env=run_env(home), stdout=out, stderr=err,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            p.wait(timeout=TIMEOUTS[task])
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()
    wall = time.monotonic() - t0
    # Background processes the agent left running (dev servers) would hold ports during grading.
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

    metrics = parse_transcript(transcript)
    lock_file = os.path.join(project, "pkg.lock.json")
    if os.path.isfile(lock_file):
        try:
            lock = json.load(open(lock_file))
            metrics["pkg_lock_builds"] = sorted(
                f"{k}@{v.get('version')}" for k, v in (lock.get("builds") or {}).items())
        except (ValueError, AttributeError):
            metrics["pkg_lock_builds"] = ["<unreadable pkg.lock.json>"]
    metrics["agent_config_files"] = [f for f in (".claude", ".mcp.json", "CLAUDE.md", "AGENTS.md", ".cursor")
                                     if os.path.exists(os.path.join(project, f))]

    log(f"grade {name} (agent {wall:.0f}s, exit {p.returncode}{', TIMEOUT' if timed_out else ''})")
    grade_path = os.path.join(rdir, "grade.json")
    g0 = time.monotonic()
    try:
        subprocess.run([sys.executable, "-I", os.path.join(BENCH, "grade.py"), task, project, grade_path],
                       capture_output=True, timeout=2400, env={**os.environ, "HOME": home})
        grade = json.load(open(grade_path))
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        grade = {"success": False, "summary": {}, "checks": [], "notes": [f"grading failed: {e!r}"]}

    record = {
        "name": name, "workdir": rdir, "task": task, "arm": arm, "rep": rep, "model_requested": args.model, "effort": args.effort,
        "exit_code": p.returncode, "timed_out": timed_out, "wall_seconds": round(wall, 1),
        "grade_seconds": round(time.monotonic() - g0, 1), "metrics": metrics, "grade": grade,
    }
    record["success"] = bool(grade.get("success")) and not timed_out and not metrics.get("is_error")
    with open(os.path.join(keep, "run.json"), "w") as fh:
        json.dump(record, fh, indent=2)
    for f in ("grade.json", "stderr.log", "mcp.json"):
        if os.path.exists(os.path.join(rdir, f)):
            shutil.copy(os.path.join(rdir, f), keep)
    with open(transcript, "rb") as src, gzip.open(os.path.join(keep, "transcript.jsonl.gz"), "wb") as dst:
        shutil.copyfileobj(src, dst)
    skip = {"node_modules", ".venv", "venv", ".git", "__pycache__", ".pytest_cache", "dist", "data"}
    with tarfile.open(os.path.join(keep, "project.tar.gz"), "w:gz") as tar:
        tar.add(project, arcname="project",
                filter=lambda ti: None if set(ti.name.split("/")) & skip or ti.name.endswith((".db", ".sqlite")) else ti)
    if not args.keep_artifacts:
        shutil.rmtree(rdir, ignore_errors=True)
    s = grade.get("summary", {})
    log(f"done {name}: success={record['success']} func={fmt(s.get('functional'))} sec={fmt(s.get('security'))} "
        f"cost=${metrics.get('cost_usd')} turns={metrics.get('num_turns')}")
    return record


def fmt(d):
    return f"{d['passed']}/{d['total']}" if d else "-"


def parse_transcript(path):
    m = {"tool_calls": {}, "pkg_mcp_calls": [], "pkg_cli_commands": [], "pkg_errors": [], "tool_errors": 0,
         "contamination": [], "mcp_servers": None, "models_seen": set(), "result_subtype": None}
    usage_by_msg = {}
    pkg_ids = set()
    result = None
    for line in open(path, errors="replace"):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            m["mcp_servers"] = ev.get("mcp_servers")
            m["init_model"] = ev.get("model")
            m["init_tools"] = ev.get("tools")
        elif t == "assistant":
            msg = ev.get("message") or {}
            if msg.get("model"):
                m["models_seen"].add(msg["model"])
            if msg.get("id") and msg.get("usage"):
                usage_by_msg[msg["id"]] = msg["usage"]
            for block in msg.get("content") or []:
                if block.get("type") != "tool_use":
                    continue
                name = block.get("name", "?")
                m["tool_calls"][name] = m["tool_calls"].get(name, 0) + 1
                inp = json.dumps(block.get("input"))
                if name.startswith("mcp__pkg__"):
                    pkg_ids.add(block.get("id"))
                    m["pkg_mcp_calls"].append({"tool": name, "input": block.get("input")})
                if name == "Bash" and ("@tneemo/pkg" in inp or "tpkg " in inp):
                    m["pkg_cli_commands"].append(block["input"].get("command", "")[:300])
                for needle in CONTAMINATION:
                    if needle in inp:
                        m["contamination"].append(f"{name}: {inp[:200]}")
        elif t == "user":
            for block in (ev.get("message") or {}).get("content") or []:
                if not (isinstance(block, dict) and block.get("type") == "tool_result"):
                    continue
                text = json.dumps(block.get("content"))
                if block.get("is_error"):
                    m["tool_errors"] += 1
                if block.get("tool_use_id") in pkg_ids and (block.get("is_error") or "cannot reach the registry" in text):
                    m["pkg_errors"].append(text[:300])
        elif t == "result":
            result = ev
    m["models_seen"] = sorted(m["models_seen"])
    if result:
        tok = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
        by_model = {}
        for model, u in (result.get("modelUsage") or {}).items():
            by_model[model] = {"input": u.get("inputTokens", 0), "output": u.get("outputTokens", 0),
                               "cache_read": u.get("cacheReadInputTokens", 0),
                               "cache_write": u.get("cacheCreationInputTokens", 0), "cost_usd": u.get("costUSD")}
            for k in tok:
                tok[k] += by_model[model][k]
        m.update(tokens=tok, tokens_by_model=by_model, cost_usd=result.get("total_cost_usd"),
                 num_turns=result.get("num_turns"), duration_ms=result.get("duration_ms"),
                 duration_api_ms=result.get("duration_api_ms"), is_error=result.get("is_error"),
                 result_subtype=result.get("subtype"), permission_denials=result.get("permission_denials"),
                 final_message=(result.get("result") or "")[:2000], usage_source="result")
    else:
        # Killed before the final result event: tokens are summed from per-message usage,
        # cost is unknown (not estimated), turns are counted from assistant messages.
        tok = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
        for u in usage_by_msg.values():
            tok["input"] += u.get("input_tokens", 0)
            tok["output"] += u.get("output_tokens", 0)
            tok["cache_read"] += u.get("cache_read_input_tokens", 0)
            tok["cache_write"] += u.get("cache_creation_input_tokens", 0)
        m.update(tokens=tok, cost_usd=None, num_turns=len(usage_by_msg), is_error=True,
                 usage_source="partial-transcript (main model only, no cost)")
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--effort", default="high")
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--tasks", default="small,medium,large")
    ap.add_argument("--arms", default="control,pkg")
    ap.add_argument("--parallel-pairs", type=int, default=2)
    ap.add_argument("--max-budget-usd", type=float, default=20)
    ap.add_argument("--pkg-version", default="1.1.1")
    ap.add_argument("--registry", default="https://pkg.tneemo.com")
    ap.add_argument("--seed", type=int, default=20261019)
    ap.add_argument("--work-root", default="/home/user/abw-work")
    ap.add_argument("--keep-artifacts", action="store_true")
    ap.add_argument("--skip-preflight", action="store_true", help="for harness smoke tests only")
    args = ap.parse_args()
    args.arms = args.arms.split(",")

    out_dir = os.path.abspath(args.out)
    os.makedirs(os.path.join(out_dir, "runs"), exist_ok=True)
    info, problems = preflight(args)
    info["args"] = vars(args)
    with open(os.path.join(out_dir, "environment.json"), "w") as fh:
        json.dump(info, fh, indent=2)
    log(json.dumps(info))
    if problems and not args.skip_preflight:
        for p in problems:
            log("PREFLIGHT FAILED: " + p)
        sys.exit(2)

    pairs = [(t, r) for t in args.tasks.split(",") for r in range(1, args.reps + 1)]
    random.Random(args.seed).shuffle(pairs)
    with open(os.path.join(out_dir, "schedule.json"), "w") as fh:
        json.dump(pairs, fh)

    def pair(task_rep):
        task, rep = task_rep
        with concurrent.futures.ThreadPoolExecutor(len(args.arms)) as ex:
            return [f.result() for f in [ex.submit(run_one, task, arm, rep, args, out_dir) for arm in args.arms]]

    with concurrent.futures.ThreadPoolExecutor(args.parallel_pairs) as ex:
        list(ex.map(pair, pairs))
    log("all runs finished; analyze with: python3 -I bench/analyze.py " + args.out)


if __name__ == "__main__":
    main()
