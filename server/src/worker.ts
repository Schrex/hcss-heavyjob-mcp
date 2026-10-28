import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig, type Env } from "./config.js";
import { HcssClient } from "./hcss.js";
import { buildServer } from "./tools.js";
import { ipAllowed } from "./ip.js";
import { emailAllowed, handleAuthorize, type AuthProps } from "./auth.js";
import { captureTelematicsSnapshot } from "./telematics_db.js";

const ACCESS_TTL_S = 60 * 60;            // 1 h access tokens
const REFRESH_TTL_S = 90 * 24 * 60 * 60; // grant (refresh) lives 90 days from sign-in, then sign in again

const unauthorized = (why: string) => new Response(JSON.stringify({ error: "invalid_token", error_description: why }), {
  status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": `Bearer error="invalid_token", error_description="${why}"` },
});

/** /mcp: reached only with a valid OAuth access token (the library validates it and sets ctx.props). */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let cfg;
    try { cfg = loadConfig(env); } catch (e) { console.error((e as Error).message); return new Response("misconfigured", { status: 500 }); }
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    if (!ipAllowed(ip, cfg.allowedCidrs)) return new Response(null, { status: 403 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

    // Role check on EVERY request (so every tool call): token epoch current and email still allowlisted.
    const props = (ctx as unknown as { props?: AuthProps }).props;
    if (!props?.email || props.epoch !== env.TOKEN_EPOCH) return unauthorized("Token revoked; sign in again.");
    if (!(await emailAllowed(env, props.email))) { console.warn(JSON.stringify({ evt: "mcp_denied", email: props.email })); return new Response(null, { status: 403 }); }

    // Audit log: email + method/tool only, never arguments or data.
    try {
      const body = await request.clone().json() as unknown;
      for (const m of Array.isArray(body) ? body : [body]) {
        const msg = m as { method?: string; params?: { name?: string } };
        if (msg?.method === "tools/call") console.log(JSON.stringify({ evt: "tool_call", email: props.email, tool: msg.params?.name }));
      }
    } catch { /* not JSON: the transport will reject it */ }

    const origin = (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
    const hcss = new HcssClient(cfg);
    const server = buildServer(cfg, hcss, env, origin);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } catch (e) {
      console.error("mcp error", (e as Error).message);
      return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, { status: 500 });
    }
  },
};

/** Everything that is not /mcp or an OAuth protocol endpoint. */
const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/authorize") return handleAuthorize(request, env);

    // One-time export download: fetched by the signed-in user's browser (not Anthropic), so no IP or token check.
    // The 256-bit random id is the capability; it is single-use and expires (EXPORT_TTL_SECONDS).
    if (request.method === "GET" && url.pathname.startsWith("/exports/")) {
      const id = url.pathname.slice("/exports/".length);
      if (!/^[a-f0-9]{64}$/.test(id)) return new Response("Not found", { status: 404 });
      const { value, metadata } = await env.EXPORTS.getWithMetadata<{ name: string; mime: string }>(`export:${id}`, "arrayBuffer");
      if (!value || !metadata) return new Response("Link expired or already used. Ask Claude to export again.", { status: 404 });
      await env.EXPORTS.delete(`export:${id}`);
      return new Response(value, { headers: { "Content-Type": metadata.mime, "Content-Disposition": `attachment; filename="${metadata.name}"`, "Cache-Control": "no-store" } });
    }
    return new Response(null, { status: 404 });
  },
};

// The provider needs the canonical resource URL, which comes from env, so build it on first request (per isolate).
let provider: OAuthProvider<Env> | undefined;
let providerOrigin = "";
function getProvider(origin: string): OAuthProvider<Env> {
  if (provider && providerOrigin === origin) return provider;
  providerOrigin = origin;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register", // dynamic client registration (Claude uses DCR)
    scopesSupported: ["heavyjob.read"],
    requiredScopes: ["heavyjob.read"],
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Schreiber HeavyJob (read-only)" },
    accessTokenTTL: ACCESS_TTL_S,
    refreshTokenTTL: REFRESH_TTL_S,
    // On every refresh: refuse if TOKEN_EPOCH was rotated or the email was removed from the allowlist.
    tokenExchangeCallback: async (o) => {
      const p = o.props as AuthProps | undefined;
      const env = o.env;
      if (!p?.email || p.epoch !== env.TOKEN_EPOCH || !(await emailAllowed(env, p.email))) {
        throw new OAuthError("invalid_grant", { description: "Access was revoked. Sign in again." });
      }
    },
  });
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");
    if (!env.TOKEN_EPOCH || !env.ACCESS_PASSWORD_HASH || !env.ALLOWED_USER_EMAIL) {
      console.error("TOKEN_EPOCH / ACCESS_PASSWORD_HASH / ALLOWED_USER_EMAIL secrets are not set.");
      return new Response("misconfigured", { status: 500 });
    }
    const origin = (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, "").toLowerCase();
    return getProvider(origin).fetch(request, env, ctx);
  },
  /** 09:00 UTC daily. Writes one meter_snapshots row per telematics unit. Does not go through user OAuth. */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      await captureTelematicsSnapshot(env, new Date(controller.scheduledTime));
    } catch (e) {
      console.error(JSON.stringify({ evt: "telematics_snapshot_failed", error: (e as Error).message }));
      throw e;
    }
  },
} satisfies ExportedHandler<Env>;
