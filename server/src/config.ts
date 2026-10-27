export interface Env {
  // secrets (wrangler secret put)
  HCSS_CLIENT_ID: string;
  HCSS_CLIENT_SECRET: string;
  ALLOWED_USER_EMAIL: string;        // comma-separated allowlist
  ACCESS_PASSWORD_HASH: string;      // pbkdf2$<iter>$<salt_b64>$<hash_b64>
  TOKEN_EPOCH: string;               // rotate to revoke every issued token
  HCSS_BUSINESS_UNIT_ID?: string;
  // vars (wrangler.toml)
  HCSS_SCOPE?: string;
  HCSS_TOKEN_URL?: string;
  HCSS_API_BASE?: string;
  ALLOWED_CIDRS?: string;
  HCSS_PAGE_SIZE?: string;
  HCSS_MAX_SUBREQUESTS?: string;
  EXPORT_TTL_SECONDS?: string;
  PUBLIC_ORIGIN?: string;            // e.g. https://schrex-hcss-heavyjob-mcp.schrex.workers.dev
  EXPORTS: KVNamespace;
  OAUTH_KV: KVNamespace;             // required by @cloudflare/workers-oauth-provider; also holds login throttle counters
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers; // injected by the library
}

export interface Config {
  clientId: string;
  clientSecret: string;
  scope: string;
  tokenUrl: string;
  apiBase: string;
  businessUnitId?: string;
  pageSize: number;
  maxSubrequests: number;
  allowedCidrs: string[];
  exportTtlSeconds: number;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: Env): Config {
  if (!env.HCSS_CLIENT_ID || !env.HCSS_CLIENT_SECRET) throw new Error("HCSS_CLIENT_ID / HCSS_CLIENT_SECRET secrets are not set.");
  const scope = env.HCSS_SCOPE || "heavyjob:read timecards:read";
  if (/:write|admin/i.test(scope)) throw new Error("HCSS_SCOPE must be read-only (no :write / admin scopes).");
  return {
    clientId: env.HCSS_CLIENT_ID,
    clientSecret: env.HCSS_CLIENT_SECRET,
    scope,
    tokenUrl: env.HCSS_TOKEN_URL || "https://api.hcssapps.com/identity/connect/token",
    // HeavyJob OpenAPI "servers": https://api.hcssapps.com/heavyjob ; paths start with /api/v1 or /api/v2
    apiBase: (env.HCSS_API_BASE || "https://api.hcssapps.com/heavyjob").replace(/\/$/, ""),
    businessUnitId: env.HCSS_BUSINESS_UNIT_ID || undefined,
    pageSize: Math.min(5000, Math.max(1, num(env.HCSS_PAGE_SIZE, 1000))),
    maxSubrequests: Math.min(48, num(env.HCSS_MAX_SUBREQUESTS, 45)),
    allowedCidrs: (env.ALLOWED_CIDRS ?? "160.79.104.0/21").split(",").map((s) => s.trim()).filter(Boolean),
    exportTtlSeconds: Math.max(60, num(env.EXPORT_TTL_SECONDS, 900)),
  };
}

export const allowedEmails = (env: Env) =>
  (env.ALLOWED_USER_EMAIL ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
