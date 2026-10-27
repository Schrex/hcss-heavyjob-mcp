import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { allowedEmails, type Env } from "./config.js";

/** What every access token carries (encrypted by the library; visible to the /mcp handler as ctx.props). */
export interface AuthProps { email: string; epoch: string }

const enc = new TextEncoder();
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Constant-time byte compare (length leak only). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
/** Constant-time check that email is in the allowlist (compares SHA-256 digests, checks every entry). */
export async function emailAllowed(env: Env, email: string): Promise<boolean> {
  const list = allowedEmails(env);
  if (!list.length || !email) return false;
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s.trim().toLowerCase())));
  const mine = await h(email);
  let ok = false;
  for (const e of list) ok = ctEqual(mine, await h(e)) || ok;
  return ok;
}

/**
 * ACCESS_PASSWORD_HASH format: pbkdf2$<iterations>$<salt base64>$<hash base64> (PBKDF2-HMAC-SHA256, 32-byte hash).
 * Iterations are capped at 100,000 (Workers WebCrypto PBKDF2 limit) and the recommended value is 30,000 (~5 ms on a fast x86 core) to stay inside the
 * free plan's 10 ms CPU budget for the login request (only the login POST pays this cost).
 */
export async function passwordOk(env: Env, password: string): Promise<boolean> {
  const parts = (env.ACCESS_PASSWORD_HASH ?? "").trim().split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") throw new Error("ACCESS_PASSWORD_HASH is not in pbkdf2$iter$salt$hash format.");
  const iter = Number(parts[1]);
  if (!Number.isInteger(iter) || iter < 10_000 || iter > 100_000) throw new Error("ACCESS_PASSWORD_HASH iterations must be 10,000-100,000.");
  const salt = b64d(parts[2]), want = b64d(parts[3]);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const got = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, want.length * 8));
  return ctEqual(got, want);
}

// ---- brute-force throttle (KV; eventually consistent, so limits are approximate across locations) ----
const WINDOW_S = 15 * 60;
const PER_IP = 5;     // 5 failures per IP per 15 min -> locked
const GLOBAL = 20;    // 20 failures from anywhere per 15 min -> login locked for everyone
const keys = (ip: string) => [`authfail:ip:${ip || "unknown"}`, "authfail:all"] as const;
export async function lockedOut(env: Env, ip: string): Promise<boolean> {
  const [k1, k2] = keys(ip);
  const [a, b] = await Promise.all([env.OAUTH_KV.get(k1), env.OAUTH_KV.get(k2)]);
  return Number(a ?? 0) >= PER_IP || Number(b ?? 0) >= GLOBAL;
}
export async function recordFailure(env: Env, ip: string): Promise<void> {
  // KV free plan: 1,000 writes/day; each failure costs 2 writes, and lockout stops further writes.
  for (const k of keys(ip)) {
    const n = Number((await env.OAUTH_KV.get(k)) ?? 0) + 1;
    await env.OAUTH_KV.put(k, String(n), { expirationTtl: WINDOW_S });
  }
}

// ---- login + consent page ----
const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function page(d: ConsentDescription, handle: string, error?: string): string {
  const name = esc(d.clientName);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in: Schreiber HeavyJob</title>
<style>body{font:16px system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#222}input{width:100%;padding:.5rem;margin:.25rem 0 1rem;box-sizing:border-box}button{padding:.6rem 1.2rem;margin-right:.5rem}.err{color:#b00020}.small{color:#555;font-size:.9rem}</style>
<h1>Schreiber HeavyJob</h1>
<p><strong>${name}</strong> wants read-only access to HeavyJob and telematics data.${d.clientDomain ? ` Published by <strong>${esc(d.clientDomain)}</strong>.` : " (This app registered itself; its name is not verified.)"}</p>
<p class="small">Access will be sent to <strong>${esc(d.redirectHost)}</strong>.${d.redirectIsLoopback ? " <strong>This sends access to an app on your computer.</strong>" : ""} Only approved users can sign in.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${esc(handle)}">
<label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button name="decision" value="approve">Sign in and allow</button><button name="decision" value="deny" formnovalidate>Deny</button>
</form></html>`;
}
const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers });
};
const text = (msg: string, status = 400) => new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** GET/POST /authorize. The library validated the OAuth request; we sign the user in and record consent. */
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  try {
    if (request.method === "GET") {
      const req = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(req);
      const consent = await oauth.beginConsent(req);
      return html(page(details, consent.handle), 200, consent.headers);
    }
    if (request.method !== "POST") return text("Method not allowed", 405);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    // Re-render needs the description; recover it from the original query string (same request as GET).
    const reRender = async (msg: string, status: number) => {
      try { const req = await oauth.parseAuthRequest(request); return html(page(await oauth.describeConsent(req), handle, msg), status); }
      catch { return text(msg + " Go back to Claude and start the sign-in again.", status); }
    };
    if (await lockedOut(env, ip)) {
      console.warn(JSON.stringify({ evt: "login_locked", ip }));
      return reRender("Too many failed sign-ins. Try again in 15 minutes.", 429);
    }
    const email = String(form.get("email") ?? "").trim().toLowerCase();
    const password = String(form.get("password") ?? "");
    const ok = (await emailAllowed(env, email)) && password.length > 0 && password.length <= 256 && (await passwordOk(env, password));
    if (!ok) {
      await recordFailure(env, ip);
      console.warn(JSON.stringify({ evt: "login_failed", ip })); // never log the email or password typed
      return reRender("Email or password is not correct.", 401);
    }
    const approved = await oauth.approveConsent(request, handle, {});
    const props: AuthProps = { email, epoch: env.TOKEN_EPOCH };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, userId: encodeURIComponent(email), metadata: { signedInAt: new Date().toISOString() },
      scope: approved.request.scope, props,
    });
    console.log(JSON.stringify({ evt: "login_ok", email }));
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return text(`${e.description} Go back to Claude and start the sign-in again.`);
    if (e instanceof CimdFetchError) return text("This app could not be verified.");
    throw e;
  }
}
