# HCSS HeavyJob connector for Claude Team: design (v0.2, 2026-10-19)

**v0.2 change:** single-user access via OAuth 2.1 sign-in (see §User auth). The secret URL path is gone; the URL is now `https://schrex-hcss-heavyjob-mcp.schrex.workers.dev/mcp`. Claude connector auth = OAuth, not "No sign in".

Mirrors the HeavyBid connector (../hcss-mcp, incl. hcss-fixes 1-4): Cloudflare Workers **Free** plan, stateless Streamable HTTP MCP
(`WebStandardStreamableHTTPServerTransport`, JSON responses, no Durable Objects), Anthropic IP allowlist `160.79.104.0/21` on `/mcp`, `/healthz`, one-time KV export links.
**Unlike HeavyBid, only allowlisted users (ALLOWED_USER_EMAIL) can use it**, even if the Team Owner adds it org-wide.
**Read-only:** GETs plus documented read-only POST *query* endpoints, enforced by an allowlist in `hcss.ts` (`READ_POSTS`); `HCSS_SCOPE` refuses `:write`/admin.

Source: HCSS OpenAPI pages on developer.hcssapps.com (fetched 2026-10-19; HeavyJob spec `servers: https://api.hcssapps.com/heavyjob`). No endpoint is invented.

## Auth (VERIFIED from docs unless noted)
- Token: `POST https://api.hcssapps.com/identity/connect/token`, client_credentials, form body, UA `Mozilla/5.0 SchreiberMCP/0.1`, Basic-auth fallback, cached 1 h (same code as HeavyBid).
- Scopes: **`heavyjob:read`** (every HeavyJob endpoint below except time cards), **`timecards:read`** (`/api/v1/timeCardInfo`, `/api/v1/timeCards/{id}`), and **`telematics:read`** (Telematics `GET /api/v1/equipment` only). Never `telematics:write`. Docs: https://developer.hcssapps.com/hcss/docs/api-scopes and the Telematics operation security description ("telematics:read or telematics:write").
- HCSS rejects a token request when any requested scope is missing (`invalid_scope` on the whole request). HeavyJob calls try the combined scope, then fall back to `heavyjob:read timecards:read` so existing tools keep working. Telematics calls use that token only when the response grants `telematics:read`; otherwise they request a separate `telematics:read` token. A missing grant or a 403 returns a fixed tool error and is not swallowed.
- Use a **new dedicated API client** with only `heavyjob:read timecards:read telematics:read`. Can be the HeavyBid client if an admin adds these scopes, but separate is safer (UNVERIFIED whether the license allows another client).

## User auth (Claude to connector): OAuth 2.1, one allowed user
Library: `@cloudflare/workers-oauth-provider` 1.2.3 (Cloudflare's official; API checked against its bundled README/docs and .d.ts). One Worker plays both roles (`OAuthProvider`, `apiRoute: /mcp`).
- Endpoints (served by the library): `/.well-known/oauth-protected-resource/mcp` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414), `/register` (dynamic client registration, RFC 7591), `/token` (code + PKCE, refresh rotation, revocation). CIMD clients also accepted (`global_fetch_strictly_public` flag). Unauthenticated `/mcp` → `401` with `WWW-Authenticate: Bearer … resource_metadata=…`, which is how Claude discovers sign-in.
- `/authorize` (ours, `src/auth.ts`): one page showing the client name (escaped; DCR names are self-asserted), redirect host, and **email + password** fields. Uses the library's `beginConsent`/`approveConsent` (browser-bound, single-use handle, no framing). Email must be in `ALLOWED_USER_EMAIL` (comma-separated; SHA-256 + constant-time compare against every entry). Password checked with **PBKDF2-HMAC-SHA256** against `ACCESS_PASSWORD_HASH` (`pbkdf2$<iter>$<salt>$<hash>`), constant-time compare. Plaintext never stored or logged.
- **PBKDF2 iterations = 30,000.** Workers WebCrypto caps PBKDF2 at 100,000 iterations, and the free plan allows 10 ms CPU per request. Measured on the box (Node, same algorithm): 30k ≈ 5 ms, 50k ≈ 8 ms, 100k ≈ 16 ms. 30k leaves headroom for the rest of the login request; Cloudflare's CPU speed is UNVERIFIED, so if a login ever fails with Error 1102, regenerate the hash with 20,000. Strength comes mainly from the password: use a random 20+ character one (the hash is also only ever in Cloudflare secrets, not exposed).
- **Brute-force throttle (KV `OAUTH_KV`):** 5 failed logins per IP per 15 min → that IP locked; 20 failures from anywhere per 15 min → login locked for everyone for 15 min (protects against distributed guessing). KV is eventually consistent, so counts are approximate across Cloudflare locations (UNVERIFIED how much). Each failure = 2 KV writes (free: 1,000/day).
- **Tokens:** access token 1 h, refresh tokens rotate; the grant lives 90 days from sign-in, then sign in again. Tokens are stored only as hashes; `props` ({email, epoch}) are encrypted by the library.
- **Revoke everything:** change `TOKEN_EPOCH`. `/mcp` rejects tokens whose epoch differs (401 → Claude asks to sign in again) and `tokenExchangeCallback` refuses refreshes (`invalid_grant`). Removing an email from `ALLOWED_USER_EMAIL` also blocks it at the next request and refresh.
- **Role check on every MCP request** (therefore every tool call): epoch current + email allowlisted, before any HCSS call. Audit log via `console.log`: `{evt:"tool_call", email, tool}` only, never arguments or data; also `login_ok` (email), `login_failed`/`login_locked` (IP only, never the typed email/password), `mcp_denied`.
- **IP allowlist** stays on `/mcp` (defense in depth). `/authorize` is opened by the user's browser and `/exports/*` downloads too, so neither is IP-limited. Token/register endpoints are called by Claude's backend; left open (UNVERIFIED whether every Claude surface calls them from 160.79.104.0/21).
- **Secret path dropped.** With OAuth, a leaked URL gives nothing without the password, and the IP allowlist still applies. Keeping a secret path would only break OAuth discovery URLs (the resource is `<origin>/mcp`). Export links are still unguessable (256-bit, single-use, 15 min) under `/exports/<id>`.
- **If the Team Owner adds it org-wide:** everyone sees "Schreiber HeavyJob" in their connectors and can click Connect, but the sign-in page rejects any email not in `ALLOWED_USER_EMAIL` (and the password), so they can't use it. Recommend the allowed user adds it themselves, or the Owner adds it and tells others to ignore it.

