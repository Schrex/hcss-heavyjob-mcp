# HeavyJob connector for Claude: setup guide (v0.2, one allowed user)

Adds a "Schreiber HeavyJob" connector. It only **reads** HeavyJob (jobs, cost codes and budgets, time cards, hours, quantities, diaries, budget vs actual) and HCSS Telematics (equipment location and meter readings).
Only the person(s) in `ALLOWED_USER_EMAIL` can sign in. If the Team Owner adds it org-wide, others will see it but can't sign in.

## Part 1: Sumanth, one time (Mac Terminal, Node 22+)
Before you start: ask an HCSS admin for a new API client with only `heavyjob:read`, `timecards:read`, and `telematics:read`. Do not enable `telematics:write`. Pick a random password of 20+ characters for the connector user and give it to them privately.

Run these one at a time:
1. `cd ~/heavyjob-mcp/server`
2. `npm install`
3. `npx wrangler kv namespace create EXPORTS` → paste the printed id into `wrangler.toml` (replace `REPLACE_WITH_EXPORTS_KV_ID`)
4. `npx wrangler kv namespace create OAUTH_KV` → paste the id into `wrangler.toml` (replace `REPLACE_WITH_OAUTH_KV_ID`)
5. `npx wrangler secret put HCSS_CLIENT_ID`
6. `npx wrangler secret put HCSS_CLIENT_SECRET`
7. `npx wrangler secret put ALLOWED_USER_EMAIL` (type the allowed email, e.g. `ryan@schrex.com`; several = comma-separated)
8. Set the password hash (it asks for the password, hidden, and stores only the hash):
   `python3 -c 'import hashlib,os,base64,getpass;s=os.urandom(16);p=getpass.getpass("Connector password: ");print("pbkdf2$30000$"+base64.b64encode(s).decode()+"$"+base64.b64encode(hashlib.pbkdf2_hmac("sha256",p.encode(),s,30000)).decode())' | npx wrangler secret put ACCESS_PASSWORD_HASH`
9. `openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH`
10. Optional: `npx wrangler secret put HCSS_BUSINESS_UNIT_ID` (skip it and the server picks the only real unit)
11. Telematics database (required before deploy; the id in `wrangler.toml` is a placeholder):
    `npx wrangler d1 create schrex-telematics` → paste the printed id over `database_id` under `TELEMATICS_DB`
    `npx wrangler d1 migrations apply schrex-telematics --remote`
12. `npx wrangler deploy`
13. Check: open `https://schrex-hcss-heavyjob-mcp.schrex.workers.dev/healthz` → `ok`

The connector URL is `https://schrex-hcss-heavyjob-mcp.schrex.workers.dev/mcp` (no secret in it any more). If your workers.dev subdomain isn't `schrex`, change `PUBLIC_ORIGIN` in `wrangler.toml` before deploying.

## Part 2: add the connector in Claude
Settings → Connectors → **Add custom connector**. Name `Schreiber HeavyJob`, URL above. Leave the OAuth Client ID/Secret fields empty (Claude registers itself). Save.
(If only the Team Owner can add custom connectors, the Owner adds it; everyone sees it, but only the allowed user can sign in.)

## Part 3: the allowed user signs in (once every 14 days)
1. Settings → Connectors → Schreiber HeavyJob → **Connect**.
2. A browser page "Schreiber HeavyJob" opens: it shows that Claude wants read-only access and where access is sent (claude.ai).
3. Enter your email and the connector password → **Sign in and allow**. You're sent back to Claude, connected.
4. Switch the connector on in a chat and ask, e.g. "Budget vs actual man-hours per cost code for job 2614, worst overruns first."

Five wrong passwords lock sign-in from that network for 15 minutes.

## Admin tasks
- **Sign everyone out / revoke all tokens:** `openssl rand -hex 16 | npx wrangler secret put TOKEN_EPOCH`
- **Change the password:** rerun step 8 (existing sign-ins keep working until you also rotate TOKEN_EPOCH).
- **Add/remove a user:** rerun step 7 with the new list (a removed user is blocked at their next request).
- Logs (Cloudflare dashboard → Workers → schrex-hcss-heavyjob-mcp → Logs) show who called which tool, never the data.

## Good to know
- Dates are always `YYYY-MM-DD`. Jobs and cost codes can be given by code.
- "403 Forbidden" from HCSS on HeavyJob = the API client is missing `heavyjob:read` or `timecards:read`.
- Telematics tools say `The HCSS Client ID needs the telematics:read scope enabled in HCSS Credentials.` when that scope is missing. HeavyJob tools still work in that case.
- Miles and engine-hour history in `get_telematics_usage` start only after the daily 09:00 UTC snapshot has run. See the README.
- HCSS allows the whole company 100 calls/min, shared with Zach's nightly sync and the HeavyBid connector.
- "Exceeded resource limits" on a big job = free-plan CPU cap: use a shorter date range.
