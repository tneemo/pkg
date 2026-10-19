#!/usr/bin/env python3
"""Summarize a benchmark result directory: python3 -I bench/analyze.py <out_dir>

Writes <out_dir>/summary.json and <out_dir>/REPORT.md. Every number comes from the
run.json files; nothing is filtered out. Failed runs stay in every metric (their cost,
tokens and time were spent), and are additionally listed one by one.
"""
import itertools
import json
import math
import os
import statistics
import sys

METRICS = [
    ("input_tokens", "Input tokens (uncached)", lambda r: r["metrics"]["tokens"]["input"]),
    ("output_tokens", "Output tokens", lambda r: r["metrics"]["tokens"]["output"]),
    ("cache_read_tokens", "Cache-read tokens", lambda r: r["metrics"]["tokens"]["cache_read"]),
    ("cache_write_tokens", "Cache-write tokens", lambda r: r["metrics"]["tokens"]["cache_write"]),
    ("cost_usd", "Cost (USD)", lambda r: r["metrics"].get("cost_usd")),
    ("wall_seconds", "Wall time (s)", lambda r: r["wall_seconds"]),
    ("turns", "Turns", lambda r: r["metrics"].get("num_turns")),
    ("functional_score", "Functional checks passed", lambda r: frac(r, "functional")),
    ("security_score", "Security checks passed", lambda r: frac(r, "security")),
]


def frac(r, kind):
    s = r["grade"].get("summary", {}).get(kind)
    return s["passed"] / s["total"] if s and s["total"] else 0.0


