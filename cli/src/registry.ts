// HTTP client for the pkg registry API.
import { gunzipSync } from "node:zlib";
import { checkBundle, type Finding } from "../../shared/checks.ts";
import { integrityOf, type Bundle, type Manifest } from "../../shared/manifest.ts";

declare const __PKG_VERSION__: string; // set from package.json by build.mjs
export const VERSION = __PKG_VERSION__;
export const REGISTRY = (process.env.PKG_REGISTRY ?? "https://pkg.tneemo.com").replace(/\/+$/, "");

/** Which agent or tool is driving pkg, sent along with feedback. */
export let client = process.env.CLAUDECODE ? "claude-code" : process.env.CURSOR_TRACE_ID ? "cursor" : process.env.CODEX_SANDBOX ? "codex" : "cli";
export function setClient(name: string) {
  client = name;
}

export class RegistryError extends Error {
  constructor(message: string, public status?: number, public details?: any) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${REGISTRY}${path}`, {
      ...init,
      headers: { "user-agent": `pkg-cli/${VERSION} (node ${process.version}; ${client})`, ...(init.headers ?? {}) },
    });
  } catch (e) {
    throw new RegistryError(`cannot reach the registry at ${REGISTRY} (${(e as Error).message}). Set PKG_REGISTRY to use another registry.`);
  }
  const body = await res.text();
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw new RegistryError(`unexpected response from ${REGISTRY}${path} (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) throw new RegistryError(data.error ?? `HTTP ${res.status}`, res.status, data.details);
  return data as T;
}

export interface SearchResult {
  id: string;
  kind: "module" | "foundation";
  description: string;
  version: string;
  keywords: string[];
  requires: Record<string, string>;
  provides: string[];
  license: string;
  risk: string;
  quality: number;
  downloads: number;
  agent_reports: { success: number; failure: number; success_rate: number };
  flags: number;
  reputation: number;
  score: number;
  compat?: { ok: boolean; missing: string[]; mismatched: { tag: string; range: string; version: string }[]; note: string; via?: Record<string, string[]> };
  install: string;
}

export interface BuildInfo extends Omit<SearchResult, "score" | "compat" | "install"> {
  latest: string;
  manifest: Manifest;
  readme: string | null;
  integration: string | null;
  files: { path: string; size: number }[];
  checks: { risk: string; quality: number; findings: Finding[] };
  integrity: string;
  publisher: string;
  published_at: string;
  versions: { version: string; published_at: string; risk: string; yanked: boolean }[];
}

export interface ResolvedBuild {
  id: string;
  version: string;
  kind: "module" | "foundation";
  manifest: Manifest;
  integration: string | null;
  integrity: string;
  bundle: string;
  risk: string;
  warnings: Finding[];
  requested_by: string[];
}

/** Profile -> "tag@version,tag" for the search API, capped to keep URLs short. */
export function stackParam(profile: Record<string, string | null>): string {
  const parts = Object.entries(profile)
    .sort(([a], [b]) => Number(a.includes(":")) - Number(b.includes(":")))
    .map(([t, v]) => (v ? `${t}@${v}` : t));
  let out = "";
  for (const p of parts) if (out.length + p.length < 4000) out += (out ? "," : "") + p;
  return out;
}

export function search(q: string, opts: { stack?: string; kind?: string; limit?: number } = {}) {
  const params = new URLSearchParams({ q });
  if (opts.stack) params.set("stack", opts.stack);
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.limit) params.set("limit", String(opts.limit));
  return call<{ query: string; stack: Record<string, string | null>; total: number; results: SearchResult[] }>(`/api/search?${params}`);
}

export function info(id: string, version?: string) {
  return call<BuildInfo>(`/api/builds/${id}${version ? `?version=${encodeURIComponent(version)}` : ""}`);
}

export function resolve(specs: string[]) {
  return call<{ builds: ResolvedBuild[] }>("/api/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ builds: specs }),
  });
}

/** Downloads a bundle and verifies it against the integrity hash from resolve. */
export async function fetchBundle(build: ResolvedBuild): Promise<Bundle> {
  // Bundle paths come from the registry; only follow ones on the registry's own origin.
  const url = new URL(build.bundle, `${REGISTRY}/`);
  if (url.origin !== new URL(REGISTRY).origin) throw new RegistryError(`refusing bundle URL outside ${REGISTRY}: ${build.bundle}`);
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": `pkg-cli/${VERSION} (${client})` } });
  } catch (e) {
    throw new RegistryError(`download failed for ${build.id}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new RegistryError(`download failed for ${build.id}@${build.version} (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = await integrityOf(bytes);
  if (actual !== build.integrity) throw new RegistryError(`integrity check failed for ${build.id}@${build.version}: expected ${build.integrity}, got ${actual}`);
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: 6_000_000 }).toString("utf8")) as Bundle;
  const report = checkBundle(bundle);
  if (report.risk === "error") throw new RegistryError(`invalid bundle for ${build.id}`, 422, report);
  if (JSON.stringify(bundle.manifest) !== JSON.stringify(build.manifest)) throw new RegistryError(`resolved manifest differs from bundle for ${build.id}`);
  return bundle;
}

export function feedback(id: string, body: { outcome: "success" | "failure" | "report"; note?: string; version?: string }) {
  return call<{ ok: boolean; counted: boolean; message: string }>(`/api/builds/${id}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, client }),
  });
}

export function publish(gz: Uint8Array, token: string, owner: string) {
  return call<{ id: string; version: string; integrity: string; risk: string; quality: number; findings: Finding[]; publisher: string }>("/api/publish", {
    method: "POST",
    headers: { "content-type": "application/gzip", authorization: `Bearer ${token}`, "x-pkg-owner": owner },
    body: gz as unknown as BodyInit,
  });
}
