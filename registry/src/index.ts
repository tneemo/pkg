// pkg registry: one Cloudflare Worker serving the JSON API, the website and agent docs.
import { buildInfo, downloadBundle, feedback, HttpError, publish, readBundle, recentFeedback, resolve, search, type Env } from "./api.ts";
import { buildPage, docsPage, homePage, notFoundPage, searchPage } from "./pages.ts";
import { llmsTxt } from "./llms.ts";
import { manifestSchema } from "./schema.ts";
import { shadcnItem } from "./shadcn.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-pkg-owner", "access-control-allow-methods": "GET, POST, OPTIONS" };

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
const text = (body: string, type = "text/plain") => new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=300", ...CORS } });

type Handler = (req: Request, env: Env, ctx: ExecutionContext, params: string[], url: URL) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/search$/, async (_r, env, _c, _p, url) =>
    json(await search(env, { q: url.searchParams.get("q"), stack: url.searchParams.get("stack"), kind: url.searchParams.get("kind"), limit: Number(url.searchParams.get("limit")) || undefined }))],
  ["POST", /^\/api\/resolve$/, async (req, env) => {
    const body = (await req.json().catch(() => null)) as { builds?: string[] } | null;
    return json(await resolve(env, body?.builds ?? []));
  }],
  ["POST", /^\/api\/publish$/, async (req, env) => json(await publish(env, req), 201)],
  ["GET", /^\/api\/bundles\/([a-z0-9-]+)\/([a-z0-9-]+)\/([^/]+)$/, (_r, env, ctx, [o, n, v]) => downloadBundle(env, ctx, o, n, decodeURIComponent(v))],
  ["GET", /^\/api\/builds\/([a-z0-9-]+)\/([a-z0-9-]+)$/, async (_r, env, _c, [o, n], url) => json(await buildInfo(env, `${o}/${n}`, url.searchParams.get("version")))],
  ["GET", /^\/api\/builds\/([a-z0-9-]+)\/([a-z0-9-]+)\/feedback$/, async (_r, env, _c, [o, n]) => json(await recentFeedback(env, `${o}/${n}`))],
  ["POST", /^\/api\/builds\/([a-z0-9-]+)\/([a-z0-9-]+)\/feedback$/, async (req, env, _c, [o, n]) => json(await feedback(env, req, `${o}/${n}`))],
  ["GET", /^\/api\/builds\/([a-z0-9-]+)\/([a-z0-9-]+)\/files\/(.+)$/, async (_r, env, _c, [o, n, path], url) => {
    const info = await buildInfo(env, `${o}/${n}`, url.searchParams.get("version"));
    const bundle = await readBundle(env, info.id, info.version);
    const file = bundle?.files.find((f) => f.path === decodeURIComponent(path));
    if (!file) throw new HttpError(404, "file not found");
    return text(file.encoding === "base64" ? "(binary file)" : file.content);
  }],
  ["GET", /^\/r\/([a-z0-9-]+)\/([a-z0-9-]+)\.json$/, async (_r, env, _c, [o, n], url) => {
    const info = await buildInfo(env, `${o}/${n}`, null);
    const bundle = await readBundle(env, info.id, info.version);
    return json(shadcnItem(info, bundle!, url.origin));
  }],
  ["GET", /^\/llms\.txt$/, (_r, _e, _c, _p, url) => text(llmsTxt(url.origin))],
  ["GET", /^\/schema\/pkg\.json$/, () => json(manifestSchema)],
  ["GET", /^\/$/, async (_r, env, _c, _p, url) => html(homePage(url.origin, await search(env, { limit: 50 })))],
  ["GET", /^\/search$/, async (_r, env, _c, _p, url) => {
    const q = url.searchParams.get("q") ?? "";
    const stack = url.searchParams.get("stack") ?? "";
    const kind = url.searchParams.get("kind") ?? "";
    return html(searchPage(url.origin, { q, stack, kind }, await search(env, { q, stack, kind, limit: 50 })));
  }],
  ["GET", /^\/docs$/, (_r, _e, _c, _p, url) => html(docsPage(url.origin))],
  ["GET", /^\/([a-z0-9-]+)\/([a-z0-9-]+)$/, async (_r, env, _c, [o, n], url) => {
    const info = await buildInfo(env, `${o}/${n}`, url.searchParams.get("v"));
    return html(buildPage(url.origin, info, await recentFeedback(env, info.id)));
  }],
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const isApi = url.pathname.startsWith("/api/") || url.pathname.startsWith("/r/");
    try {
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (m && (request.method === method || (method === "GET" && request.method === "HEAD"))) return await handler(request, env, ctx, m.slice(1), url);
      }
      if (isApi) return json({ error: "not found", docs: `${url.origin}/llms.txt` }, 404);
      return html(notFoundPage(url.origin, url.pathname), 404);
    } catch (e) {
      if (e instanceof HttpError) {
        if (isApi) return json({ error: e.message, details: e.details }, e.status);
        return html(notFoundPage(url.origin, url.pathname, e.message), e.status);
      }
      console.error(e);
      return isApi ? json({ error: "internal error" }, 500) : html(notFoundPage(url.origin, url.pathname, "Something went wrong on our side."), 500);
    }
  },
} satisfies ExportedHandler<Env>;
