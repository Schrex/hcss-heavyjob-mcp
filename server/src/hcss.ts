import type { Config } from "./config.js";

type Query = Record<string, string | number | boolean | undefined>;
type Rec = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Isolate-scoped caches (best effort; isolates are reused but can be evicted any time).
let tokenCache: { token: string; exp: number; key: string } | undefined;
const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 5 * 60_000;

export class BudgetError extends Error {}

// HCSS sits behind an Azure firewall that blocks some default user agents.
export const HCSS_HEADERS = { "User-Agent": "Mozilla/5.0 SchreiberMCP/0.1", Accept: "application/json" } as const;

async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  const ct = res.headers.get("Content-Type") ?? "";
  const head = text.trimStart().slice(0, 15).toLowerCase();
  if (ct.includes("text/html") || head.startsWith("<!doctype") || head.startsWith("<html") || /request is blocked/i.test(text.slice(0, 2000))) {
    throw new Error(`HCSS firewall blocked request (${what}: HTTP ${res.status}, HTML response instead of JSON)`);
  }
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { throw new Error(`HCSS returned non-JSON for ${what} (HTTP ${res.status})`); }
}

/**
 * Read-only HeavyJob client, one per Worker invocation so it can count subrequests
 * (free plan: 50/invocation; token + every HCSS page count).
 * Only GETs and documented read-only POST queries (".../advancedRequest", ".../search", "/jobs/advanced",
 * "/hours/employees", "/hours/equipment") are allowed; see READ_POSTS.
 */
const READ_POSTS = [
  /^\/api\/v1\/jobs\/advanced$/,
  /^\/api\/v2\/costCodes\/advancedRequest$/,
  /^\/api\/v1\/costCode\/progress\/advancedRequest$/,
  /^\/api\/v1\/jobCostsToDate\/search$/,
  /^\/api\/v1\/jobCosts\/advancedRequest$/,
  /^\/api\/v1\/hours\/employees$/,
  /^\/api\/v1\/hours\/equipment$/,
  /^\/api\/v1\/diaries\/search$/,
  /^\/api\/v1\/employees\/advancedRequest$/,
];

export class HcssClient {
  used = 0;
  constructor(private cfg: Config) {}

  private spend() {
    if (++this.used > this.cfg.maxSubrequests) {
      throw new BudgetError(`Request too large for the Workers free plan (${this.cfg.maxSubrequests} HCSS calls per request). Narrow it: one job, a shorter date range, or one cost code.`);
    }
  }

  private async token(): Promise<string> {
    const key = this.cfg.clientId + "|" + this.cfg.scope;
    if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
    const form = (withClientInBody: boolean) => {
      const f = new URLSearchParams({ grant_type: "client_credentials", scope: this.cfg.scope });
      if (withClientInBody) { f.set("client_id", this.cfg.clientId); f.set("client_secret", this.cfg.clientSecret); }
      return f;
    };
    const post = (body: URLSearchParams, basic: boolean) => {
      this.spend();
      const headers: Record<string, string> = { ...HCSS_HEADERS, "Content-Type": "application/x-www-form-urlencoded" };
      if (basic) headers.Authorization = "Basic " + btoa(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`);
      return fetch(this.cfg.tokenUrl, { method: "POST", headers, body });
    };
    let res = await post(form(true), false);
    if (res.status === 400 || res.status === 401) {
      const err = await readJson<{ error?: string }>(res, "token").catch(() => ({} as { error?: string }));
      if (err?.error && err.error !== "invalid_client") throw new Error(`HCSS token request failed: HTTP ${res.status} ${err.error}` + (err.error === "invalid_scope" ? " (the API client lacks heavyjob:read or timecards:read)" : ""));
      res = await post(form(false), true); // fall back once to HTTP Basic client auth
    }
    if (!res.ok) {
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, "token");
      throw new Error(`HCSS token request failed: HTTP ${res.status}`); // never echo secrets
    }
    const j = await readJson<{ access_token: string; expires_in?: number }>(res, "token");
    tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, key };
    return j.access_token;
  }

  private async call<T>(method: "GET" | "POST", path: string, query: Query, body?: unknown): Promise<T> {
    if (method === "POST" && !READ_POSTS.some((r) => r.test(path))) throw new Error(`Refusing POST ${path}: not a documented read-only query.`);
    const url = new URL(this.cfg.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const key = `${method} ${url} ${payload ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

    for (let attempt = 0; attempt < 4; attempt++) {
      const auth = `Bearer ${await this.token()}`;
      this.spend();
      const headers: Record<string, string> = { ...HCSS_HEADERS, Authorization: auth };
      if (payload) headers["Content-Type"] = "application/json";
      const res = await fetch(url.toString(), { method, headers, body: payload });
      if (res.status === 401 && attempt === 0) { tokenCache = undefined; continue; }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("Retry-After"));
        await sleep(Math.min(20_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, `${method} ${url.pathname}`);
      if (res.status === 403) throw new Error(`HCSS 403 Forbidden on ${method} ${url.pathname}: the API client lacks a scope (heavyjob:read, or timecards:read for time cards).`);
      if (!res.ok) {
        // Pass HCSS's own explanation through, truncated. Bodies never contain our secrets.
        const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500);
        throw new Error(`HCSS ${method} ${url.pathname} failed: HTTP ${res.status}${text ? ` - ${text}` : ""}`);
      }
      const value = await readJson<T>(res, `${method} ${url.pathname}`);
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 50) cache.delete(cache.keys().next().value as string);
      return value;
    }
    throw new Error(`HCSS ${method} ${url.pathname}: gave up after repeated 429/5xx (HCSS limit is 100/min per company, shared with the nightly sync).`);
  }

  get<T>(path: string, query: Query = {}) { return this.call<T>("GET", path, query); }
  post<T>(path: string, body: Rec, query: Query = {}) { return this.call<T>("POST", path, query, body); }

  /**
   * Cursor pagination (HCSS: { results: [...], metadata: { nextCursor } }; empty nextCursor = end).
   * Pages sequentially until maxRecords or the end. Returns hcssCursor when stopped early so the caller can resume.
   */
  async cursorAll<T>(method: "GET" | "POST", path: string, args: Rec, maxRecords: number, startCursor?: string) {
    const out: T[] = [];
    let cursor = startCursor;
    for (;;) {
      const limit = Math.min(this.cfg.pageSize, maxRecords - out.length);
      const page = method === "GET"
        ? await this.get<{ results?: T[]; metadata?: { nextCursor?: string | null } }>(path, { ...(args as Query), limit, cursor })
        : await this.post<{ results?: T[]; metadata?: { nextCursor?: string | null } }>(path, { ...args, limit, cursor });
      const rows = page?.results ?? [];
      out.push(...rows);
      const next = page?.metadata?.nextCursor || undefined;
      if (!next || rows.length === 0 || next === cursor) return { records: out, truncated: false, hcssCursor: undefined as string | undefined };
      if (out.length >= maxRecords) return { records: out, truncated: true, hcssCursor: next };
      cursor = next;
    }
  }
}

/** Trim + natural compare for HCSS codes (HeavyBid pads with spaces; HeavyJob may too). */
export const normCode = (v: unknown) => String(v ?? "").trim();
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const codeCompare = (a: unknown, b: unknown) => collator.compare(normCode(a), normCode(b));
export const codeEq = (a: unknown, b: unknown) => normCode(a).toLowerCase() === normCode(b).toLowerCase();