## Tools
| Tool | HCSS endpoint | Doc page | Status |
|---|---|---|---|
| list_business_units | GET /api/v1/businessUnits | https://developer.hcssapps.com/hcss/reference/businessunitcontroller_getbusinessunitsasync | VERIFIED |
| search_jobs | GET /api/v1/jobs?businessUnitId&jobStatus (text/estimate filter in server) | https://developer.hcssapps.com/hcss/reference/jobcontroller_getjobsv1async | VERIFIED |
| get_job | jobs list (resolve code) + POST /api/v1/jobs/advanced {jobIds,isIncludeHBCodeList} + costCodes count | https://developer.hcssapps.com/hcss/reference/jobcontroller_getjobsadvancedasync | VERIFIED |
| get_cost_codes | GET /api/v2/costCodes?jobId&businessUnitId&isDeleted=false (cursor) | https://developer.hcssapps.com/hcss/reference/costcodecontroller_getcostcodesv2async | VERIFIED; that quantity/laborHours/*Dollars are the **budget** is inferred (spec just says "The quantity", "The labor hours") |
| list_time_cards | GET /api/v1/timeCardInfo (jobId, foremanId, employeeId, startDate, endDate, isApproved, businessUnitId; cursor) | https://developer.hcssapps.com/hcss/reference/timecardcontroller_gettimecardinfoasync | VERIFIED (timecards:read) |
| get_time_card | GET /api/v1/timeCards/{id} | https://developer.hcssapps.com/hcss/reference/timecardcontroller_gettimecardv1async | VERIFIED (timecards:read) |
| get_employee_hours | POST /api/v1/hours/employees | https://developer.hcssapps.com/hcss/reference/hourscontroller_getemployeehoursasync | VERIFIED |
| get_equipment_hours | POST /api/v1/hours/equipment | https://developer.hcssapps.com/hcss/reference/hourscontroller_getequipmenthoursasync | VERIFIED |
| get_cost_code_progress | POST /api/v1/costCode/progress/advancedRequest (jobId required) + costCodes for code/unit/budget | https://developer.hcssapps.com/hcss/reference/costcodeprogresscontroller_getcostcodeprogressasync | VERIFIED |
| get_diaries | POST /api/v1/diaries/search (businessUnitId required) | https://developer.hcssapps.com/hcss/reference/diarycontroller_querydiariesasync | VERIFIED |
| list_employees | GET /api/v1/businessUnits/{bu}/employees?isActive&isDeleted&isForeman | https://developer.hcssapps.com/hcss/reference/employeecontroller_getemployeesasync | VERIFIED |
| list_equipment | GET /api/v1/businessUnits/{bu}/equipment?isActive&isDeleted | https://developer.hcssapps.com/hcss/reference/equipmentcontroller_getequipmentasync | VERIFIED |
| get_telematics_equipment | GET https://api.hcssapps.com/telematics/api/v1/equipment?limit&cursor&isRegistered | https://developer.hcssapps.com/hcss/reference/get_api-v1-equipment-1 | VERIFIED from the published OpenAPI (not a live call). Compact mapping and the HeavyJob code join are ours. `detail:true` returns the raw record plus mapped fields. `meter_fields_found` lists payload keys when a meter value is missing. |
| get_telematics_usage | D1 `meter_snapshots` filled by the 09:00 UTC cron from the same equipment list | | Derived. Deltas, flags, and thresholds are computed here. Usage is empty until snapshots exist. |
| get_job_cost_summary | costCodes (budget) + POST /api/v1/jobCostsToDate/search (to date) **or** POST /api/v1/jobCosts/advancedRequest (date range) | https://developer.hcssapps.com/hcss/reference/costcontroller_queryjobcoststodateasync , https://developer.hcssapps.com/hcss/reference/costcontroller_queryjobcostsasync | endpoints VERIFIED; join + derived columns UNVERIFIED vs a HeavyJob Cost Report |
| export_job_cost_summary | same as above → xlsx/csv in KV, single-use link, 15 min | | same |

