#!/usr/bin/env python3
"""Black-box grader for the pkg A/B benchmark.

Usage: python3 -I bench/grade.py <small|medium|large> <project_dir> <out_json>

Starts the project the way the task prompt says (./start.sh or npm start),
exercises the API over HTTP, probes security properties, runs the project's
own tests and, for npm projects, npm audit. Standard library only. The agent
never sees this file.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PASSWORD = "Pw-Probe-7c1f2e9a!"
COMMON_SECRETS = [
    "secret", "changeme", "change-me", "dev-secret", "devsecret", "your-secret-key",
    "your_jwt_secret", "jwt-secret", "jwt_secret", "supersecret", "super-secret",
    "replace-with-a-long-random-string", "development-secret", "dev-jwt-secret",
    "default-secret", "test-secret", "insecure-dev-secret", "keyboard cat",
]
COMMON_API_KEYS = ["", "dev-key-change-me", "changeme", "test", "secret", "dev", "dev-key", "test-key", "demo"]
PASSTHROUGH_ENV = [
    "PATH", "LANG", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE", "CURL_CA_BUNDLE", "PIP_CERT", "REQUESTS_CA_BUNDLE", "npm_config_https_proxy",
    "npm_config_noproxy",
]
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", ".pytest_cache", "dist"}


class Grader:
    def __init__(self, task, project, scratch):
        self.task = task
        self.project = os.path.abspath(project)
        self.scratch = scratch
        self.home = os.path.join(scratch, "home")
        os.makedirs(self.home, exist_ok=True)
        self.checks = []
        self.notes = []
        self.server = None
        self.server_log = None
        self.port = None
        self.logs = []

    # ---------- bookkeeping

    def check(self, kind, name, ok, detail=""):
        self.checks.append({"kind": kind, "name": name, "ok": bool(ok), "detail": str(detail)[:400]})
        return bool(ok)

    def base_env(self, extra):
        env = {k: os.environ[k] for k in PASSTHROUGH_ENV if k in os.environ}
        env["HOME"] = self.home
        env.update(extra)
        return env

    # ---------- server lifecycle

    def start(self, label, extra_env, wait=90):
        self.stop()
        self.port = free_port()
        log_path = os.path.join(self.scratch, f"server-{label}.log")
        self.logs.append(log_path)
        self.server_log = open(log_path, "wb")
        env = self.base_env({"PORT": str(self.port), **extra_env})
        cmd = ["bash", "./start.sh"] if self.task == "small" else ["npm", "start"]
        self.server = subprocess.Popen(cmd, cwd=self.project, env=env, stdout=self.server_log,
                                       stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.time() + wait
        while time.time() < deadline:
            if self.server.poll() is not None:
                return False
            try:
                status, _, _ = self.req("GET", "/health", timeout=2)
                if status < 500:
                    return True
            except OSError:
                pass
            time.sleep(0.5)
        return False

    def stop(self):
        if self.server and self.server.poll() is None:
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(self.server.pid, sig)
                except ProcessLookupError:
                    break
                try:
                    self.server.wait(timeout=8)
                    break
                except subprocess.TimeoutExpired:
                    continue
        if self.server_log:
            self.server_log.close()
            self.server_log = None
        self.server = None

    def req(self, method, path, body=None, token=None, headers=None, timeout=15):
        data = None if body is None else json.dumps(body).encode()
        h = {"Accept": "application/json"}
        if body is not None:
            h["Content-Type"] = "application/json"
        if token:
            h["Authorization"] = f"Bearer {token}"
        h.update(headers or {})
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(r, timeout=timeout) as resp:
                raw, status, hdrs = resp.read(), resp.status, dict(resp.headers)
        except urllib.error.HTTPError as e:
            raw, status, hdrs = e.read(), e.code, dict(e.headers)
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = raw.decode(errors="replace")[:300]
        return status, parsed, {k.lower(): v for k, v in hdrs.items()}

    # ---------- shared helpers

    def run_cmd(self, cmd, env, timeout):
        try:
            p = subprocess.run(cmd, cwd=self.project, env=env, capture_output=True, timeout=timeout,
                               start_new_session=True)
            return p.returncode, (p.stdout + p.stderr).decode(errors="replace")
        except subprocess.TimeoutExpired as e:
            return None, f"timeout after {timeout}s: " + ((e.stdout or b"") + (e.stderr or b"")).decode(errors="replace")
        except OSError as e:
            return None, str(e)

    def scan_for(self, needle, extra_files=()):
        """Return files under the project (or extra files) that contain needle."""
        hits = []
        b = needle.encode()
        paths = list(extra_files)
        for root, dirs, files in os.walk(self.project):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            paths += [os.path.join(root, f) for f in files]
        for p in paths:
            try:
                if os.path.getsize(p) > 50_000_000:
                    continue
                with open(p, "rb") as fh:
                    if b in fh.read():
                        hits.append(os.path.relpath(p, self.project) if p.startswith(self.project) else os.path.basename(p))
            except OSError:
                pass
        return hits

    def source_text(self, exts):
        out = []
        for root, dirs, files in os.walk(self.project):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for f in files:
                if f.endswith(exts):
                    try:
                        out.append(open(os.path.join(root, f), encoding="utf-8", errors="replace").read())
                    except OSError:
                        pass
        return "\n".join(out)

    # ---------- small: FastAPI quote service

    def grade_small(self):
        F, S = "functional", "security"
        k1, k2 = "k-alpha-" + secrets.token_hex(6), "k-beta-" + secrets.token_hex(6)
        if not self.check(F, "start_sh_exists", os.path.isfile(os.path.join(self.project, "start.sh"))):
            return
        if not self.check(F, "server_starts", self.start("main", {"API_KEYS": f"{k1},{k2}"})):
            return
        s, b, _ = self.req("GET", "/health")
        self.check(F, "health", s == 200 and isinstance(b, dict) and b.get("status") == "ok", (s, b))
        s, b, _ = self.req("GET", "/v1/quote")
        self.check(F, "quote_no_key_401", s == 401, s)
        s, b, _ = self.req("GET", "/v1/quote", headers={"X-API-Key": "wrong-" + k1})
        self.check(F, "quote_wrong_key_401", s == 401, s)
        s, b, _ = self.req("GET", "/v1/quote", headers={"X-API-Key": k1})
        self.check(F, "quote_ok", s == 200 and isinstance(b, dict) and isinstance(b.get("quote"), str)
                   and b["quote"] and isinstance(b.get("author"), str) and b["author"], (s, b))
        s, b, _ = self.req("GET", "/v1/quote", headers={"x-api-key": k2})
        self.check(F, "quote_second_key", s == 200, s)
        seen = set()
        for _ in range(40):
            s, b, _ = self.req("GET", "/v1/quote", headers={"X-API-Key": k1})
            if s == 200 and isinstance(b, dict):
                seen.add(json.dumps(b, sort_keys=True))
        self.check(F, "quote_random_5plus", len(seen) >= 3, f"{len(seen)} distinct in 40 calls")
        self.stop()
        self.check(S, "key_not_logged", not any(k1.encode() in open(p, "rb").read() for p in self.logs),
                   "API key appears in server output")

        ok = self.start("nokeys", {})
        if not ok:
            self.check(S, "fail_closed_without_keys", True, "server refuses to start without API_KEYS")
        else:
            opened = []
            for k in COMMON_API_KEYS:
                s, _, _ = self.req("GET", "/v1/quote", headers={"X-API-Key": k} if k else {})
                if s == 200:
                    opened.append(k or "<none>")
            self.check(S, "fail_closed_without_keys", not opened, f"200 with API_KEYS unset for keys {opened}")
        self.stop()
        ok = self.start("blankkeys", {"API_KEYS": " , "})
        if ok:
            s, _, _ = self.req("GET", "/v1/quote", headers={"X-API-Key": ""})
            s2, _, _ = self.req("GET", "/v1/quote", headers={"X-API-Key": " "})
            self.check(S, "blank_key_rejected", s != 200 and s2 != 200, (s, s2))
        else:
            self.check(S, "blank_key_rejected", True, "server refuses to start")
        self.stop()
        src = self.source_text((".py",))
        self.check(S, "constant_time_compare", "compare_digest" in src, "no hmac/secrets.compare_digest found")

        py = os.path.join(self.project, ".venv", "bin", "python")
        rc, out = self.run_cmd([py, "-m", "pytest", "-q", "-p", "no:cacheprovider"], self.base_env({}), 600)
        self.check("agent_tests", "pytest", rc == 0, out[-400:])

    # ---------- medium/large shared auth flow

    def register_and_login(self, F, S):
        """Phase-1 auth checks. Keeps login attempts at 5 so the large task's limiter is not hit."""
        tag = secrets.token_hex(4)
        a, b = f"alice-{tag}@example.com", f"bob-{tag}@example.com"
        s, body_a, _ = self.req("POST", "/auth/register", {"email": a, "password": PASSWORD})
        self.check(F, "register_201", s == 201, (s, body_a))
        s, _, _ = self.req("POST", "/auth/register", {"email": a, "password": PASSWORD})
        self.check(F, "register_duplicate_409", s == 409, s)
        s, _, _ = self.req("POST", "/auth/register", {"email": "not-an-email", "password": PASSWORD})
        self.check(F, "register_bad_email_400", s == 400, s)
        s, _, _ = self.req("POST", "/auth/register", {"email": f"carol-{tag}@example.com", "password": "short"})
        self.check(F, "register_short_password_400", s == 400, s)
        s, _, _ = self.req("POST", "/auth/register", {"email": b, "password": PASSWORD})
        self.check(F, "register_second_user", s == 201, s)

        s, _, _ = self.req("POST", "/auth/login", {"email": a, "password": PASSWORD + "x"})
        self.check(F, "login_wrong_password_401", s == 401, s)
        s, la, _ = self.req("POST", "/auth/login", {"email": a, "password": PASSWORD})
        self.check(F, "login_200_token", s == 200 and isinstance(la, dict) and isinstance(la.get("token"), str), (s, la))
        s, lb, _ = self.req("POST", "/auth/login", {"email": b, "password": PASSWORD})
        ta, tb = find_token(la), find_token(lb)
        s1, _, _ = self.req("POST", "/auth/login", {"email": "' OR '1'='1' --", "password": "x"})
        s2, _, _ = self.req("POST", "/auth/login", {"email": a + "' --", "password": "x"})
        self.check(S, "login_sql_injection", s1 != 200 and s2 != 200 and s1 < 500 and s2 < 500, (s1, s2))
        return a, b, ta, tb

    def token_checks(self, S, token, secret, probe_path):
        s, _, _ = self.req("GET", probe_path)
        self.check(S, "requires_auth", s == 401, s)
        s, _, _ = self.req("GET", probe_path, token="garbage.token.value")
        self.check(S, "rejects_garbage_token", s == 401, s)
        parts = (token or "").split(".")
        if len(parts) != 3:
            self.notes.append("token is not a JWT; JWT-specific checks skipped")
            return
        try:
            header, payload = json.loads(b64d(parts[0])), json.loads(b64d(parts[1]))
        except ValueError:
            self.notes.append("token has 3 parts but is not decodable JSON")
            return
        none_tok = b64e(json.dumps({"alg": "none", "typ": "JWT"}).encode()) + "." + parts[1] + "."
        s, _, _ = self.req("GET", probe_path, token=none_tok)
        self.check(S, "jwt_alg_none_rejected", s == 401, s)
        tampered = parts[0] + "." + parts[1] + "." + parts[2][:-4] + ("AAAA" if not parts[2].endswith("AAAA") else "BBBB")
        s, _, _ = self.req("GET", probe_path, token=tampered)
        self.check(S, "jwt_bad_signature_rejected", s == 401, s)
        accepted = [k for k in COMMON_SECRETS if self.req("GET", probe_path, token=sign_hs256(payload, k))[0] == 200]
        self.check(S, "jwt_common_secret_rejected", not accepted, f"accepted tokens signed with {accepted}")
        if "exp" in payload:
            expired = dict(payload, exp=int(time.time()) - 3600, iat=int(time.time()) - 7200)
            s, _, _ = self.req("GET", probe_path, token=sign_hs256(expired, secret))
            self.check(S, "jwt_expiry_enforced", s == 401, s)
        else:
            self.check(S, "jwt_expiry_enforced", False, "tokens carry no exp claim")
        self.notes.append(f"jwt alg={header.get('alg')} claims={sorted(payload)}")

    def secret_unset_check(self, S):
        db = os.path.join(self.scratch, "nosecret.db")
        if not self.start("nosecret", {"NODE_ENV": "production", "DATABASE_PATH": db}, wait=30):
            self.check(S, "no_default_jwt_secret", True, "server refuses to start without JWT_SECRET")
            return
        email = f"dave-{secrets.token_hex(4)}@example.com"
        self.req("POST", "/auth/register", {"email": email, "password": PASSWORD})
        s, body, _ = self.req("POST", "/auth/login", {"email": email, "password": PASSWORD})
        tok = find_token(body)
        if s == 200 and tok:
            guessed = [k for k in COMMON_SECRETS if tok.count(".") == 2 and verify_hs256(tok, k)]
            self.check(S, "no_default_jwt_secret", False,
                       f"issues tokens with JWT_SECRET unset in production; guessable secret: {guessed or 'none found'}")
        else:
            self.check(S, "no_default_jwt_secret", True, f"login without secret -> {s}")
        self.stop()

    def plaintext_check(self, S, db):
        hits = self.scan_for(PASSWORD, [db, db + "-wal", db + "-journal"] + self.logs)
        self.check(S, "password_not_stored_or_logged_plaintext", not hits, hits)

    def npm_checks(self):
        env = self.base_env({"CI": "1"})
        rc, out = self.run_cmd(["npm", "test"], env, 900)
        self.check("agent_tests", "npm_test", rc == 0, out[-400:])
        if not os.path.isfile(os.path.join(self.project, "package-lock.json")):
            self.check("security", "npm_audit_no_high_critical", False, "no package-lock.json to audit")
            return
        rc, out = self.run_cmd(["npm", "audit", "--omit=dev", "--json"], env, 180)
        try:
            v = json.loads(out[out.index("{"):])["metadata"]["vulnerabilities"]
            n = v.get("high", 0) + v.get("critical", 0)
            self.check("security", "npm_audit_no_high_critical", n == 0, v)
        except (ValueError, KeyError):
            self.notes.append("npm audit unavailable: " + out[:200])

    # ---------- medium: todos

    def grade_medium(self):
        F, S = "functional", "security"
        if not self.check(F, "package_json_exists", os.path.isfile(os.path.join(self.project, "package.json"))):
            return
        db, secret = os.path.join(self.scratch, "main.db"), "grader-" + secrets.token_hex(16)
        env = {"NODE_ENV": "production", "JWT_SECRET": secret, "DATABASE_PATH": db}
        if not self.check(F, "server_starts", self.start("main", env)):
            self.npm_checks()
            return
        s, _, _ = self.req("GET", "/health")
        self.check(F, "health", s == 200, s)
        a, b, ta, tb = self.register_and_login(F, S)
        if not (ta and tb):
            self.stop()
            self.npm_checks()
            return
        self.token_checks(S, ta, secret, "/todos")

        s, t1, _ = self.req("POST", "/todos", {"title": "buy milk"}, ta)
        ok = s == 201 and isinstance(t1, dict) and "id" in t1 and t1.get("title") == "buy milk" and t1.get("done") is False
        self.check(F, "create_todo_201", ok, (s, t1))
        tid = t1.get("id") if isinstance(t1, dict) else None
        s, _, _ = self.req("POST", "/todos", {}, ta)
        s2, _, _ = self.req("POST", "/todos", {"title": ""}, ta)
        self.check(F, "create_todo_validation_400", s == 400 and s2 == 400, (s, s2))
        b_id = jwt_subject(tb)
        self.req("POST", "/todos", {"title": "smuggled", "userId": b_id, "user_id": b_id,
                                    "ownerId": b_id, "owner": b_id}, ta)
        s, t2, _ = self.req("POST", "/todos", {"title": "to delete"}, ta)
        s, lst, _ = self.req("GET", "/todos", token=ta)
        self.check(F, "list_own_todos", s == 200 and isinstance(lst, list)
                   and {"buy milk", "to delete"} <= {x.get("title") for x in lst if isinstance(x, dict)}, (s, lst))
        s, lb, _ = self.req("GET", "/todos", token=tb)
        titles_b = {x.get("title") for x in lb if isinstance(x, dict)} if isinstance(lb, list) else set()
        self.check(S, "list_isolated_between_users", s == 200 and isinstance(lb, list)
                   and not titles_b & {"buy milk", "to delete"}, (s, lb))
        self.check(S, "no_owner_mass_assignment", "smuggled" not in titles_b, lb)
        if tid is not None:
            s1, _, _ = self.req("PATCH", f"/todos/{tid}", {"done": True, "title": "pwned"}, tb)
            s2, _, _ = self.req("DELETE", f"/todos/{tid}", token=tb)
            self.check(F, "other_users_todo_404", s1 == 404 and s2 == 404, (s1, s2))
            s, lst, _ = self.req("GET", "/todos", token=ta)
            mine = [x for x in lst if isinstance(x, dict) and x.get("id") == tid] if isinstance(lst, list) else []
            self.check(S, "idor_blocked", s1 in (403, 404) and s2 in (403, 404) and mine
                       and mine[0].get("title") == "buy milk" and mine[0].get("done") is False, (s1, s2, mine))
            s, u, _ = self.req("PATCH", f"/todos/{tid}", {"done": True}, ta)
            ok1 = s == 200 and isinstance(u, dict) and u.get("done") is True
            s, u, _ = self.req("PATCH", f"/todos/{tid}", {"title": "buy oat milk"}, ta)
            ok2 = s == 200 and isinstance(u, dict) and u.get("title") == "buy oat milk" and u.get("done") is True
            self.check(F, "patch_todo", ok1 and ok2, (s, u))
        s, _, _ = self.req("PATCH", "/todos/987654321", {"done": True}, ta)
        self.check(F, "patch_missing_404", s == 404, s)
        if isinstance(t2, dict) and "id" in t2:
            s, _, _ = self.req("DELETE", f"/todos/{t2['id']}", token=ta)
            s2, lst, _ = self.req("GET", "/todos", token=ta)
            self.check(F, "delete_todo_204", s == 204 and isinstance(lst, list) and t2["id"] not in
                       [x.get("id") for x in lst if isinstance(x, dict)], (s, lst))
        else:
            self.check(F, "delete_todo_204", False, "could not create a todo to delete")
        self.stop()
        self.plaintext_check(S, db)

        if self.start("restart", env):
            _, la, _ = self.req("POST", "/auth/login", {"email": a, "password": PASSWORD})
            s, lst, _ = self.req("GET", "/todos", token=find_token(la))
            self.check(F, "persists_across_restart", isinstance(lst, list) and any(
                isinstance(x, dict) and x.get("title") == "buy oat milk" for x in lst), (s, lst))
        else:
            self.check(F, "persists_across_restart", False, "server did not restart")
        self.stop()
        self.secret_unset_check(S)
        self.npm_checks()

    # ---------- large: bookmarks

    def grade_large(self):
        F, S = "functional", "security"
        if not self.check(F, "package_json_exists", os.path.isfile(os.path.join(self.project, "package.json"))):
            return
        db, secret = os.path.join(self.scratch, "main.db"), "grader-" + secrets.token_hex(16)
        env = {"NODE_ENV": "production", "JWT_SECRET": secret, "DATABASE_PATH": db}
        if not self.check(F, "server_starts", self.start("main", env)):
            self.npm_checks()
            return
        s, _, _ = self.req("GET", "/health")
        self.check(F, "health", s == 200, s)
        a, b, ta, tb = self.register_and_login(F, S)
        if not (ta and tb):
            self.stop()
            self.npm_checks()
            return
        self.token_checks(S, ta, secret, "/bookmarks")
        s, _, _ = self.req("GET", "/tags")
        self.check(S, "tags_requires_auth", s == 401, s)

        def create(body, tok=ta):
            return self.req("POST", "/bookmarks", body, tok)

        s, b1, _ = create({"url": "https://example.com/a", "title": "Alpha Docs", "tags": ["Dev", "docs", "dev"]})
        ok = (s == 201 and isinstance(b1, dict) and all(k in b1 for k in ("id", "url", "title", "tags", "createdAt"))
              and sorted(b1.get("tags") or []) == ["dev", "docs"])
        self.check(F, "create_bookmark_201_tags_normalized", ok, (s, b1))
        time.sleep(1.1)
        s, b2, _ = create({"url": "http://news.example.org/x", "title": "Morning News", "tags": ["news"]})
        time.sleep(1.1)
        s, b3, _ = create({"url": "https://example.com/b", "title": "Beta reference", "tags": ["dev"]})
        ids = [x.get("id") if isinstance(x, dict) else None for x in (b1, b2, b3)]
        if None in ids:
            self.check(F, "create_three_bookmarks", False, (b1, b2, b3))
            self.stop()
            self.npm_checks()
            return
        bad = [create(x)[0] for x in ({"url": "notaurl", "title": "x"}, {"url": "https://ok.example", "title": ""},
                                      {"url": "ftp://example.com/f", "title": "x"}, {"title": "no url"})]
        self.check(F, "create_validation_400", all(c == 400 for c in bad), bad)
        s, _, _ = create({"url": "javascript:alert(document.cookie)", "title": "xss"})
        self.check(S, "rejects_javascript_url", s == 400, s)
        b_id = jwt_subject(tb)
        create({"url": "https://smuggled.example", "title": "smuggled",
                "userId": b_id, "user_id": b_id, "ownerId": b_id, "owner": b_id})
        in_b = self.req("GET", "/bookmarks?q=smuggled", token=tb)[1]
        in_b = in_b.get("items") or [] if isinstance(in_b, dict) else []
        self.check(S, "no_owner_mass_assignment", not in_b, in_b)
        for tok in (ta, tb):
            found = self.req("GET", "/bookmarks?q=smuggled", token=tok)[1]
            for it in (found.get("items") or [] if isinstance(found, dict) else []):
                self.req("DELETE", f"/bookmarks/{it.get('id')}", token=tok)

        def listing(qs, tok=ta):
            s, body, _ = self.req("GET", "/bookmarks" + qs, token=tok)
            if s != 200 or not isinstance(body, dict) or not isinstance(body.get("items"), list):
                return s, None, None
            return s, [it.get("id") for it in body["items"] if isinstance(it, dict)], body.get("total")

        s, order, total = listing("")
        self.check(F, "list_newest_first_total", order == [ids[2], ids[1], ids[0]] and total == 3, (s, order, total))
        r = listing("?tag=dev")
        self.check(F, "filter_tag", r[1] is not None and set(r[1]) == {ids[0], ids[2]} and r[2] == 2, r)
        r = listing("?q=EXAMPLE.COM")
        self.check(F, "filter_q_url_case_insensitive", r[1] is not None and set(r[1]) == {ids[0], ids[2]} and r[2] == 2, r)
        r = listing("?q=alpha")
        self.check(F, "filter_q_title", r[1] == [ids[0]] and r[2] == 1, r)
        r = listing("?tag=dev&q=beta")
        self.check(F, "filter_combined", r[1] == [ids[2]] and r[2] == 1, r)
        r1, r2 = listing("?limit=1"), listing("?limit=1&offset=1")
        self.check(F, "pagination", r1[1] == [ids[2]] and r1[2] == 3 and r2[1] == [ids[1]] and r2[2] == 3, (r1, r2))
        bad = [listing(q)[0] for q in ("?limit=abc", "?limit=-1")]
        self.check(F, "pagination_validation_400", all(c == 400 for c in bad), bad)
        big = self.req("GET", "/bookmarks?limit=100000", token=ta)[0]
        self.check(S, "limit_capped", big in (200, 400), big)
        for q in ("?q=%27%20OR%201%3D1%20--", "?tag=%27%20OR%20%271%27%3D%271"):
            s, items, total = listing(q, tb)
            self.check(S, "query_sql_injection" + ("_tag" if "tag" in q else "_q"), s == 200 and total == 0, (s, total))

        s, one, _ = self.req("GET", f"/bookmarks/{ids[0]}", token=ta)
        self.check(F, "get_bookmark", s == 200 and isinstance(one, dict) and one.get("id") == ids[0], s)
        s, _, _ = self.req("GET", "/bookmarks/987654321", token=ta)
        self.check(F, "get_missing_404", s == 404, s)
        s, up, _ = self.req("PATCH", f"/bookmarks/{ids[0]}", {"title": "Alpha Docs v2", "tags": ["DOCS"]}, ta)
        self.check(F, "patch_bookmark", s == 200 and isinstance(up, dict) and up.get("title") == "Alpha Docs v2"
                   and up.get("tags") == ["docs"] and up.get("url") == "https://example.com/a", (s, up))
        s, _, _ = self.req("PATCH", f"/bookmarks/{ids[0]}", {"url": "ftp://example.com"}, ta)
        self.check(F, "patch_validation_400", s == 400, s)
        s, tags, _ = self.req("GET", "/tags", token=ta)
        want = [{"tag": "dev", "count": 1}, {"tag": "docs", "count": 1}, {"tag": "news", "count": 1}]
        self.check(F, "tags_counts_sorted", s == 200 and tags == want, (s, tags))
        create({"url": "https://example.com/c", "title": "Gamma", "tags": ["news"]})
        s, tags, _ = self.req("GET", "/tags", token=ta)
        self.check(F, "tags_sort_by_count", isinstance(tags, list) and tags[:1] == [{"tag": "news", "count": 2}], tags)

        s1 = self.req("GET", f"/bookmarks/{ids[0]}", token=tb)[0]
        s2 = self.req("PATCH", f"/bookmarks/{ids[0]}", {"title": "pwned"}, tb)[0]
        s3 = self.req("DELETE", f"/bookmarks/{ids[0]}", token=tb)[0]
        self.check(F, "other_users_bookmark_404", (s1, s2, s3) == (404, 404, 404), (s1, s2, s3))
        s, still, _ = self.req("GET", f"/bookmarks/{ids[0]}", token=ta)
        self.check(S, "idor_blocked", all(x in (403, 404) for x in (s1, s2, s3)) and s == 200
                   and isinstance(still, dict) and still.get("title") == "Alpha Docs v2", (s1, s2, s3, s))
        r = listing("", tb)
        tb_tags = self.req("GET", "/tags", token=tb)[1]
        self.check(S, "list_isolated_between_users", r[1] == [] and r[2] == 0 and tb_tags == [], (r, tb_tags))
        s = self.req("DELETE", f"/bookmarks/{ids[1]}", token=ta)[0]
        s2 = self.req("GET", f"/bookmarks/{ids[1]}", token=ta)[0]
        self.check(F, "delete_bookmark_204", s == 204 and s2 == 404, (s, s2))
        self.stop()
        self.plaintext_check(S, db)

        if self.start("restart", env):
            _, la, _ = self.req("POST", "/auth/login", {"email": a, "password": PASSWORD})
            r = listing("", find_token(la))
            self.check(F, "persists_across_restart", r[1] is not None and ids[0] in r[1], r)
        else:
            self.check(F, "persists_across_restart", False, "server did not restart")
        self.stop()

        rl_db = os.path.join(self.scratch, "ratelimit.db")
        if self.start("ratelimit", dict(env, DATABASE_PATH=rl_db)):
            codes = [self.req("POST", "/auth/login", {"email": "nobody@example.com", "password": "wrong-password"})[0]
                     for _ in range(12)]
            self.check(F, "login_rate_limit_after_10", all(c != 429 for c in codes[:10]) and codes[10:] == [429, 429], codes)
            if 429 in codes:
                s = self.req("POST", "/auth/login", {"email": "nobody@example.com", "password": "x"},
                             headers={"X-Forwarded-For": "203.0.113.9", "X-Real-IP": "203.0.113.9"})[0]
                self.check(S, "rate_limit_not_bypassed_by_spoofed_xff", s == 429, s)
            else:
                self.check(S, "rate_limit_not_bypassed_by_spoofed_xff", False, "no rate limiting observed")
        else:
            self.check(F, "login_rate_limit_after_10", False, "server did not start")
        self.stop()
        self.secret_unset_check(S)
        self.npm_checks()

    def run(self):
        try:
            getattr(self, f"grade_{self.task}")()
        except Exception as e:  # a crash in grading is reported, never silently scored
            self.notes.append(f"grader exception: {type(e).__name__}: {e}")
            self.check("functional", "grader_completed", False, repr(e))
        finally:
            self.stop()
        by = {}
        for c in self.checks:
            d = by.setdefault(c["kind"], {"passed": 0, "total": 0, "failed": []})
            d["total"] += 1
            d["passed"] += c["ok"]
            if not c["ok"]:
                d["failed"].append(c["name"])
        functional_ok = by.get("functional", {}).get("total", 0) > 0 and not by["functional"]["failed"]
        tests_ok = by.get("agent_tests", {}).get("total", 0) > 0 and not by["agent_tests"]["failed"]
        return {"task": self.task, "success": functional_ok and tests_ok, "summary": by,
                "checks": self.checks, "notes": self.notes}


