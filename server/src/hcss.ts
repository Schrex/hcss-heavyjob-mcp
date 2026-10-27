import type { Config } from "./config.js";
import { grantedIncludes, TELEMATICS_READ_SCOPE, TELEMATICS_SCOPE_ERROR, withoutTelematicsScope } from "./scopes.js";

type Query = Record<string, string | number | boolean | undefined>;
type Rec = Record<string, unknown>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Isolate-scoped caches (best effort; isolates are reused but can be evicted any time).
type TokenEntry = { token: string; exp: number; granted?: string };
const tokenCache = new Map<string, TokenEntry>();
/** When the combined scope is rejected, HeavyJob keeps using the scope without telematics:read for this long, then tries again. */
const FULL_SCOPE_BACKOFF_MS = 10 * 60_000;
let fullScopeRejectedUntil = 0;
const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 5 * 60_000;

export class InvalidHcssScopeError extends Error {
  requestedScope: string;
  status: number;
  constructor(requestedScope: string, status: number) {
    super("invalid_scope");
    this.name = "InvalidHcssScopeError";
    this.requestedScope = requestedScope;
    this.status = status;
  }
}

type CallOpts = { base?: string; token?: "heavyjob" | "telematics"; forbiddenError?: string };

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

  /**
   * One client-credentials token for an exact scope string.
   * HeavyJob and Telematics are requested separately when the combined scope is rejected:
   * HCSS returns invalid_scope for the whole request if any requested scope is not on the client,
   * which would take down existing tools. A rejected combined scope falls back to heavyjob:read + timecards:read
   * for those tools, and telematics calls ask for telematics:read on their own.
   */
  private async requestToken(scope: string): Promise<{ token: string; cacheKey: string; granted?: string }> {
    const cacheKey = this.cfg.clientId + "|" + scope;
    const hit = tokenCache.get(cacheKey);
    if (hit && Date.now() < hit.exp - 60_000) return { token: hit.token, cacheKey, granted: hit.granted };
    const form = (withClientInBody: boolean) => {
      const f = new URLSearchParams({ grant_type: "client_credentials", scope });
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
      if (err?.error === "invalid_scope") throw new InvalidHcssScopeError(scope, res.status);
      if (err?.error && err.error !== "invalid_client") throw new Error(`HCSS token request failed: HTTP ${res.status} ${err.error}`);
      res = await post(form(false), true); // fall back once to HTTP Basic client auth
    }
    if (!res.ok) {
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, "token");
      if (res.status === 400 || res.status === 401) {
        try {
          const err = await readJson<{ error?: string }>(res, "token");
          if (err?.error === "invalid_scope") throw new InvalidHcssScopeError(scope, res.status);
        } catch (e) {
          if (e instanceof InvalidHcssScopeError) throw e;
          if (e instanceof Error && /firewall blocked/.test(e.message)) throw e;
        }
      }
      throw new Error(`HCSS token request failed: HTTP ${res.status}`); // never echo secrets
    }
    const j = await readJson<{ access_token: string; expires_in?: number; scope?: string }>(res, "token");
    const granted = typeof j.scope === "string" ? j.scope : undefined;
    const entry: TokenEntry = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, granted };
    tokenCache.set(cacheKey, entry);
    return { token: entry.token, cacheKey, granted };
  }

  private heavyjobScopeError(e: InvalidHcssScopeError): Error {
    return new Error(`HCSS token request failed: HTTP ${e.status} invalid_scope (the API client lacks heavyjob:read or timecards:read)`);
  }

  private async heavyjobAccess(): Promise<{ token: string; cacheKey: string }> {
    const full = this.cfg.scope.trim();
    const base = withoutTelematicsScope(full);
    const canSplit = Boolean(base) && base !== full;
    if (!canSplit || Date.now() < fullScopeRejectedUntil) {
      try {
        const got = await this.requestToken(canSplit ? base : full);
        return { token: got.token, cacheKey: got.cacheKey };
      } catch (e) {
        if (e instanceof InvalidHcssScopeError) throw this.heavyjobScopeError(e);
        throw e;
      }
    }
    try {
      const got = await this.requestToken(full);
      return { token: got.token, cacheKey: got.cacheKey };
    } catch (e) {
      if (!(e instanceof InvalidHcssScopeError)) throw e;
      fullScopeRejectedUntil = Date.now() + FULL_SCOPE_BACKOFF_MS;
      try {
        const got = await this.requestToken(base);
        return { token: got.token, cacheKey: got.cacheKey };
      } catch (e2) {
        if (e2 instanceof InvalidHcssScopeError) throw this.heavyjobScopeError(e2);
        throw e2;
      }
    }
  }

  private async telematicsAccess(): Promise<{ token: string; cacheKey: string }> {
    const full = this.cfg.scope.trim();
    const wantsCombined = full.split(/\s+/).includes(TELEMATICS_READ_SCOPE) && Date.now() >= fullScopeRejectedUntil;
    if (wantsCombined) {
      try {
        const got = await this.requestToken(full);
        if (grantedIncludes(got.granted, TELEMATICS_READ_SCOPE)) return { token: got.token, cacheKey: got.cacheKey };
      } catch (e) {
        if (!(e instanceof InvalidHcssScopeError)) throw e;
        fullScopeRejectedUntil = Date.now() + FULL_SCOPE_BACKOFF_MS;
      }
    }
    try {
      const got = await this.requestToken(TELEMATICS_READ_SCOPE);
      if (!grantedIncludes(got.granted, TELEMATICS_READ_SCOPE)) throw new Error(TELEMATICS_SCOPE_ERROR);
      return { token: got.token, cacheKey: got.cacheKey };
    } catch (e) {
      if (e instanceof InvalidHcssScopeError) throw new Error(TELEMATICS_SCOPE_ERROR);
      throw e;
    }
  }

  private async call<T>(method: "GET" | "POST", path: string, query: Query, body?: unknown, opts?: CallOpts): Promise<T> {
    if (method === "POST" && !READ_POSTS.some((r) => r.test(path))) throw new Error(`Refusing POST ${path}: not a documented read-only query.`);
    const url = new URL((opts?.base ?? this.cfg.apiBase) + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const key = `${method} ${url} ${payload ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

    for (let attempt = 0; attempt < 4; attempt++) {
      const auth = opts?.token === "telematics" ? await this.telematicsAccess() : await this.heavyjobAccess();
      this.spend();
      const headers: Record<string, string> = { ...HCSS_HEADERS, Authorization: `Bearer ${auth.token}` };
      if (payload) headers["Content-Type"] = "application/json";
      const res = await fetch(url.toString(), { method, headers, body: payload });
      if (res.status === 401 && attempt === 0) { tokenCache.delete(auth.cacheKey); continue; }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("Retry-After"));
        await sleep(Math.min(20_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt) + Math.random() * 250);
        continue;
      }
      if ((res.headers.get("Content-Type") ?? "").includes("text/html")) await readJson(res, `${method} ${url.pathname}`);
      if (res.status === 403) throw new Error(opts?.forbiddenError ?? `HCSS 403 Forbidden on ${method} ${url.pathname}: the API client lacks a scope (heavyjob:read, or timecards:read for time cards).`);
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

  get<T>(path: string, query: Query = {}, opts?: CallOpts) { return this.call<T>("GET", path, query, undefined, opts); }
  post<T>(path: string, body: Rec, query: Query = {}) { return this.call<T>("POST", path, query, body); }

  /**
   * Cursor pagination (HCSS: { results: [...], metadata: { nextCursor } }; empty nextCursor = end).
   * Pages sequentially until maxRecords or the end. Returns hcssCursor when stopped early so the caller can resume.
   */
  async cursorAll<T>(method: "GET" | "POST", path: string, args: Rec, maxRecords: number, startCursor?: string, opts?: CallOpts) {
    const out: T[] = [];
    let cursor = startCursor;
    for (;;) {
      const limit = Math.min(this.cfg.pageSize, Math.max(0, maxRecords - out.length));
      if (limit <= 0) return { records: out, truncated: true, hcssCursor: cursor };
      const page = method === "GET"
        ? await this.get<{ results?: T[]; metadata?: { nextCursor?: string | null } }>(path, { ...(args as Query), limit, cursor }, opts)
        : await this.post<{ results?: T[]; metadata?: { nextCursor?: string | null } }>(path, { ...args, limit, cursor });
      const rows = page?.results ?? [];
      out.push(...rows);
      const step = advanceCursor({ fetched: out.length, maxRecords, rowCount: rows.length, nextCursor: page?.metadata?.nextCursor, prevCursor: cursor });
      if (step.done) return { records: out, truncated: step.truncated, hcssCursor: step.hcssCursor };
      cursor = step.cursor;
    }
  }

  /**
   * Every page of GET /telematics/api/v1/equipment, sequentially (shared 100 req/min company limit).
   * isRegistered omitted returns all units. Stops at maxRecords or the subrequest budget.
   * A budget miss after at least one page returns that partial set as truncated instead of dropping it.
   */
  async fetchTelematicsEquipment(maxRecords: number, isRegistered?: boolean) {
    const out: Rec[] = [];
    let cursor: string | undefined;
    const opts: CallOpts = { base: this.cfg.telematicsBase, token: "telematics", forbiddenError: TELEMATICS_SCOPE_ERROR };
    try {
      for (;;) {
        const limit = Math.min(this.cfg.pageSize, Math.max(0, maxRecords - out.length));
        if (limit <= 0) return { records: out, truncated: true, hcssCursor: cursor };
        const page = await this.get<{ results?: Rec[]; metadata?: { nextCursor?: string | null } }>(
          "/api/v1/equipment", { limit, cursor, isRegistered }, opts);
        const rows = page?.results ?? [];
        out.push(...rows);
        const step = advanceCursor({ fetched: out.length, maxRecords, rowCount: rows.length, nextCursor: page?.metadata?.nextCursor, prevCursor: cursor });
        if (step.done) return { records: out, truncated: step.truncated, hcssCursor: step.hcssCursor };
        cursor = step.cursor;
      }
    } catch (e) {
      if (e instanceof BudgetError && out.length > 0) return { records: out, truncated: true, hcssCursor: cursor };
      throw e;
    }
  }
}

/**
 * Stop conditions for HCSS cursor pages. Empty nextCursor, an empty page, or a repeated cursor ends the walk.
 * Hitting maxRecords with a further cursor is a partial result.
 */
export function advanceCursor(args: {
  fetched: number;
  maxRecords: number;
  rowCount: number;
  nextCursor: string | null | undefined;
  prevCursor?: string;
}): { done: true; truncated: boolean; hcssCursor?: string } | { done: false; cursor: string } {
  const next = args.nextCursor || undefined;
  if (!next || args.rowCount === 0 || next === args.prevCursor) return { done: true, truncated: false };
  if (args.fetched >= args.maxRecords) return { done: true, truncated: true, hcssCursor: next };
  return { done: false, cursor: next };
}

/** Trim + natural compare for HCSS codes (HeavyBid pads with spaces; HeavyJob may too). */
export const normCode = (v: unknown) => String(v ?? "").trim();
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export const codeCompare = (a: unknown, b: unknown) => collator.compare(normCode(a), normCode(b));
export const codeEq = (a: unknown, b: unknown) => normCode(a).toLowerCase() === normCode(b).toLowerCase();
