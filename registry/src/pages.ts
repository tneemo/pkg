// Server-rendered website, styled after iOS: large titles, grouped lists, a segmented control and
// App Store-like build pages. No client framework: CSS plus a tiny script (tabs, copy, filters).
import { Marked } from "marked";
import type { Finding } from "../../shared/checks.ts";
import type { buildInfo, search } from "./api.ts";

type Info = Awaited<ReturnType<typeof buildInfo>>;
type Results = Awaited<ReturnType<typeof search>>;
type Result = Results["results"][number];
type Tab = "home" | "catalog" | "publish";

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

// Line icons drawn on a 24px grid, in the spirit of SF Symbols.
const GLYPHS: Record<string, string> = {
  box: '<path d="M12 2.8 20.5 7.4v9.2L12 21.2 3.5 16.6V7.4z"/><path d="M3.5 7.4 12 12l8.5-4.6M12 12v9.2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5v-3a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="m10.9 12.6 8.6-8.6M16.2 7.3l2.6 2.6M13.6 9.9l2 2"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  gauge: '<path d="M4.7 18a8.5 8.5 0 1 1 14.6 0"/><path d="m12 14 4.2-4.2"/><circle cx="12" cy="14" r="1.7" fill="currentColor" stroke="none"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.6 4.5l-3.2 15"/>',
  sparkles: '<path fill="currentColor" stroke="none" d="M10.5 3c.7 4.4 2.9 6.6 7.3 7.3-4.4.7-6.6 2.9-7.3 7.3-.7-4.4-2.9-6.6-7.3-7.3C7.6 9.6 9.8 7.4 10.5 3zM18.2 14.4c.4 2.1 1.3 3 3.4 3.4-2.1.4-3 1.3-3.4 3.4-.4-2.1-1.3-3-3.4-3.4 2.1-.4 3-1.3 3.4-3.4z"/>',
  house: '<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M6 9.6V20h4.4v-5.6h3.2V20H18V9.6"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="1.7"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="1.7"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.7"/>',
  publish: '<path d="M12 14.5V3.5M7.6 7.8 12 3.5l4.4 4.3"/><path d="M8.5 10.5H7A2 2 0 0 0 5 12.5v6A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  warn: '<path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.4 12.9a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z"/><path d="M12 9.5v4M12 17h.01"/>',
  xmark: '<circle cx="12" cy="12" r="8.5"/><path d="m9 9 6 6M15 9l-6 6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h.01"/>',
  chevron: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
};
const svg = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name]}</svg>`;

// Every build gets an app icon: a glyph for what it does. Like Settings, a glyph has its own colour;
// foundations and builds without a glyph get one from their id.
const GLYPH_HUES: Record<string, string> = { gauge: "#ff9f0a", key: "#bf5af2", lock: "#2fb457", db: "#12a4b6" };
const HUES = ["#0a84ff", "#5e5ce6", "#ff375f", "#ff6a3d"];
function hueOf(id: string, glyph: string | null) {
  if (glyph && GLYPH_HUES[glyph]) return GLYPH_HUES[glyph];
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return HUES[(h >>> 0) % HUES.length];
}
function glyphOf(tags: string[], kind: string) {
  const has = (...t: string[]) => t.some((x) => tags.includes(x));
  if (has("rate-limit", "throttle")) return "gauge";
  if (has("api-key", "apikey")) return "key";
  if (has("auth", "jwt", "users", "login")) return "lock";
  if (has("db", "database", "sqlite", "postgres", "mysql")) return "db";
  if (kind === "foundation" || has("api", "rest-api", "http")) return "code";
  return null;
}
function buildIcon(b: { id: string; kind: string; provides?: string[]; keywords?: string[] }, size = "") {
  const glyph = glyphOf([...(b.provides ?? []), ...(b.keywords ?? [])], b.kind);
  const name = b.id.split("/")[1] ?? b.id;
  return `<span class="icon${size ? ` ${size}` : ""}" style="--c:${hueOf(b.id, glyph)}" aria-hidden="true">${glyph ? svg(glyph) : esc(name[0]?.toUpperCase())}</span>`;
}

const installCmd = (id: string, kind: string) => (kind === "foundation" ? `npx -y @tneemo/pkg add ${id} --dir my-app` : `npx -y @tneemo/pkg add ${id}`);
const getButton = (id: string, kind: string, cls = "") =>
  `<button class="get${cls}" type="button" data-copy="${esc(installCmd(id, kind))}" aria-label="Copy the install command for ${esc(id)}" title="Copy the install command">Get</button>`;
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const day = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const CSS = `
:root{--bg:#f2f2f7;--cell:#fff;--label:#000;--label-2:rgba(60,60,67,.64);--sep:rgba(60,60,67,.2);--fill:rgba(118,118,128,.12);--seg-on:#fff;
--tint:#0071e3;--link:#0066cc;--imsg:#0a7cff;--green:#248a3d;--orange:#c93400;--red:#d70015;--pink:#d30f45;--bar:rgba(249,249,251,.8);
--sans:-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#000;--cell:#1c1c1e;--label:#fff;--label-2:rgba(235,235,245,.62);--sep:rgba(84,84,88,.6);--fill:rgba(118,118,128,.24);--seg-on:#636366;
--tint:#0a84ff;--link:#4ca3ff;--imsg:#0a84ff;--green:#30d158;--orange:#ff9f0a;--red:#ff453a;--pink:#ff375f;--bar:rgba(22,22,24,.78);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#000;--cell:#1c1c1e;--label:#fff;--label-2:rgba(235,235,245,.62);--sep:rgba(84,84,88,.6);--fill:rgba(118,118,128,.24);--seg-on:#636366;
--tint:#0a84ff;--link:#4ca3ff;--imsg:#0a84ff;--green:#30d158;--orange:#ff9f0a;--red:#ff453a;--pink:#ff375f;--bar:rgba(22,22,24,.78);color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--label);font:400 17px/1.47 var(--sans);letter-spacing:-.011em;-webkit-font-smoothing:antialiased;font-optical-sizing:auto}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:.15em}
:focus-visible{outline:3px solid color-mix(in srgb,var(--tint) 60%,transparent);outline-offset:2px;border-radius:6px}
code,pre,kbd{font-family:var(--mono);font-size:.86em;letter-spacing:0}
svg{flex:none}
pre{scrollbar-width:thin}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.bar{position:sticky;top:0;z-index:10;background:var(--bar);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-bottom:1px solid var(--sep)}
.bar .wrap{display:flex;align-items:center;gap:24px;height:56px}
.brand{display:flex;align-items:center;gap:9px;color:var(--label);font-weight:700;font-size:1.25rem;letter-spacing:-.025em}
.brand:hover{text-decoration:none}
.find{flex:1;max-width:400px;position:relative;display:block}
.find svg,.field-wrap svg{position:absolute;left:9px;top:50%;translate:0 -50%;width:17px;height:17px;color:var(--label-2);pointer-events:none}
.field{width:100%;font:inherit;font-size:1rem;letter-spacing:inherit;padding:7px 12px;border:0;border-radius:10px;background:var(--fill);color:var(--label);appearance:none;-webkit-appearance:none}
.find .field,.field-wrap .field{padding-left:33px}
.field::placeholder{color:var(--label-2)}
.links{margin-left:auto;display:flex;gap:22px;font-size:.9375rem}
.links a[aria-current]{color:var(--label);font-weight:600}
.tabbar{display:none}
main{padding:44px 0 72px}
h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.022em;line-height:1.12}
.large{font-size:clamp(2.125rem,1.3rem + 3.3vw,3.5rem);line-height:1.04;letter-spacing:-.032em;max-width:14ch;margin-bottom:18px}
.title{font-size:clamp(2.125rem,1.8rem + 1vw,2.5rem);letter-spacing:-.028em;margin-bottom:8px}
h2{font-size:1.375rem;letter-spacing:-.02em}
h3{font-size:1.0625rem;font-weight:600;letter-spacing:-.016em}
p{margin:0 0 1em;max-width:68ch}
.lead{font-size:1.1875rem;line-height:1.42;color:var(--label-2);max-width:50ch}
.muted{color:var(--label-2)}
.fn{font-size:.8125rem;line-height:1.38;color:var(--label-2);margin:0}
.sec{margin-top:72px}
.sec>h2,.sec-head{margin-bottom:16px}
.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.sec-head h2{margin:0}
.ok{color:var(--green)}.warn{color:var(--orange)}.error{color:var(--red)}
.icon{--s:60px;flex:none;width:var(--s);height:var(--s);border-radius:calc(var(--s)*.225);display:grid;place-items:center;color:#fff;
background:linear-gradient(180deg,color-mix(in oklab,var(--c),#fff 20%),var(--c));box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12);font:700 calc(var(--s)*.46)/1 var(--sans)}
.icon svg{width:56%;height:56%}
.icon.sm{--s:29px;border-radius:7px}.icon.sm svg{width:62%;height:62%;stroke-width:2.3}
.icon.xs{--s:30px;border-radius:7px}.icon.xs svg{stroke-width:2.2}
.icon.lg{--s:120px}.icon.lg svg{stroke-width:1.7}
.icon.agent{background:linear-gradient(140deg,#ff4f76,#b04cf0)}
.seg{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:2px;border-radius:9px;background:var(--fill);max-width:100%}
.seg>*{position:relative;font:500 .875rem/1.2 var(--sans);letter-spacing:-.01em;color:var(--label);background:none;border:0;border-radius:7px;padding:6px 16px;cursor:pointer;white-space:nowrap;text-align:center;transition:background-color .2s,box-shadow .2s}
.seg [aria-selected="true"],.seg label:has(:checked){background:var(--seg-on);box-shadow:0 3px 8px rgba(0,0,0,.12),0 3px 1px rgba(0,0,0,.04);font-weight:600}
.seg label:has(:focus-visible){outline:3px solid color-mix(in srgb,var(--tint) 60%,transparent)}
.seg input{position:absolute;opacity:0;pointer-events:none}
.hero .seg{margin:30px 0 12px}
.tabpanel[hidden]{display:none}
.tabpanel .fn{margin:9px 16px 0}
.cmd{position:relative;background:var(--cell);border-radius:12px}
.cmd pre{margin:0;padding:14px 84px 14px 16px;white-space:pre-wrap;overflow-wrap:break-word;font-size:.875rem;line-height:1.65}
.cmd code{font-size:inherit}
.cmd .c{color:var(--label-2)}
.pill{font:600 .8125rem/1 var(--sans);letter-spacing:-.005em;border:0;border-radius:999px;background:var(--fill);color:var(--tint);padding:7px 13px;cursor:pointer}
.copy{position:absolute;top:9px;right:9px}
.get{flex:none;font:700 .9375rem/1 var(--sans);letter-spacing:-.01em;min-width:76px;padding:7px 16px;border:0;border-radius:999px;background:var(--fill);color:var(--tint);cursor:pointer;position:relative;z-index:1}
.get.filled{background:var(--tint);color:#fff;padding:9px 26px;font-size:1rem}
.get[data-done]{color:var(--green)}.get.filled[data-done]{background:var(--green);color:#fff}
.btn{font:600 1rem/1 var(--sans);border:0;border-radius:999px;background:var(--tint);color:#fff;padding:10px 20px;cursor:pointer}
.list{background:var(--cell);border-radius:12px;overflow:hidden;margin:0;padding:0;list-style:none}
.row{position:relative;display:flex;align-items:center;gap:12px;min-height:44px;padding:10px 16px}
.row+.row::before{content:"";position:absolute;top:0;right:0;left:var(--inset,16px);border-top:1px solid var(--sep)}
.row .v{margin-left:auto;color:var(--label-2);text-align:right;overflow-wrap:anywhere}
.row.col{flex-direction:column;align-items:stretch;gap:6px}
.row .stretch{color:var(--label)}
.row .stretch::after{content:"";position:absolute;inset:0}
.row .stretch:hover{text-decoration:none}
.row:has(.stretch:hover){background:var(--fill)}
.row .chev{width:15px;height:15px;color:var(--label-2);opacity:.6}
.row .tick{width:18px;height:18px;color:var(--tint)}
.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,450px);gap:56px;align-items:start}
.convo{margin:6px 0 0;overflow-x:clip}
.bubble{position:relative;width:fit-content;max-width:84%;margin:0 8px 0 auto;padding:9px 15px;border-radius:20px;background:var(--imsg);color:#fff;line-height:1.35}
.bubble::before{content:"";position:absolute;right:-7px;bottom:0;width:20px;height:20px;background:var(--imsg);border-bottom-left-radius:16px 14px}
.bubble::after{content:"";position:absolute;right:-26px;bottom:0;width:26px;height:20px;background:var(--bg);border-bottom-left-radius:10px}
.convo .cap{margin:22px 16px 7px}
.files .row{--inset:57px;display:grid;grid-template-columns:29px minmax(0,1fr) auto;gap:12px;padding-block:7px;min-height:42px}
.files code{font-size:.8125rem;overflow-wrap:anywhere}
.files .v{font-size:.8125rem}
.files .mine .v{color:var(--pink);font-weight:600}
.convo figcaption{margin:9px 16px 0}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:30px 56px;counter-reset:s}
.steps li{display:grid;grid-template-columns:34px minmax(0,1fr);gap:14px;counter-increment:s}
.steps li::before{content:counter(s);width:34px;height:34px;border-radius:50%;background:var(--tint);color:#fff;display:grid;place-items:center;font-weight:700;font-size:1rem}
.steps h3{margin-top:5px}
.steps p{color:var(--label-2);font-size:.9375rem;margin:5px 0 0}
.apps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:36px}
.app{position:relative;display:flex;gap:14px;align-items:flex-start;padding-top:16px}
.app>.icon{margin-top:2px}
.app .body{flex:1;min-width:0;display:flex;gap:14px;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--sep)}
.app .txt{flex:1;min-width:0}
.app h3 a{color:var(--label)}
.app h3 a::after{content:"";position:absolute;inset:0}
.app h3 a:hover{text-decoration:none}
.app .sub{font-size:.9375rem;line-height:1.36;color:var(--label-2);margin:2px 0 7px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:.8125rem;color:var(--label-2);margin:0}
.mi{display:inline-flex;align-items:center;gap:4px}
.mi svg{width:14px;height:14px;stroke-width:2.4}
.fit{display:flex;gap:5px;align-items:flex-start;font-size:.8125rem;margin:6px 0 0;position:relative;z-index:1}
.fit svg{width:14px;height:14px;margin-top:2px;stroke-width:2.4}
.kind{display:inline-block;font-size:.75rem;font-weight:600;line-height:1.5;padding:0 7px;border-radius:6px;background:var(--fill);color:var(--label-2)}
.kind.foundation{background:color-mix(in srgb,var(--tint) 14%,transparent);color:var(--tint)}
.tags{display:flex;flex-wrap:wrap;gap:5px}
.tag{font-family:var(--mono);font-size:.78rem;line-height:1.6;background:var(--fill);border-radius:6px;padding:0 7px;white-space:nowrap}
.empty{background:var(--cell);border-radius:12px;padding:22px 20px}
.empty p:last-child{margin:0}
.searchbar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,250px) auto auto;gap:10px;align-items:center;margin:22px 0 8px}
.field-wrap{position:relative;display:block}
.count{margin:18px 0 0}
.product{display:grid;grid-template-columns:auto minmax(0,1fr);gap:26px;align-items:start}
.product h1{font-size:clamp(1.75rem,1.4rem + 1.4vw,2.25rem);letter-spacing:-.026em;margin:6px 0 2px}
.product .owner{margin:0 0 8px}
.product .lead{font-size:1.0625rem;margin:0}
.actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:16px}
.strip{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(132px,1fr);margin:32px 0 0;padding:12px 0;border-block:1px solid var(--sep);overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none}
.strip>div{display:grid;justify-items:center;align-content:start;text-align:center;gap:3px;padding:2px 12px;scroll-snap-align:start}
.strip>div+div{border-left:1px solid var(--sep)}
.strip .k{font-size:.75rem;color:var(--label-2)}
.strip b{font-size:1.375rem;line-height:1.2;letter-spacing:-.02em;color:var(--label-2)}
.strip b.ok{color:var(--green)}.strip b.warn{color:var(--orange)}
.strip .s{font-size:.75rem;color:var(--label-2)}
.split{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:48px;align-items:start;margin-top:32px}
.split>div>h2{margin:40px 0 12px}
.split>div>.fn{margin:9px 16px 0}
.group+.group{margin-top:30px}
.group h2{font-size:1.25rem;margin:0 0 10px}
.group>.fn{margin:8px 16px 0}
.group .row{font-size:.9375rem}
.group code{font-size:.8125rem}
.finding{align-items:flex-start}
.finding>svg{width:18px;height:18px;margin-top:2px;color:var(--label-2)}
.finding.warn>svg{color:var(--orange)}.finding.error>svg{color:var(--red)}
.finding span{color:var(--label)}
.prose{overflow-wrap:anywhere}
.prose>:first-child{margin-top:0}.prose>:last-child{margin-bottom:0}
.prose h1{font-size:clamp(2.125rem,1.8rem + 1vw,2.5rem);letter-spacing:-.028em;margin:0 0 18px}
.prose h2{margin:1.9em 0 .55em}
.prose h3{margin:1.5em 0 .4em}
.prose ul,.prose ol{padding-left:1.3em;margin:0 0 1em}
.prose li{margin:.3em 0;max-width:66ch}
.prose pre{background:var(--cell);border-radius:12px;padding:14px 16px;margin:0 0 1.2em;overflow-x:auto;font-size:.875rem;line-height:1.6}
.prose pre code{font-size:inherit}
.prose :not(pre)>code{background:var(--fill);padding:.1em .38em;border-radius:5px}
.prose table{overflow-wrap:normal;border-collapse:separate;border-spacing:0;width:100%;background:var(--cell);border-radius:12px;overflow:hidden;font-size:.9375rem;margin:0 0 1.2em}
.prose th,.prose td{text-align:left;vertical-align:top;padding:10px 16px;border-top:1px solid var(--sep)}
.prose thead th{border-top:0;font-size:.8125rem;font-weight:600;color:var(--label-2)}
.prose img{max-width:100%}
.docs{max-width:760px}
.sheet{background:var(--cell);border-radius:12px;padding:22px 24px}
.sheet h1{font-size:1.5rem}.sheet h2{font-size:1.1875rem}
.sheet pre{background:var(--bg)}
.sheet table{background:none;border:1px solid var(--sep)}
footer{border-top:1px solid var(--sep);padding:24px 0 40px;font-size:.8125rem;color:var(--label-2)}
footer .wrap{display:flex;gap:10px 24px;flex-wrap:wrap;justify-content:space-between}
footer nav{display:flex;gap:18px;flex-wrap:wrap}
@media (max-width:900px){.hero,.split{grid-template-columns:minmax(0,1fr);gap:40px}.apps{grid-template-columns:1fr}.searchbar{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.searchbar .field-wrap{grid-column:1/-1}}
@media (max-width:700px){
 .wrap{padding:0 16px}main{padding:24px 0 48px}
 .bar .wrap{gap:14px;height:52px}.links{display:none}
 .tabbar{display:grid;grid-template-columns:repeat(3,1fr);position:fixed;inset:auto 0 0;z-index:10;background:var(--bar);-webkit-backdrop-filter:saturate(180%) blur(20px);backdrop-filter:saturate(180%) blur(20px);border-top:1px solid var(--sep);padding:6px 0 calc(4px + env(safe-area-inset-bottom))}
 .tabbar a{display:grid;justify-items:center;gap:1px;font-size:.625rem;font-weight:500;letter-spacing:.01em;color:var(--label-2)}
 .tabbar a:hover{text-decoration:none}
 .tabbar svg{width:26px;height:26px;stroke-width:1.8}
 .tabbar a[aria-current]{color:var(--tint)}
 body{padding-bottom:calc(58px + env(safe-area-inset-bottom))}
 .seg{display:grid;width:100%}.seg>*{padding-inline:6px;font-size:.8125rem}
 .sec{margin-top:56px}
 .steps{grid-template-columns:1fr;gap:22px}
 .files .row{grid-template-columns:29px minmax(0,1fr)}.files .v{grid-column:2;text-align:left;margin:-6px 0 0}
 .searchbar{grid-template-columns:1fr}
 .product{gap:16px}.icon.lg{--s:88px}
 .actions{margin-top:12px}
 .sheet{padding:18px 16px}
 .prose th,.prose td{padding:9px 12px}
}
@media (prefers-reduced-motion:no-preference){.files .row{animation:in .4s both;animation-delay:calc(var(--i)*45ms)}@keyframes in{from{opacity:0;transform:translateY(4px)}}}
`;

const SCRIPT = `
document.querySelectorAll('[role=tablist]').forEach(list=>{const tabs=[...list.querySelectorAll('[role=tab]')];
tabs.forEach(t=>t.addEventListener('click',()=>{tabs.forEach(x=>{x.setAttribute('aria-selected',x===t);document.getElementById(x.getAttribute('aria-controls')).hidden=x!==t})}))});
document.querySelectorAll('.copy,[data-copy]').forEach(b=>b.addEventListener('click',async()=>{const label=b.dataset.label??=b.textContent;
const t=b.dataset.copy??b.parentElement.querySelector('code').innerText.replace(/^#.*$/gm,'').trim();
try{await navigator.clipboard.writeText(t);b.textContent='Copied';b.dataset.done='';clearTimeout(b.t);b.t=setTimeout(()=>{b.textContent=label;delete b.dataset.done},1600)}catch{b.textContent='Select and copy'}}));
document.querySelectorAll('[data-autosubmit]').forEach(f=>f.addEventListener('change',e=>{if(e.target.type==='radio')f.requestSubmit()}));
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#4aa5ff"/><stop offset="1" stop-color="#0a72f5"/></linearGradient></defs><rect width="32" height="32" rx="7.2" fill="url(#g)"/><g transform="translate(5 5) scale(.917)" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS.box}</g></svg>`;

function layout(origin: string, title: string, body: string, opts: { description?: string; q?: string; tab?: Tab; find?: boolean } = {}) {
  const description = opts.description ?? "An open, agent-first registry of reusable software builds. Coding agents find, install and assemble existing modules and project foundations, then write only what's missing.";
  const current = (tab: Tab) => (opts.tab === tab ? ` aria-current="page"` : "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#f9f9fb" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#161618" media="(prefers-color-scheme: dark)">
<link rel="alternate" type="text/plain" href="${origin}/llms.txt" title="llms.txt">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header class="bar"><div class="wrap"><a class="brand" href="/" aria-label="pkg home"><span class="icon xs" style="--c:#0a72f5">${svg("box")}</span>pkg</a>
${opts.find === false ? "" : `<form class="find" action="/search" role="search">${svg("search")}<input class="field" type="search" name="q" value="${esc(opts.q ?? "")}" placeholder="Search builds" aria-label="Search builds"></form>`}
<nav class="links"><a href="/search"${current("catalog")}>Catalog</a><a href="/docs"${current("publish")}>Publish</a><a href="/llms.txt">llms.txt</a><a href="https://github.com/tneemo/pkg">GitHub</a></nav></div></header>
<main><div class="wrap">${body}</div></main>
<footer><div class="wrap"><span>pkg is free and open source under the MIT license. Installing never needs an account.</span><nav><a href="/docs">Publish a build</a><a href="/llms.txt">Agent guide</a><a href="/api/search?q=">JSON API</a><a href="https://github.com/tneemo/pkg">Source</a></nav></div></footer>
<nav class="tabbar" aria-label="Sections"><a href="/"${current("home")}>${svg("house")}Home</a><a href="/search"${current("catalog")}>${svg("grid")}Catalog</a><a href="/docs"${current("publish")}>${svg("publish")}Publish</a></nav>
<script>${SCRIPT}</script></body></html>`;
}

const cmd = (code: string) => `<div class="cmd"><pre><code>${code}</code></pre><button class="pill copy" type="button">Copy</button></div>`;

function tags(list: string[]) {
  return list.length ? `<span class="tags">${list.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span>` : `<span class="muted">Nothing</span>`;
}

function requiresList(r: Record<string, string>) {
  return Object.entries(r).map(([t, v]) => (v === "*" ? t : `${t} ${v}`));
}

function appRows(results: Result[], showCompat: boolean) {
  return `<div class="apps">${results.map((r) => {
    const [owner, name] = r.id.split("/");
    const reports = r.agent_reports.success + r.agent_reports.failure;
    const via = r.compat?.via ? ` Get it via ${Object.values(r.compat.via).flat().map((id) => `<a href="/${esc(id)}">${esc(id)}</a>`).join(", ")}.` : "";
    const fit = showCompat && r.compat
      ? r.compat.ok
        ? `<p class="fit ok">${svg("check")}<span>Fits your stack</span></p>`
        : `<p class="fit warn">${svg("warn")}<span>${esc(r.compat.note)}.${via}</span></p>`
      : "";
    return `<article class="app">${buildIcon(r)}<div class="body"><div class="txt">
<h3><a href="/${esc(r.id)}">${esc(name)}</a></h3>
<p class="sub">${esc(r.description)}</p>
<p class="meta"><span class="kind ${esc(r.kind)}">${r.kind === "foundation" ? "Foundation" : "Module"}</span><span>${esc(owner)}</span>${r.risk === "ok" ? `<span class="mi ok">${svg("check")}Checks passed</span>` : `<span class="mi warn">${svg("warn")}Warnings</span>`}${reports ? `<span>${Math.round((r.agent_reports.success / reports) * 100)}% worked for agents</span>` : ""}<span>${plural(r.downloads, "install")}</span></p>${fit}
</div>${getButton(r.id, r.kind)}</div></article>`;
  }).join("")}</div>`;
}

function connectTabs() {
  const tabs: [string, string, string][] = [
    ["Claude Code", "claude mcp add pkg -- npx -y @tneemo/pkg mcp", "Then ask for what you want to build. Claude finds and assembles matching builds on its own."],
    ["Cursor & others", `# add to .cursor/mcp.json (or your client's MCP config)\n{ "mcpServers": { "pkg": { "command": "npx", "args": ["-y", "@tneemo/pkg", "mcp"] } } }`, "Works with any MCP client: Cursor, Windsurf, VS Code, Codex, Zed."],
    ["Any agent", "npx -y @tneemo/pkg search \"auth\" --stack typescript,hono --json", "Every command has --json output. Agents that can fetch URLs can start from /llms.txt."],
  ];
  return `<div class="seg" role="tablist" aria-label="Connect your agent">${tabs.map(([name], i) => `<button role="tab" id="t${i}" aria-controls="p${i}" aria-selected="${i === 0}">${esc(name)}</button>`).join("")}</div>
${tabs.map(([, code, note], i) => `<div class="tabpanel" role="tabpanel" id="p${i}" aria-labelledby="t${i}"${i ? " hidden" : ""}>${cmd(esc(code))}<p class="fn">${esc(note)}</p></div>`).join("")}`;
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
  const byId = new Map(catalog.results.map((r) => [r.id, r]));
  const rows = ASSEMBLED.map(([path, src, cls], i) => {
    const mine = cls === "mine";
    const icon = mine ? `<span class="icon sm agent" aria-hidden="true">${svg("sparkles")}</span>` : buildIcon(byId.get(src) ?? { id: src, kind: "module" }, "sm");
    const label = mine ? "Written by the agent" : `${src.split("/")[1]}${cls === "edit" ? " + wiring" : ""}`;
    return `<li class="row${cls ? ` ${cls}` : ""}" style="--i:${i}">${icon}<code>${esc(path)}</code><span class="v">${esc(label)}</span></li>`;
  }).join("");
  const mine = ASSEMBLED.filter(([, , c]) => c === "mine").length;
  return layout(origin, "pkg: reusable builds for coding agents", `
<section class="hero">
  <div>
    <h1 class="large">Agents shouldn't rebuild software that already exists.</h1>
    <p class="lead">pkg is an open catalog of reusable builds, from small modules to complete project foundations. Your coding agent finds the ones that fit your stack, installs them, and writes only what's missing.</p>
    ${connectTabs()}
  </div>
  <figure class="convo" aria-label="Example of an assembled project">
    <p class="bubble">Build a todo API with user accounts in TypeScript.</p>
    <p class="fn cap">What the agent assembled with pkg</p>
    <ol class="list files">${rows}</ol>
    <figcaption class="fn">The agent wrote ${mine} of 26 files, plus 6 lines of wiring. The other 23 files came from four community builds, tests included.</figcaption>
  </figure>
</section>

<section class="sec">
<h2>How it works</h2>
<ol class="steps">
  <li><div><h3>You describe the idea</h3><p>In your normal conversation with the agent: what you're building and, if you care, the stack. No spec files to prepare.</p></div></li>
  <li><div><h3>The agent searches pkg</h3><p>It looks for each part it needs and gets builds ranked by fit with your stack, automated checks and how they worked for other agents.</p></div></li>
  <li><div><h3>pkg assembles the project</h3><p>Files, dependencies, scripts and env vars are installed in dependency order. Code inside a build never runs during install.</p></div></li>
  <li><div><h3>The agent builds the rest</h3><p>It follows each build's integration notes, writes what's missing, then reports whether the builds worked. That report is the reputation.</p></div></li>
</ol>
</section>

<section class="sec">
<div class="sec-head"><h2>Catalog</h2><a href="/search">See all</a></div>
${catalog.results.length ? appRows(catalog.results, false) : `<div class="empty"><p>Nothing published yet. <a href="/docs">Publish the first build</a>.</p></div>`}
</section>

<section class="sec">
<h2>Publish a build</h2>
<p>Anything you've built that someone else will need again: a module, an integration, a whole project foundation. Your GitHub login is your namespace, so there is no account to create.</p>
${cmd(`<span class="c"># in the folder with your code</span>\nnpx -y @tneemo/pkg init      <span class="c"># writes pkg.json, stack detected for you</span>\nnpx -y @tneemo/pkg publish   <span class="c"># checks run, then it's live as &lt;you&gt;/&lt;name&gt;</span>`)}
<p class="fn" style="margin:9px 16px 0">Every publish is checked for secrets, install scripts, obfuscated code, prompt injection aimed at agents and dependencies that don't exist. <a href="/docs">Read the publishing guide</a>.</p>
</section>
`, { tab: "home" });
}

export function searchPage(origin: string, params: { q: string; stack: string; kind: string }, res: Results) {
  const showCompat = Object.keys(res.stack).length > 0;
  const kinds: [string, string][] = [["", "All"], ["foundation", "Foundations"], ["module", "Modules"]];
  return layout(origin, params.q ? `${params.q}: pkg search` : "Catalog: pkg", `
<h1 class="title">${params.q ? `Results for “${esc(params.q)}”` : "Catalog"}</h1>
<form class="searchbar" action="/search" role="search" data-autosubmit>
  <label class="field-wrap">${svg("search")}<input class="field" type="search" name="q" value="${esc(params.q)}" placeholder="Search builds: auth, database, rest api" aria-label="Search builds"></label>
  <input class="field" name="stack" value="${esc(params.stack)}" placeholder="Your stack: typescript, hono" aria-label="Your stack">
  <div class="seg" role="radiogroup" aria-label="Kind">${kinds.map(([v, l]) => `<label><input type="radio" name="kind" value="${v}"${params.kind === v ? " checked" : ""}>${l}</label>`).join("")}</div>
  <button class="btn">Search</button>
</form>
${res.results.length
    ? `<p class="fn count">${plural(res.results.length, "build")}${showCompat ? ", ranked by fit with your stack" : ""}</p>${appRows(res.results, showCompat)}`
    : `<div class="empty" style="margin-top:20px"><p><b>No builds match${params.q ? ` “${esc(params.q)}”` : ""}.</b></p><p>Try a broader word, or remove the stack filter. If it doesn't exist yet, build it once and <a href="/docs">publish it</a> so no agent has to write it again.</p></div>`}
`, { q: params.q, tab: "catalog", find: false });
}

function finding(f: Finding) {
  const glyph = f.level === "error" ? "xmark" : f.level === "warn" ? "warn" : "info";
  return `<li class="row finding ${esc(f.level)}">${svg(glyph)}<span>${esc(f.message)}${f.file ? ` <span class="muted">${esc(f.file)}${f.line ? `:${f.line}` : ""}</span>` : ""}</span></li>`;
}

const group = (title: string, rows: string[], foot = "") =>
  rows.length ? `<section class="group"><h2>${title}</h2><ul class="list">${rows.join("")}</ul>${foot ? `<p class="fn">${foot}</p>` : ""}</section>` : "";
const kv = (k: string, v: string) => `<li class="row"><span>${k}</span><span class="v">${v}</span></li>`;
const stacked = (k: string, v: string) => `<li class="row col"><span>${k}</span>${v}</li>`;
const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);
const FEEDBACK: Record<string, string> = { success: "Worked", failure: "Didn't work", report: "Flagged" };

export function buildPage(origin: string, info: Info, notes: Record<string, unknown>[]) {
  const m = info.manifest;
  const [owner, name] = info.id.split("/");
  const reports = info.agent_reports.success + info.agent_reports.failure;
  const findings = info.checks.findings.filter((f) => f.level !== "info");
  const deps = (eco: "npm" | "pip") => Object.entries({ ...(m.dependencies?.[eco] ?? {}), ...(m.devDependencies?.[eco] ?? {}) });
  const depList = [...deps("npm").map(([n, v]) => `${n} ${v}`), ...deps("pip").map(([n, v]) => `${n} ${v}`)];
  // The page already shows the name as its title, so drop a README heading that repeats it.
  const readme = info.readme?.replace(/^#[ \t]+(.+)\r?\n+/, (all, t: string) => (t.trim().toLowerCase() === name.toLowerCase() ? "" : all));
  const stat = (k: string, v: string, s = "", cls = "") => `<div><span class="k">${k}</span><b${cls ? ` class="${cls}"` : ""}>${v}</b><span class="s">${s}</span></div>`;
  const usesBuilds = Object.entries(m.builds ?? {}).map(([id, r]) => `<li class="row"><a class="stretch" href="/${esc(id)}">${esc(id)}</a><span class="v">${esc(r)}</span></li>`);
  const env = Object.entries(m.env ?? {}).map(([k, v]) => stacked(`<span><code>${esc(k)}</code>${v.required ? ` <span class="kind">Required</span>` : ""}</span>`, v.description ? `<span class="fn">${esc(v.description)}</span>` : ""));
  return layout(origin, `${info.id}: pkg`, `
<section class="product">
  ${buildIcon(info, "lg")}
  <div>
    <h1>${esc(name)}</h1>
    <p class="owner muted">${esc(owner)}</p>
    <p class="lead">${esc(info.description)}</p>
    <div class="actions">${getButton(info.id, info.kind, " filled")}<span class="fn">Version ${esc(info.version)}${info.version !== info.latest ? `. The latest is <a href="/${esc(info.id)}">${esc(info.latest)}</a>.` : ""}</span></div>
  </div>
</section>
<div class="strip">
  ${stat("Worked for agents", reports ? `${Math.round((info.agent_reports.success / reports) * 100)}%` : "–", reports ? `${info.agent_reports.success} of ${plural(reports, "report")}` : "No reports yet")}
  ${stat("Checks", info.checks.risk === "ok" ? "Passed" : plural(findings.length, "warning"), `Quality ${info.checks.quality}/100`, info.checks.risk === "ok" ? "ok" : "warn")}
  ${stat("Installs", info.downloads.toLocaleString("en-US"), "All versions")}
  ${stat("Kind", info.kind === "foundation" ? "Foundation" : "Module", info.kind === "foundation" ? "Starts a project" : "Adds to a project")}
  ${stat("Version", esc(info.version), day(info.published_at))}
  ${stat("License", esc(m.license))}
</div>
<div class="split">
  <div>
    ${cmd(esc(installCmd(info.id, info.kind)))}
    <p class="fn">Agents connected to pkg find this build on their own. You can also run the command yourself in the project folder.</p>
    ${info.integration ? `<h2>After installing</h2><div class="sheet prose">${markdown(info.integration)}</div>` : ""}
    <h2>Readme</h2>
    <div class="sheet prose">${readme ? markdown(readme) : `<p class="muted">This build has no README.</p>`}</div>
  </div>
  <aside>
    ${group("Compatibility", [stacked("Needs", tags(requiresList(info.requires))), stacked("Adds to your stack", tags(info.provides)), depList.length ? stacked("Installs packages", tags(depList)) : ""].filter(Boolean))}
    ${group("Uses builds", usesBuilds, "Installed first, in dependency order.")}
    ${group("Environment variables", env, "Added to .env.example.")}
    ${group("Check warnings", findings.map(finding), "Shown to everyone who installs this build.")}
    ${group("Agent reports", notes.slice(0, 5).map((n) => stacked(`<span class="fn">${esc(FEEDBACK[String(n.kind)] ?? n.kind)}${n.version ? `, version ${esc(n.version)}` : ""}</span>`, `<span>${esc(n.note)}</span>`)), info.flags ? `${plural(info.flags, "flag")} from agents.` : "")}
    ${group(`Files`, info.files.map((f) => `<li class="row"><a class="stretch" href="/api/builds/${esc(info.id)}/files/${esc(f.path)}?version=${esc(info.version)}"><code>${esc(f.path)}</code></a><span class="v fn">${size(f.size)}</span>${svg("chevron").replace("<svg", '<svg class="chev"')}</li>`))}
    ${group("Versions", info.versions.slice(0, 12).map((v) => `<li class="row"><a class="stretch" href="/${esc(info.id)}?v=${esc(v.version)}">${esc(v.version)}</a><span class="v">${esc(day(v.published_at))}</span>${v.version === info.version ? svg("check").replace("<svg", '<svg class="tick"') : ""}</li>`))}
    ${group("Information", [
      kv("Publisher", esc(info.publisher.replace(/^admin:/, ""))),
      kv("License", esc(m.license)),
      m.repository ? kv("Source code", `<a href="${esc(m.repository)}" rel="nofollow ugc noopener">Repository</a>`) : "",
      kv("Build data", `<a href="/api/builds/${esc(info.id)}">JSON</a>`),
      m.dependencies?.pip ? "" : kv("shadcn registry", `<a href="/r/${esc(info.id)}.json">Item JSON</a>`),
    ].filter(Boolean))}
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
  return layout(origin, "Publishing guide: pkg", `<article class="prose docs">${markdown(DOCS(origin))}</article>`, { tab: "publish" });
}

export function notFoundPage(origin: string, path: string, message?: string) {
  return layout(origin, "Not found: pkg", `<h1 class="title">${esc(message ?? `Nothing at ${path}`)}</h1><p class="lead">Search the catalog for what you need, or <a href="/docs">publish it</a> if it doesn't exist yet.</p>`);
}