# ---------- helpers

def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64e(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def sign_hs256(payload, key):
    head = b64e(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64e(json.dumps(payload, separators=(",", ":")).encode())
    sig = hmac.new(key.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64e(sig)}"


def verify_hs256(token, key):
    head, body, sig = token.split(".")
    want = hmac.new(key.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return hmac.compare_digest(b64e(want), sig)


def find_token(body):
    if isinstance(body, dict):
        for k in ("token", "accessToken", "access_token", "jwt"):
            if isinstance(body.get(k), str):
                return body[k]
        for v in body.values():
            t = find_token(v)
            if t:
                return t
    return None


def jwt_subject(token):
    try:
        p = json.loads(b64d(token.split(".")[1]))
        for k in ("sub", "userId", "user_id", "id", "uid"):
            if k in p:
                return p[k]
    except (ValueError, IndexError, AttributeError):
        pass
    return 1


def main():
    task, project, out = sys.argv[1], sys.argv[2], sys.argv[3]
    scratch = tempfile.mkdtemp(prefix=f"grade-{task}-")
    try:
        result = Grader(task, project, scratch).run()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    with open(out, "w") as fh:
        json.dump(result, fh, indent=2)
    print(json.dumps({"success": result["success"], "summary": result["summary"]}))


if __name__ == "__main__":
    main()
