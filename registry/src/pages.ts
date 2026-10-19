// Server-rendered website. No client framework: a little CSS, two tiny scripts (tabs, copy).
import { Marked } from "marked";
import type { Finding } from "../../shared/checks.ts";
import type { buildInfo, search } from "./api.ts";

type Info = Awaited<ReturnType<typeof buildInfo>>;
type Results = Awaited<ReturnType<typeof search>>;
type Result = Results["results"][number];

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const safeUrl = (u: string) => /^(https?:\/\/|#|\/(?!\/))/i.test(u);

const md = new Marked({
  gfm: true,
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens);
      return safeUrl(href) ? `<a href="${esc(href)}" rel="nofollow ugc noopener">${inner}</a>` : inner;
    },
    image({ href, text }) { return /^https:\/\//.test(href) ? `<img src="${esc(href)}" alt="${esc(text)}" loading="lazy">` : esc(text); },
  },
});
const markdown = (s: string | null | undefined) => (s ? (md.parse(s) as string) : "");

const CSS = `
:root{--paper:#eef1ed;--sheet:#fbfcfa;--ink:#163328;--ink-2:#4d6158;--rule:#cfd8d2;--green:#1d6a48;--label:#f3c443;--label-ink:#2b2205;--warn:#8a5300;--bad:#a8261b;--code:#e3e9e4;
--sans:"Archivo",system-ui,sans-serif;--mono:"Red Hat Mono",ui-monospace,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0e1a16;--sheet:#13221d;--ink:#e1ebe5;--ink-2:#98ada3;--rule:#28403a;--green:#72d0a1;--label:#e8bb33;--label-ink:#1d1603;--warn:#e7a54a;--bad:#ff8a7a;--code:#1b2e27;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#0e1a16;--sheet:#13221d;--ink:#e1ebe5;--ink-2:#98ada3;--rule:#28403a;--green:#72d0a1;--label:#e8bb33;--label-ink:#1d1603;--warn:#e7a54a;--bad:#ff8a7a;--code:#1b2e27;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 16px/1.55 var(--sans);font-variation-settings:"wdth" 100}
a{color:var(--green);text-underline-offset:.18em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--label);outline-offset:2px}
code,pre,kbd{font-family:var(--mono);font-size:.9em}
.wrap{max-width:1160px;margin:0 auto;padding:0 24px}
header.top{border-bottom:1px solid var(--rule);background:var(--sheet)}
header.top .wrap{display:flex;align-items:center;gap:24px;min-height:60px;flex-wrap:wrap;padding-block:10px}
.brand{font-weight:800;font-size:1.35rem;font-variation-settings:"wdth" 125;color:var(--ink);text-decoration:none;letter-spacing:-.01em}
.brand span{display:inline-block;background:var(--label);color:var(--label-ink);padding:0 .3em;margin-right:.08em}
form.find{flex:1;min-width:220px;display:flex}
form.find input{flex:1;font:inherit;padding:8px 12px;border:1px solid var(--rule);border-right:0;background:var(--paper);color:var(--ink);min-width:0}
form.find button,.btn{font:600 .95rem var(--sans);padding:8px 14px;border:1px solid var(--green);background:var(--green);color:var(--sheet);cursor:pointer}
nav.links{display:flex;gap:18px;font-size:.95rem}
nav.links a{color:var(--ink);text-decoration:none}
nav.links a:hover{text-decoration:underline}
main{padding:40px 0 64px}
h1,h2,h3{line-height:1.1;margin:0 0 .5em;font-weight:760}
h1{font-size:clamp(2.1rem,4.6vw,3.5rem);font-variation-settings:"wdth" 112;letter-spacing:-.015em;max-width:15ch}
h2{font-size:1.5rem;font-variation-settings:"wdth" 110;margin-top:2.2em}
h3{font-size:1.05rem}
p{margin:0 0 1em;max-width:68ch}
.lead{font-size:1.15rem;color:var(--ink-2);max-width:56ch}
.hero{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:48px;align-items:start}
.cmd{position:relative;background:var(--code);border:1px solid var(--rule);padding:14px 52px 14px 16px;overflow-x:auto;white-space:pre;font-family:var(--mono);font-size:.9rem;line-height:1.6}
.cmd .c{color:var(--ink-2)}
.copy{position:absolute;top:8px;right:8px;font:500 .8rem var(--sans);background:var(--sheet);color:var(--ink);border:1px solid var(--rule);padding:3px 8px;cursor:pointer}
.tabs{display:flex;flex-wrap:wrap;margin-top:28px}
.tabs button{font:600 .9rem var(--sans);background:none;border:1px solid transparent;border-bottom:0;color:var(--ink-2);padding:7px 12px;cursor:pointer}
.tabs button[aria-selected="true"]{background:var(--code);border-color:var(--rule);color:var(--ink)}
.tabpanel[hidden]{display:none}
.tabpanel p{font-size:.9rem;color:var(--ink-2);margin:8px 0 0}
.tree{background:var(--sheet);border:1px solid var(--rule);font-family:var(--mono);font-size:.84rem}
.tree .head{padding:12px 16px;border-bottom:1px solid var(--rule);font-family:var(--sans);font-size:.92rem}
.tree .head b{font-weight:650}
.tree ol{list-style:none;margin:0;padding:8px 0}
.tree li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:3px 16px}
.tree li .src{color:var(--ink-2);font-family:var(--sans);font-size:.82rem}
.tree li.mine{background:var(--label);color:var(--label-ink)}
.tree li.mine .src{color:var(--label-ink);font-weight:650}
.tree li.edit .src::after{content:" + wiring";color:var(--ink)}
.tree .foot{padding:10px 16px;border-top:1px solid var(--rule);font-family:var(--sans);font-size:.9rem}
table.cat{width:100%;border-collapse:collapse;background:var(--sheet);border:1px solid var(--rule);font-size:.93rem}
table.cat th{text-align:left;font-weight:650;font-size:.82rem;color:var(--ink-2);padding:10px 12px;border-bottom:2px solid var(--ink)}
table.cat td{padding:12px;border-bottom:1px solid var(--rule);vertical-align:top}
table.cat td.id a{font-weight:650;color:var(--ink);text-decoration:none;font-variation-settings:"wdth" 108}
table.cat td.id a:hover{text-decoration:underline}
table.cat td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.kind{display:inline-block;font-size:.75rem;font-weight:600;padding:0 6px;border:1px solid var(--ink-2);color:var(--ink-2);margin-left:6px;vertical-align:1px}
.kind.foundation{border-color:var(--green);color:var(--green)}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-family:var(--mono);font-size:.76rem;background:var(--code);padding:1px 6px;white-space:nowrap}
.risk-ok{color:var(--ok,var(--green))}.risk-warn{color:var(--warn)}.risk-error{color:var(--bad)}
.compat-ok{color:var(--green)}.compat-no{color:var(--warn)}
.muted{color:var(--ink-2)}
.steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:2px solid var(--ink)}
.steps li{padding:16px 20px 8px 0;counter-increment:s}
.steps li::before{content:counter(s);display:block;font-weight:800;font-size:2rem;font-variation-settings:"wdth" 125;line-height:1;margin-bottom:10px;color:var(--green)}
.steps h3{margin-bottom:.35em}
.steps p{font-size:.95rem;color:var(--ink-2)}
.split{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:48px;align-items:start}
.side section{border-top:1px solid var(--rule);padding:14px 0}
.side h3{font-size:.95rem;margin-bottom:.6em}
.side ul{list-style:none;margin:0;padding:0}
.side li{padding:2px 0;font-size:.92rem;overflow-wrap:anywhere}
.finding{display:grid;grid-template-columns:16px 1fr;gap:6px;font-size:.88rem;padding:4px 0}
.finding .dot{width:9px;height:9px;margin-top:7px;background:var(--ink-2)}
.finding.warn .dot{background:var(--warn)}.finding.error .dot{background:var(--bad)}
.meter{height:8px;background:var(--code);margin:6px 0}
.meter i{display:block;height:100%;background:var(--green)}
.doc{background:var(--sheet);border:1px solid var(--rule);padding:24px 28px;overflow-wrap:anywhere}
.doc pre{background:var(--code);padding:12px 14px;overflow-x:auto}
.doc :not(pre)>code{background:var(--code);padding:1px 4px}
.doc img{max-width:100%}
.doc table{border-collapse:collapse}.doc td,.doc th{border:1px solid var(--rule);padding:4px 8px}
.doc h1{font-size:1.7rem;max-width:none}.doc h2{font-size:1.25rem;margin-top:1.4em}
.title-id{font-weight:500;color:var(--ink-2)}
.filters{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:20px}
.filters label{display:grid;gap:4px;font-size:.85rem;color:var(--ink-2)}
.filters input,.filters select{font:inherit;padding:7px 10px;border:1px solid var(--rule);background:var(--sheet);color:var(--ink)}
.empty{background:var(--sheet);border:1px dashed var(--rule);padding:28px}
footer{border-top:1px solid var(--rule);padding:28px 0 48px;color:var(--ink-2);font-size:.9rem}
footer .wrap{display:flex;gap:24px;flex-wrap:wrap;justify-content:space-between}
@media (max-width:900px){.hero,.split{grid-template-columns:1fr;gap:32px}.steps{grid-template-columns:1fr 1fr}}
@media (max-width:640px){
 .wrap{padding:0 16px}main{padding-top:28px}.steps{grid-template-columns:1fr}
 table.cat thead{display:none}table.cat,table.cat tbody,table.cat tr,table.cat td{display:block;width:100%}
 table.cat tr{border-bottom:1px solid var(--rule);padding:10px 0}table.cat td{border:0;padding:3px 12px}table.cat td.num{text-align:left}
 table.cat td[data-l]::before{content:attr(data-l) ": ";color:var(--ink-2)}
 .tree li{grid-template-columns:1fr;gap:0;padding-block:4px}.tree li .src{padding-left:12px;font-size:.78rem}
}
@media (prefers-reduced-motion:no-preference){.tree li{animation:in .35s both;animation-delay:calc(var(--i)*55ms)}@keyframes in{from{opacity:0;transform:translateX(-6px)}}}
`;

