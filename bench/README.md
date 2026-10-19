# pkg A/B benchmark

Does giving a coding agent pkg make it cheaper, faster, more reliable or more secure? This
harness measures that with identical agents, one with the published pkg MCP server and one without,
and an independent black-box grader. It is built to be rerun by anyone and to report pkg losing as
readily as winning.

```bash
python3 -I bench/run.py --out bench/results/$(date +%F) --model claude-sonnet-5-5 --reps 5
python3 -I bench/analyze.py bench/results/$(date +%F)     # writes REPORT.md and summary.json
```

Requires the `claude` CLI (authenticated), Node.js 22, Python 3.10+, `curl`, and network access to
the Anthropic API, `registry.npmjs.org`, `pypi.org`/`files.pythonhosted.org` and `pkg.tneemo.com`.
`run.py` refuses to start when the pkg registry is unreachable: a pkg arm without builds is not the
intervention being measured. 30 runs (3 tasks × 2 arms × 5) take roughly 1–3 hours with 2 concurrent pairs.

## Design

| | Control | pkg |
|---|---|---|
| Model, effort | same `--model`, same `--effort` | same |
| Prompt | `tasks/<task>.md`, never mentions pkg | identical |
| Tools | Bash, Read, Edit, Write, Glob, Grep, ToolSearch | same + the pkg MCP tools |
| MCP servers | none (`--strict-mcp-config`) | only `npx -y @tneemo/pkg@<version> mcp`, as `claude mcp add` sets it up |
| Permissions, budget, timeout | `acceptEdits` + the tools above, `--max-budget-usd 20`, 20/40/60 min | same |
| HOME, project dir | fresh and empty per run (cold npm/pip caches, no user settings, skills, hooks, CLAUDE.md) | same |

- **Published builds only.** The pkg arm uses the npm release of `@tneemo/pkg` (pinned with `--pkg-version`,
  default the latest release at the time of writing, 1.1.1) against the production registry. Nothing in this
  directory is published to pkg, and no build was written for these tasks.
- **Natural use.** The prompt does not mention pkg. The pkg agent learns about it only from the MCP server's
  instructions and tool list and decides whether to use it. Whether it did is reported per run.
  `publish_build` is disabled so a run cannot publish anything. `report_outcome` is allowed because it is part
  of normal use, which means pkg-arm runs may cast reputation votes (deduplicated per IP per day by the registry).
- **Same conditions in time.** Each (task, rep) runs as a pair: control and pkg start at the same moment, so
  API latency, network and machine load hit both. Pair order is shuffled with a fixed seed (`schedule.json`).
- **No hints in paths.** Agents work in an opaque directory outside any git repository
  (`--work-root`, default `/home/user/abw-work/<random>`), so neither arm can see this benchmark or the pkg
  source. Transcripts are scanned for references to it anyway (`integrity` in the report).

### Tasks