Documented but not exposed: forecasts (`/api/v1/forecastInfo`), cost code transactions, pay items, materials installed/received, change orders, purchase orders, attachments. All write endpoints (cost adjustments, upserts, `PUT timeCards`, diary upsert POST) are deliberately excluded and blocked by `READ_POSTS`.

## Job cost summary (field vs bid)
Per cost code: budget vs actual qty, % complete, budget/actual/earned MH (earned = budget MH × actual qty / budget qty), MH over/under, MH/unit and units/MH both ways,
equipment hours, labor/equipment/material/sub $, supply (budget only), trucking (actual only), totals, and HeavyBid tie-in (`heavyBidEstimateCode`, `historicalBiditem`, `historicalActivityCode`).
- `jobCostsToDate/search` returns rows per cost code **per foreman** (it carries a `foreman` object); the server sums them per cost code. UNVERIFIED whether HCSS already aggregates when no foreman filter is sent; summing is correct either way.
- Custom cost type actuals are not in these responses, so `actual_total` excludes them while `budget_total` includes custom budgets (labelled). 
- UNVERIFIED: whether "actual" matches HeavyJob's Cost Report exactly (approved-only vs all time cards, cost adjustments). **Validate once:** pull the HeavyJob Cost Report for one job and compare MH, qty and $ per cost code with export_job_cost_summary.

## HeavyBid lessons applied from day one
Trimmed codes everywhere (jobs, cost codes, employees, equipment); natural sort (Intl.Collator numeric); compact default records with `detail`/`fields`;
`skip`/`next_skip` paging on every list with totals computed over the full set and labelled `scope` (`partial` when a cap is hit); money 2 dp, quantities/hours 4 dp (float-noise replacer);
strict `YYYY-MM-DD` validation naming the field (and start ≤ end); HCSS 4xx bodies passed through (500 chars); 403 names the missing scope; job/cost-code not found → hint with close matches / sample codes;
auto-select the single real business unit (ignore all-zero placeholder, dedupe by code); jobs/cost codes accepted by **code**, not just GUID.

## Free-plan limits and HCSS rate limit
- **Subrequests (50; budget 45):** typical tool = token 1 (cached) + business units 1 (once per isolate) + jobs 1 + data pages. Pages are `limit=1000` (HCSS_PAGE_SIZE); cap 20,000 rows per pull (≤20 pages), plus a BudgetError past 45. Worst case: job summary on a huge job with date range ≈ 1+1+1+N(cost code pages)+M(cost rows/1000). Daily rows per foreman per cost code for a long range on a big job is the likeliest to hit the cap → `scope: partial`; narrow the range or use job-to-date (much fewer rows).
- **CPU (10 ms):** biggest risk is JSON parsing of large pages: `hours/employees` over a month on a big job (nested hoursDetails, meal/break fields) and `jobCosts/advancedRequest` over a long range. Mitigations: compact output, grouping by default, xlsx level-0 zip. If Error 1102 appears, shorten ranges or move to Workers Paid ($5/mo).
- **HCSS:** 100 req/min + 20 concurrent per company, shared with Zach's 03:00 ET nightly sync, the HeavyBid connector, and the 09:00 UTC telematics snapshot (https://developer.hcssapps.com/hcss/docs/rate-limits). Sequential paging, Retry-After/backoff (≤4 tries), 5-min isolate cache.
- **Cron (free plan):** 5 cron triggers per account, 10 ms CPU per cron. The telematics cron is `0 9 * * *` UTC. D1 free tier: 5M rows read/day, 100k rows written/day, 5 GB. Placeholder `database_id` in wrangler.toml must be replaced before deploy (`npx wrangler d1 create schrex-telematics`, then `npx wrangler d1 migrations apply schrex-telematics --remote`).

## Open questions
0. Who is the one allowed user (email)? Does Claude Team let a member add a personal custom connector, or must the Owner add it org-wide? (UNVERIFIED for Schreiber's plan.)
1. New HCSS API client with `heavyjob:read timecards:read` (who creates it?).
2. Business unit id (or rely on auto-pick).
3. (Resolved in v0.2: only allowlisted users can use the connector.)
4. Ryan/PM to validate the cost summary against one HeavyJob Cost Report.