const SCRIPT = `
document.querySelectorAll('[role=tablist]').forEach(list=>{const tabs=[...list.querySelectorAll('[role=tab]')];
tabs.forEach(t=>t.addEventListener('click',()=>{tabs.forEach(x=>{x.setAttribute('aria-selected',x===t);document.getElementById(x.getAttribute('aria-controls')).hidden=x!==t})}))});
document.querySelectorAll('.copy').forEach(b=>b.addEventListener('click',async()=>{const t=b.parentElement.querySelector('code').innerText.replace(/^#.*$/gm,'').trim();try{await navigator.clipboard.writeText(t);b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1500)}catch{b.textContent='Select and copy'}}));
`;

function layout(origin: string, title: string, body: string, opts: { description?: string; q?: string } = {}) {
  const description = opts.description ?? "An open, agent-first registry of reusable software builds. Coding agents find, install and assemble existing modules and project foundations, then write only what's missing.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<link rel="alternate" type="text/plain" href="${origin}/llms.txt" title="llms.txt">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#f3c443"/><text x="16" y="23" font-family="Arial" font-weight="900" font-size="17" text-anchor="middle" fill="#163328">p</text></svg>')}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Red+Hat+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="brand" href="/" aria-label="pkg home"><span>p</span>kg</a>
<form class="find" action="/search" role="search"><input name="q" value="${esc(opts.q ?? "")}" placeholder="Search builds: auth, rest api, fastapi, rate limit…" aria-label="Search builds"><button>Search</button></form>
<nav class="links"><a href="/search">Catalog</a><a href="/docs">Docs</a><a href="/llms.txt">llms.txt</a><a href="https://github.com/tneemo/pkg">Source</a></nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap"><span>pkg is free and open source under the MIT license. Installing never needs an account.</span><span><a href="/docs">Publish a build</a> · <a href="/llms.txt">Agent guide</a> · <a href="/api/search?q=">JSON API</a></span></div></footer>
<script>${SCRIPT}</script></body></html>`;
}

const cmd = (code: string) => `<div class="cmd"><code>${code}</code><button class="copy" type="button">Copy</button></div>`;

function tags(list: string[]) {
  return list.length ? `<span class="tags">${list.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>` : `<span class="muted">any</span>`;
}

function requiresList(r: Record<string, string>) {
  return Object.entries(r).map(([t, v]) => (v === "*" ? t : `${t} ${v}`));
}

function catalogTable(results: Result[], showCompat: boolean) {
  if (!results.length) return "";
  const rows = results.map((r) => {
    const reports = r.agent_reports.success + r.agent_reports.failure;
    const compat = r.compat
      ? `<td data-l="Fit">${r.compat.ok ? `<span class="compat-ok">Fits your stack</span>` : `<span class="compat-no">${esc(r.compat.note)}</span>${r.compat.via ? `<br><span class="muted">via ${Object.values(r.compat.via).flat().map((id) => `<a href="/${esc(id)}">${esc(id)}</a>`).join(", ")}</span>` : ""}`}</td>`
      : "";
    return `<tr><td class="id"><a href="/${esc(r.id)}">${esc(r.id)}</a><span class="kind ${esc(r.kind)}">${esc(r.kind)}</span></td>
<td>${esc(r.description)}</td>
<td data-l="Needs">${tags(requiresList(r.requires))}</td>
${showCompat ? compat : ""}
<td data-l="Checks" class="risk-${esc(r.risk)}">${r.risk === "ok" ? "Passed" : "Warnings"}</td>
<td data-l="Agents" class="num">${reports ? `${Math.round((r.agent_reports.success / reports) * 100)}% of ${reports}` : `<span class="muted">none yet</span>`}</td>
<td data-l="Installs" class="num">${r.downloads.toLocaleString("en-US")}</td></tr>`;
  });
  return `<table class="cat"><thead><tr><th>Build</th><th>What it does</th><th>Needs</th>${showCompat ? "<th>Fit</th>" : ""}<th>Checks</th><th>Worked for agents</th><th>Installs</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function connectTabs() {
  const tabs: [string, string, string][] = [
    ["Claude Code", "claude mcp add pkg -- npx -y @tneemo/pkg mcp", "Then ask for what you want to build. Claude finds and assembles matching builds on its own."],
    ["Cursor & others", `# add to .cursor/mcp.json (or your client's MCP config)\n{ "mcpServers": { "pkg": { "command": "npx", "args": ["-y", "@tneemo/pkg", "mcp"] } } }`, "Works with any MCP client: Cursor, Windsurf, VS Code, Codex, Zed."],
    ["Any agent", "npx -y @tneemo/pkg search \"auth\" --stack typescript,hono --json", "Every command has --json output. Agents that can fetch URLs can start from /llms.txt."],
  ];
  return `<div class="tabs" role="tablist" aria-label="Connect your agent">${tabs.map(([name], i) => `<button role="tab" id="t${i}" aria-controls="p${i}" aria-selected="${i === 0}">${esc(name)}</button>`).join("")}</div>
${tabs.map(([, code, note], i) => `<div class="tabpanel" role="tabpanel" id="p${i}" aria-labelledby="t${i}"${i ? " hidden" : ""}>${cmd(esc(code))}<p>${esc(note)}</p></div>`).join("")}`;
}

// A real run: "todo API with user accounts" assembled from four builds (see README).
const ASSEMBLED: [string, string, string?][] = [
  ["package.json", "tneemo/hono-api"],
  ["src/index.ts", "tneemo/hono-api"],
  ["src/app.ts", "tneemo/hono-api", "edit"],
  ["src/env.ts", "tneemo/hono-api"],
  ["src/db/index.ts", "tneemo/sqlite-db"],
  ["src/db/migrate.ts", "tneemo/sqlite-db"],
  ["src/auth/routes.ts", "tneemo/hono-auth"],
  ["src/auth/middleware.ts", "tneemo/hono-auth"],
  ["src/auth/password.ts", "tneemo/hono-auth"],
  ["src/auth/token.ts", "tneemo/hono-auth"],
  ["db/migrations/…_auth_users.sql", "tneemo/hono-auth"],
  ["src/middleware/rate-limit.ts", "tneemo/hono-rate-limit"],
  ["src/todos/routes.ts", "written by the agent", "mine"],
  ["db/migrations/…_todos.sql", "written by the agent", "mine"],
  ["test/todos.test.ts", "written by the agent", "mine"],
];

export function homePage(origin: string, catalog: Results) {
  const tree = ASSEMBLED.map(([path, src, cls], i) => `<li class="${cls ?? ""}" style="--i:${i}"><span>${esc(path)}</span><span class="src">${esc(src)}</span></li>`).join("");
  const mine = ASSEMBLED.filter(([, , c]) => c === "mine").length;
  return layout(origin, "pkg: reusable builds for coding agents", `
<section class="hero">
  <div>
    <h1>Agents shouldn't rebuild software that already exists.</h1>
    <p class="lead">pkg is an open catalog of reusable builds, from small modules to complete project foundations. Your coding agent finds the ones that fit your stack, installs them, and writes only what's missing.</p>
    ${connectTabs()}
  </div>
  <figure class="tree" style="margin:0" aria-label="Example of an assembled project">
    <div class="head"><b>“Build a todo API with user accounts in TypeScript.”</b><br><span class="muted">What the agent assembled with pkg:</span></div>
    <ol>${tree}</ol>
    <figcaption class="foot">The agent wrote ${mine} of 26 files, plus 6 lines of wiring. The other 23 files came from four community builds, tests included.</figcaption>
  </figure>
</section>

<h2>How it works</h2>
<ol class="steps">
  <li><h3>You describe the idea</h3><p>In your normal conversation with the agent: what you're building and, if you care, the stack. No spec files to prepare.</p></li>
  <li><h3>The agent searches pkg</h3><p>It looks for each part it needs and gets builds ranked by fit with your stack, automated checks and how they worked for other agents.</p></li>
  <li><h3>pkg assembles the project</h3><p>Files, dependencies, scripts and env vars are installed in dependency order. Code inside a build never runs during install.</p></li>
  <li><h3>The agent builds the rest</h3><p>It follows each build's integration notes, writes what's missing, then reports whether the builds worked. That report is the reputation.</p></li>
</ol>

<h2>Catalog</h2>
${catalog.results.length ? catalogTable(catalog.results, false) : `<div class="empty">Nothing published yet. <a href="/docs">Publish the first build</a>.</div>`}

<h2>Publish a build</h2>
<p>Anything you've built that someone else will need again: a module, an integration, a whole project foundation. Your GitHub login is your namespace, so there is no account to create.</p>
${cmd(`<span class="c"># in the folder with your code</span>\nnpx -y @tneemo/pkg init      <span class="c"># writes pkg.json, stack detected for you</span>\nnpx -y @tneemo/pkg publish   <span class="c"># checks run, then it's live as &lt;you&gt;/&lt;name&gt;</span>`)}
<p class="muted" style="margin-top:12px">Every publish is checked for secrets, install scripts, obfuscated code, prompt injection aimed at agents and dependencies that don't exist. <a href="/docs">Read the publishing guide</a>.</p>
`);
}

export function searchPage(origin: string, params: { q: string; stack: string; kind: string }, res: Results) {
  const showCompat = Object.keys(res.stack).length > 0;
  return layout(origin, params.q ? `${params.q}: pkg search` : "Catalog: pkg", `
<h1 style="font-size:2rem;max-width:none">${params.q ? `Builds for “${esc(params.q)}”` : "Catalog"}</h1>
<form class="filters" action="/search">
  <label>Search<input name="q" value="${esc(params.q)}" placeholder="auth, database, rest api"></label>
  <label>Your stack<input name="stack" value="${esc(params.stack)}" placeholder="typescript, hono"></label>
  <label>Kind<select name="kind"><option value="">Everything</option><option value="foundation"${params.kind === "foundation" ? " selected" : ""}>Foundations</option><option value="module"${params.kind === "module" ? " selected" : ""}>Modules</option></select></label>
  <button class="btn">Update results</button>
</form>
${res.results.length ? catalogTable(res.results, showCompat) : `<div class="empty"><p><b>No builds match${params.q ? ` “${esc(params.q)}”` : ""}.</b></p><p>Try a broader word, or remove the stack filter. If it doesn't exist yet, build it once and <a href="/docs">publish it</a> so no agent has to write it again.</p></div>`}
`, { q: params.q });
}

function finding(f: Finding) {
  return `<div class="finding ${esc(f.level)}"><span class="dot" aria-label="${esc(f.level)}"></span><span>${esc(f.message)}${f.file ? ` <span class="muted">${esc(f.file)}${f.line ? `:${f.line}` : ""}</span>` : ""}</span></div>`;
}

export function buildPage(origin: string, info: Info, notes: Record<string, unknown>[]) {
  const m = info.manifest;
  const [owner, name] = info.id.split("/");
  const reports = info.agent_reports.success + info.agent_reports.failure;
  const findings = info.checks.findings.filter((f) => f.level !== "info");
  const deps = (eco: "npm" | "pip") => Object.entries({ ...(m.dependencies?.[eco] ?? {}), ...(m.devDependencies?.[eco] ?? {}) });
  const depList = [...deps("npm").map(([n, v]) => `${n} ${v}`), ...deps("pip").map(([n, v]) => `${n} ${v}`)];
  const install = info.kind === "foundation"
    ? `npx -y @tneemo/pkg add ${info.id} --dir my-app`
    : `npx -y @tneemo/pkg add ${info.id}`;
  return layout(origin, `${info.id}: pkg`, `
<p style="margin:0 0 6px"><span class="title-id">${esc(owner)} /</span> <span class="kind ${esc(info.kind)}" style="margin-left:0">${esc(info.kind)}</span> <span class="muted">v${esc(info.version)}${info.version !== info.latest ? ` (latest is <a href="/${esc(info.id)}">${esc(info.latest)}</a>)` : ""}</span></p>
<h1 style="max-width:none">${esc(name)}</h1>
<p class="lead">${esc(info.description)}</p>
<div class="split">
  <div>
    ${cmd(esc(install))}
    <p class="muted" style="margin-top:10px;font-size:.92rem">Agents connected to pkg find this build on their own. You can also run the command yourself in the project folder.</p>
    ${info.integration ? `<h2>After installing</h2><div class="doc">${markdown(info.integration)}</div>` : ""}
    <h2>Readme</h2>
    <div class="doc">${info.readme ? markdown(info.readme) : `<p class="muted">This build has no README.</p>`}</div>
  </div>
  <aside class="side">
    <section><h3>Needs</h3>${tags(requiresList(info.requires))}</section>
    <section><h3>Adds to your stack</h3>${tags(info.provides)}</section>
    ${depList.length ? `<section><h3>Installs packages</h3>${tags(depList)}</section>` : ""}
    ${Object.keys(m.builds ?? {}).length ? `<section><h3>Uses builds</h3><ul>${Object.entries(m.builds!).map(([id, r]) => `<li><a href="/${esc(id)}">${esc(id)}</a> <span class="muted">${esc(r)}</span></li>`).join("")}</ul></section>` : ""}
    ${Object.keys(m.env ?? {}).length ? `<section><h3>Environment variables</h3><ul>${Object.entries(m.env!).map(([k, v]) => `<li><code>${esc(k)}</code>${v.required ? " (required)" : ""} <span class="muted">${esc(v.description ?? "")}</span></li>`).join("")}</ul></section>` : ""}
    <section><h3>Automated checks</h3>
      <p class="risk-${esc(info.checks.risk)}" style="margin:0 0 4px;font-weight:600">${info.checks.risk === "ok" ? "Passed with no warnings" : `${findings.length} warning${findings.length === 1 ? "" : "s"} to review`}</p>
      ${findings.map(finding).join("")}
      <p class="muted" style="font-size:.88rem;margin:6px 0 0">Quality ${info.checks.quality}/100</p>
    </section>
    <section><h3>Worked for agents</h3>
      ${reports ? `<div class="meter" role="img" aria-label="${info.agent_reports.success} of ${reports} worked"><i style="width:${Math.round((info.agent_reports.success / reports) * 100)}%"></i></div><p style="margin:0;font-size:.92rem">${info.agent_reports.success} worked, ${info.agent_reports.failure} didn't${info.flags ? `, ${info.flags} flagged` : ""}</p>` : `<p class="muted" style="margin:0;font-size:.92rem">No reports yet.</p>`}
      ${notes.length ? `<ul style="margin-top:8px">${notes.slice(0, 5).map((n) => `<li class="muted" style="font-size:.86rem">${esc(n.kind)}: ${esc(n.note)}</li>`).join("")}</ul>` : ""}
    </section>
    <section><h3>Installs</h3><p style="margin:0">${info.downloads.toLocaleString("en-US")}</p></section>
    <section><h3>Files</h3><ul>${info.files.map((f) => `<li><a href="/api/builds/${esc(info.id)}/files/${esc(f.path)}?version=${esc(info.version)}"><code>${esc(f.path)}</code></a></li>`).join("")}</ul></section>
    <section><h3>Versions</h3><ul>${info.versions.slice(0, 12).map((v) => `<li><a href="/${esc(info.id)}?v=${esc(v.version)}">${esc(v.version)}</a> <span class="muted">${esc(v.published_at.slice(0, 10))}</span></li>`).join("")}</ul></section>
    <section><h3>About</h3><ul><li>License: ${esc(m.license)}</li>${m.repository ? `<li><a href="${esc(m.repository)}" rel="nofollow ugc noopener">Source repository</a></li>` : ""}<li>Published by ${esc(info.publisher.replace(/^admin:/, ""))}</li><li><a href="/api/builds/${esc(info.id)}">JSON</a>${m.dependencies?.pip ? "" : ` · <a href="/r/${esc(info.id)}.json">shadcn item</a>`}</li></ul></section>
  </aside>
</div>`, { description: info.description });
}

const DOCS = (origin: string) => `
# Publishing a build

A build is a folder of source code plus a \`pkg.json\` manifest. When someone installs it, pkg copies the files into their project, merges dependencies and environment variables, and hands their coding agent your integration notes.

## Quick start

\`\`\`bash
cd my-module
npx -y @tneemo/pkg init      # creates pkg.json with the stack detected from your project
npx -y @tneemo/pkg publish   # runs the checks locally, then publishes as <your-github-login>/<name>
\`\`\`

Publishing uses your GitHub identity: the token from \`gh auth token\`, or \`GITHUB_TOKEN\` / \`GH_TOKEN\`. To publish under an organization, pass \`--owner <org>\`. In GitHub Actions, set \`GITHUB_TOKEN\` and run the same command.

## Files in a build

| File | Purpose |
| --- | --- |
| \`pkg.json\` | The manifest (required). |
| \`README.md\` | Shown on the build page: what it does and why. Not installed unless listed in \`files\`. |
| \`INTEGRATION.md\` | The exact steps an agent should take after installing: what to import, where to mount it, what to configure. Not installed. |
| everything else | Installed at the same relative path in the user's project. Narrow it with \`files\`. |

Ignored files (from \`.gitignore\` when the folder is a git repo), \`node_modules\`, \`.env\` files and lockfiles are never published.

## pkg.json

\`\`\`json
{
  "$schema": "${origin}/schema/pkg.json",
  "name": "hono-auth",
  "version": "1.0.0",
  "kind": "module",
  "description": "Email and password auth for Hono: register, login, JWT middleware.",
  "license": "MIT",
  "keywords": ["auth", "login", "jwt"],
  "stack": {
    "requires": { "hono": ">=4", "typescript": "*", "db": "*" },
    "provides": ["auth"]
  },
  "builds": { "tneemo/sqlite-db": "^1.0.0" },
  "dependencies": { "npm": { "zod": "^3.23.0" } },
  "env": { "JWT_SECRET": { "description": "Secret used to sign tokens", "example": "change-me", "required": true } },
  "scripts": { "test": "vitest run" }
}
\`\`\`

- **kind**: \`foundation\` starts a new project (it ships package.json or pyproject.toml); \`module\` adds to an existing one.
- **stack.requires**: tags the project must already have, with a semver range. Tags come from detection: languages and runtimes (\`node\`, \`typescript\`, \`python\`), frameworks (\`hono\`, \`nextjs\`, \`react\`, \`fastapi\`, ...), every dependency as \`npm:<name>\` or \`pip:<name>\`, and anything another build \`provides\`.
- **stack.provides**: tags your build adds, so modules that need them can be matched (\`db\`, \`auth\`, \`hono\`).
- **builds**: other pkg builds installed first.
- **dependencies** / **devDependencies**: \`npm\` and \`pip\` packages added to the project's manifest and installed with its package manager.
- **env**: appended to \`.env.example\` and shown to the agent.
- **scripts**: npm scripts added to package.json when the name is free.
- **files**: globs that limit which files are installed.
- **base**: the folder the files go into in the user's project (for example \`src/todos\`). \`pkg init\` sets it when you publish a subfolder of a project, and also turns imports of files that came from other installed builds into **builds** dependencies.

The full schema is at [${origin}/schema/pkg.json](${origin}/schema/pkg.json).

## Automated checks

Every publish is checked on the registry. **Errors** reject the publish: unsafe paths, secrets or private keys, \`.env\` files, invalid manifests, and dependencies that don't exist on npm or PyPI (to block dependency confusion). **Warnings** are shown to everyone who installs: npm install scripts, code that pipes downloads into a shell or evaluates decoded data, hard-coded IP addresses, minified code, text that tries to steer AI agents, and files that change agent or editor configuration (\`.claude/\`, \`.mcp.json\`, \`.vscode/tasks.json\`, CI workflows).

A quality score rewards a README, integration notes, declared stack, tests, keywords and a repository link.

## Reputation

There are no stars or accounts. After integrating a build, agents report whether it worked (\`pkg feedback owner/name --worked\` or \`--failed "reason"\`). Search ranks builds by relevance, fit with the project's stack, these reports, installs and quality. Anyone can flag a harmful build with \`pkg feedback owner/name --report "reason"\`.

## Versions

Versions are immutable. Bump \`version\` to publish a change. Installs pin the exact version and integrity hash in \`pkg.lock.json\`.
`;

export function docsPage(origin: string) {
  return layout(origin, "Publishing guide: pkg", `<div class="doc" style="max-width:860px">${markdown(DOCS(origin))}</div>`);
}

export function notFoundPage(origin: string, path: string, message?: string) {
  return layout(origin, "Not found: pkg", `<h1 style="font-size:2rem;max-width:none">${esc(message ?? `Nothing at ${path}`)}</h1><p>Search the catalog for what you need, or <a href="/docs">publish it</a> if it doesn't exist yet.</p>`);
}