| Task | Stack | What | Overlap with published builds |
|---|---|---|---|
| small | Python, FastAPI | Quote API with `X-API-Key` auth from `API_KEYS`, pytest | `fastapi-service`, `fastapi-api-key` |
| medium | TypeScript, Node 22 | Todo REST API: register/login, per-user todos, SQLite, tests | `hono-api`, `hono-auth`, `sqlite-db` (the README's own showcase) |
| large | TypeScript, Node 22 | Bookmarks API: auth, CRUD, tags, search, pagination, tag counts, login rate limit, persistence, tests | the above + `hono-rate-limit`; search/tags/pagination have no build |

All three overlap with the catalogue, which favours pkg. Tasks with no overlap would only measure the cost of
the MCP server's extra context and searches. That cost is real too, but it is not what pkg claims to save. The API
contracts use common names (`/auth/register`, `JWT_SECRET`, `DATABASE_PATH`, `API_KEYS`). Some of these match the
builds, but the route prefix and response shapes do not (`hono-auth` serves `/register` and returns `{ user, token }`),
so the pkg agent has to adapt the builds the way it would for a real project.

## What is measured

From the final `result` event of `claude -p --output-format stream-json` (`run.py: parse_transcript`):

- **Tokens**: uncached input, output, cache-read and cache-write, summed over every model the session used
  (including the small model Claude Code uses for housekeeping).
- **Cost**: `total_cost_usd` as reported by Claude Code. It is computed from list prices, not taken from an invoice.
  If a run is killed at the timeout there is no result event: its tokens are summed from per-message usage,
  its cost is reported as n/a (never estimated), and it counts as a failure.
- **Wall time**: measured by the harness around the agent process, excluding grading. **Turns**: `num_turns`.

From `grade.py`, which the agent never sees, run after the agent exits against a fresh database and port:

- **Success** = every functional check passes **and** the project's own tests pass (`npm test` / `pytest`)
  **and** the agent finished without error or timeout. The functional score (fraction of checks) is reported too.
- **Functional checks**: the HTTP contract from the prompt, including validation, 404s for other users' data,
  persistence across a restart (medium/large) and the rate limit (large).
- **Security checks** (reported separately, not part of success): access to other users' data (read/update/delete),
  data isolation in lists, owner mass assignment, SQL injection in login and query parameters, `alg: none` /
  tampered / common-secret / expired JWTs, tokens issued with `JWT_SECRET` unset in production, plaintext
  passwords in the database, files or logs, `javascript:` URLs, rate-limit bypass via a spoofed `X-Forwarded-For`,
  fail-closed API keys, blank keys, constant-time key comparison, API keys in logs, and `npm audit --omit=dev`
  high/critical findings.

## Statistics and reporting

`analyze.py` reports, per task and arm: median, p25–p75, min–max, mean, standard deviation and coefficient of
variation of every metric, success rate with a Wilson 95% interval, the median difference (pkg − control), and an
exact two-sided Mann–Whitney p-value. With 5 runs per group the smallest possible p is 0.008 and only large effects
are detectable. Every failed run is listed with its reasons, every failed security check with its detail, and for
every pkg-arm run whether pkg was used and which builds were installed. Nothing is excluded.

Each run directory under `results/<label>/runs/` keeps `run.json` (all metrics), `grade.json` (every check),
`transcript.jsonl.gz` (the full agent transcript), `project.tar.gz` (the code the agent produced, without
dependencies) and the MCP config used.

## Known limitations

- 5 runs per group is small. Treat differences without a low p-value as noise.
- One model and one agent (Claude Code) are tested. Other agents use MCP differently.
- List-price cost ignores negotiated pricing, and both arms benefit equally from prompt caching.
- Cold npm/pip caches in every run add the same download time to both arms. The pkg arm also pays for `npx`
  fetching `@tneemo/pkg` and for registry round-trips, which is part of the real cost of using it.
- The grader checks behaviour against the prompt, not code quality or maintainability.

## Grader validation

Before the first benchmark, the grader was checked in both directions on code written by control-arm smoke runs
(excluded from all results):

- **No false failures**: the unmodified small, medium and large projects passed every functional, security and
  test check (8/8, 18/18 and 29/29 functional; 4/4, 13/13 and 19/19 security).
- **Each check fires**: five vulnerabilities injected one at a time into those projects were each caught by the
  check meant for it: ownership check removed (`idor_blocked`, `other_users_bookmark_404`), passwords stored in
  plaintext (`password_not_stored_or_logged_plaintext`), rate limit disabled (`login_rate_limit_after_10`),
  `JWT_SECRET || 'secret'` fallback (`no_default_jwt_secret`, which also guessed the secret) and an
  `API_KEYS` default key (`fail_closed_without_keys`).
- **Outage guard**: a pkg-arm smoke run with the registry blocked was flagged by `analyze.py` as
  `registry_unreachable_during_run` instead of being counted as a pkg result.