def quantile(xs, q):
    xs = sorted(xs)
    i = (len(xs) - 1) * q
    lo, hi = math.floor(i), math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def describe(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    mean = statistics.fmean(xs)
    sd = statistics.stdev(xs) if len(xs) > 1 else 0.0
    return {"n": len(xs), "median": statistics.median(xs), "p25": quantile(xs, 0.25), "p75": quantile(xs, 0.75),
            "min": min(xs), "max": max(xs), "mean": mean, "stdev": sd, "cv": sd / mean if mean else None,
            "values": xs}


def mann_whitney_exact(a, b):
    """Exact two-sided permutation p-value of the Mann-Whitney U statistic (ties get half credit)."""
    a, b = [x for x in a if x is not None], [x for x in b if x is not None]
    if not a or not b:
        return None
    def u(x, y):
        return sum((xi > yi) + 0.5 * (xi == yi) for xi in x for yi in y)
    pooled, n = a + b, len(a)
    centre = len(a) * len(b) / 2
    observed = abs(u(a, b) - centre)
    extreme = total = 0
    for idx in itertools.combinations(range(len(pooled)), n):
        s = set(idx)
        x = [pooled[i] for i in idx]
        y = [pooled[i] for i in range(len(pooled)) if i not in s]
        total += 1
        extreme += abs(u(x, y) - centre) >= observed - 1e-12
    return extreme / total


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [max(0.0, c - h), min(1.0, c + h)]


def failure_reasons(r):
    out = []
    m, g = r["metrics"], r["grade"]
    if r["timed_out"]:
        out.append("agent timed out")
    if m.get("result_subtype") not in (None, "success"):
        out.append(f"agent ended with {m.get('result_subtype')}")
    elif m.get("is_error"):
        out.append("agent reported an error")
    for kind in ("functional", "agent_tests"):
        failed = g.get("summary", {}).get(kind, {}).get("failed") or []
        if failed:
            out.append(f"{kind}: " + ", ".join(failed))
    if not g.get("summary"):
        out.append("not graded: " + "; ".join(g.get("notes", [])))
    out += [n for n in g.get("notes", []) if n.startswith("grader exception")]
    return out


def fmt(v, key):
    if v is None:
        return "n/a"
    if key == "cost_usd":
        return f"${v:.2f}"
    if key.endswith("_score"):
        return f"{v:.0%}"
    if key == "wall_seconds":
        return f"{v:.0f}"
    return f"{v:,.0f}"


def main():
    out_dir = sys.argv[1]
    runs = []
    for name in sorted(os.listdir(os.path.join(out_dir, "runs"))):
        p = os.path.join(out_dir, "runs", name, "run.json")
        if os.path.exists(p):
            runs.append(json.load(open(p)))
    env = json.load(open(os.path.join(out_dir, "environment.json")))
    tasks = [t for t in ("small", "medium", "large") if any(r["task"] == t for r in runs)]
    arms = [a for a in ("control", "pkg") if any(r["arm"] == a for r in runs)]
    summary = {"environment": env, "groups": {}, "comparisons": {}, "failures": [], "security_failures": [],
               "pkg_usage": [], "integrity": []}

    for t in tasks:
        for a in arms:
            rs = [r for r in runs if r["task"] == t and r["arm"] == a]
            k = sum(r["success"] for r in rs)
            g = {"n": len(rs), "successes": k, "success_rate": k / len(rs) if rs else None,
                 "success_rate_ci95": wilson(k, len(rs))}
            for key, _, fn in METRICS:
                g[key] = describe([fn(r) for r in rs])
            summary["groups"][f"{t}/{a}"] = g
        if len(arms) == 2:
            cmp = {}
            for key, _, fn in METRICS:
                xa = [fn(r) for r in runs if r["task"] == t and r["arm"] == "control"]
                xb = [fn(r) for r in runs if r["task"] == t and r["arm"] == "pkg"]
                da, db = describe(xa), describe(xb)
                if da and db:
                    diff = db["median"] - da["median"]
                    cmp[key] = {"median_control": da["median"], "median_pkg": db["median"], "diff": diff,
                                "rel": diff / da["median"] if da["median"] else None,
                                "mann_whitney_p": mann_whitney_exact(xa, xb)}
            summary["comparisons"][t] = cmp

    for r in runs:
        if not r["success"]:
            summary["failures"].append({"run": r["name"], "reasons": failure_reasons(r)})
        failed_sec = r["grade"].get("summary", {}).get("security", {}).get("failed") or []
        if failed_sec:
            details = {c["name"]: c["detail"] for c in r["grade"].get("checks", []) if c["kind"] == "security" and not c["ok"]}
            summary["security_failures"].append({"run": r["name"], "failed": details})
        m = r["metrics"]
        if r["arm"] == "pkg":
            calls = {}
            for c in m.get("pkg_mcp_calls", []):
                calls[c["tool"].replace("mcp__pkg__", "")] = calls.get(c["tool"].replace("mcp__pkg__", ""), 0) + 1
            installs = [c["input"] for c in m.get("pkg_mcp_calls", []) if c["tool"].endswith("install_builds")]
            summary["pkg_usage"].append({
                "run": r["name"], "used_pkg": bool(m.get("pkg_mcp_calls") or m.get("pkg_cli_commands")),
                "mcp_calls": calls, "pkg_errors": m.get("pkg_errors", []), "cli_commands": m.get("pkg_cli_commands", []),
                "installed_builds": m.get("pkg_lock_builds", []), "install_calls": installs,
                "mcp_status": [(s.get("name"), s.get("status")) for s in (m.get("mcp_servers") or [])]})
        problems = []
        if m.get("contamination"):
            problems.append({"contamination": m["contamination"]})
        served = set((m.get("tokens_by_model") or {}).keys()) | set(m.get("models_seen") or [])
        if r["model_requested"] not in served and served:
            problems.append({"model_mismatch": sorted(served)})
        if r["arm"] == "pkg" and any("cannot reach the registry" in e for e in m.get("pkg_errors", [])):
            problems.append({"registry_unreachable_during_run": "this run did not test pkg; rerun it"})
        if r["arm"] == "control" and (m.get("pkg_mcp_calls") or m.get("pkg_cli_commands")):
            problems.append({"control_used_pkg": m.get("pkg_cli_commands")})
        if problems:
            summary["integrity"].append({"run": r["name"], "problems": problems})

    with open(os.path.join(out_dir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    with open(os.path.join(out_dir, "REPORT.md"), "w") as fh:
        fh.write(render(summary, tasks, arms))
    print(open(os.path.join(out_dir, "REPORT.md")).read())


def render(s, tasks, arms):
    env = s["environment"]
    a = env.get("args", {})
    L = [f"# pkg A/B benchmark results", "",
         f"- Model: `{a.get('model')}`, effort `{a.get('effort')}`, {a.get('reps')} runs per group, "
         f"pairs run concurrently in seeded random order (seed {a.get('seed')})",
         f"- Claude Code {env.get('claude_version')}, Node {env.get('node_version')}, {env.get('python_version')}",
         f"- pkg arm: `@tneemo/pkg@{a.get('pkg_version')}` MCP server (npm latest at start: {env.get('pkg_npm_latest')}), "
         f"registry `{a.get('registry')}` (HTTP {env.get('registry_http_status')} at preflight)",
         f"- Started {env.get('started_at')}", "",
         "Medians with [p25–p75] and (min–max). Δ = pkg − control on medians; p = exact two-sided "
         "Mann–Whitney. With 5 vs 5 runs the smallest possible p is 0.008; treat p > 0.05 as no detectable difference.", ""]
    for t in tasks:
        L += [f"## {t}", ""]
        hdr = "| Metric | " + " | ".join(arms) + (" | Δ (rel) | p |" if len(arms) == 2 else "")
        L += [hdr, "|" + "---|" * (len(arms) + 1 + (2 if len(arms) == 2 else 0))]
        row = "| Success rate | "
        for arm in arms:
            g = s["groups"][f"{t}/{arm}"]
            ci = g["success_rate_ci95"]
            row += f"{g['successes']}/{g['n']} (95% CI {ci[0]:.0%}–{ci[1]:.0%}) | "
        L.append(row + (" | |" if len(arms) == 2 else ""))
        for key, label, _ in METRICS:
            row = f"| {label} | "
            for arm in arms:
                d = s["groups"][f"{t}/{arm}"][key]
                row += (f"{fmt(d['median'], key)} [{fmt(d['p25'], key)}–{fmt(d['p75'], key)}] "
                        f"({fmt(d['min'], key)}–{fmt(d['max'], key)}) | ") if d else "n/a | "
            if len(arms) == 2:
                c = s["comparisons"][t].get(key)
                if c:
                    rel = f" ({c['rel']:+.0%})" if c["rel"] is not None else ""
                    sign = "+" if c["diff"] >= 0 else "−"
                    row += f"{sign}{fmt(abs(c['diff']), key)}{rel} | {c['mann_whitney_p']:.3f} |"
                else:
                    row += "n/a | n/a |"
            L.append(row)
        L.append("")
    L += ["## All failures", ""]
    L += [f"- **{f['run']}**: " + "; ".join(f["reasons"]) for f in s["failures"]] or ["None."]
    L += ["", "## Security check failures", ""]
    for f in s["security_failures"]:
        L.append(f"- **{f['run']}**: " + "; ".join(f"{k} ({v})" for k, v in f["failed"].items()))
    if not s["security_failures"]:
        L.append("None.")
    if s["pkg_usage"]:
        L += ["", "## Did the pkg agent use pkg?", "", "| Run | Called pkg | MCP calls | pkg errors | Installed builds |", "|---|---|---|---|---|"]
        for u in s["pkg_usage"]:
            calls = ", ".join(f"{k}×{v}" for k, v in u["mcp_calls"].items()) or "none"
            L.append(f"| {u['run']} | {'yes' if u['used_pkg'] else 'no'} | {calls} | {len(u['pkg_errors'])} | {', '.join(u['installed_builds']) or '-'} |")
    L += ["", "## Integrity checks", ""]
    L += [f"- **{i['run']}**: {json.dumps(i['problems'])[:500]}" for i in s["integrity"]] or [
        "No contamination, no model mismatch, control never used pkg."]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
