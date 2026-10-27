# HCSS HeavyJob read-only MCP server

Remote Streamable HTTP MCP server for HCSS HeavyJob and HCSS Telematics, deployed on Cloudflare Workers as `schrex-hcss-heavyjob-mcp` (Schreiber Excavating). Version 0.2.0.

It is **read-only**. HCSS calls are limited to GET endpoints and documented read-only POST query endpoints. OAuth scopes are `heavyjob:read`, `timecards:read`, and `telematics:read`. `telematics:write` is never requested.

Sign-in is single-user OAuth: the person connecting enters an email and password on the connector's own page. Only the email in `ALLOWED_USER_EMAIL` can complete sign-in.

Secrets live only in Cloudflare (`wrangler secret put`). They are never committed. Names only:

- `HCSS_CLIENT_ID`
- `HCSS_CLIENT_SECRET`
- `ALLOWED_USER_EMAIL`
- `ACCESS_PASSWORD_HASH`
- `TOKEN_EPOCH`

Setup for the HeavyJob connector: [setup-guide.md](setup-guide.md). Telematics setup is below. Do not deploy until the placeholder D1 id in `server/wrangler.toml` is replaced.

## Tools

HeavyJob tools (`list_equipment`, `get_equipment_hours`, job cost, time cards, and the rest) are unchanged.

Telematics adds two tools. Both need the HCSS client to have **`telematics:read`** enabled in HCSS Credentials. If the token response does not include that scope, or `GET /telematics/api/v1/equipment` returns 403, the tool returns:

`The HCSS Client ID needs the telematics:read scope enabled in HCSS Credentials.`

### get_telematics_equipment

Last location and meter readings from `GET https://api.hcssapps.com/telematics/api/v1/equipment`.

The server follows `metadata.nextCursor` until every page is fetched (or the Workers subrequest cap, 45 by default, or 20,000 rows). It then applies `text`, `skip`, and `max_records`. `next_skip` is the cursor for the next reply. Totals cover the full filtered set, not just the page. `totals.unmatched_heavyjob` is how many of those units did not match a HeavyJob equipment code.

- Default is **registered only** (`isRegistered=true`). `include_unregistered: true` omits that parameter, so HCSS returns registered and unregistered units.
- `text` matches equipment code or description (case-insensitive contains).
- Compact rows: `equipment_code`, `description`, `make`, `model`, `last_latitude`, `last_longitude`, `last_location_at`, `odometer` `{value, unit, at}`, `engine_hours` `{value, at}`, `heavyjob_match`, `heavyjob_equipment_id`.
- Odometer `unit` is `miles` when HCSS sends `lastOdometerReadingInMiles`, otherwise `meters`.
- If those documented meter names are missing or not numeric, the row does not stop at a null. It adds `meter_fields_found`: the field names on that HCSS object (every key when the documented odometer/hour names are absent, otherwise the meter-like keys). The first live call shows the real names.
- `detail: true` returns the untouched HCSS record for each unit plus the mapped fields (`equipment_code`, location, `odometer`, `engine_hours`, HeavyJob match, and `meter_fields_found` when a meter value is missing). HCSS keys are not renamed or overwritten.
- The join uses the same trim and case-insensitive code compare as `list_equipment`. Inactive HeavyJob units match; deleted ones do not.

```json
{ "text": "crane", "max_records": 20 }
```

```json
{ "include_unregistered": true, "detail": true, "skip": 20 }
```

### get_telematics_usage

Miles and engine hours between two dates, from the daily D1 snapshots (not from a live HCSS history API).

**Usage starts accruing only after snapshots begin.** Until the cron has stored a day, this tool returns no rows. The first snapshot for a unit has no delta until an earlier snapshot exists.

For each unit and each snapshot date in the window, `miles_driven` is the odometer change versus the previous snapshot (the latest snapshot before `start_date` is the baseline) and `engine_hours` is the hour-meter change. Meter readings stored in meters are converted to miles (1609.344 meters per mile).

`group_by` is `equipment` (default, one row per unit) or `date` (one row per day). `equipment_code` keeps a single unit. `skip` / `max_records` / `next_skip` page the grouped rows. Totals cover every unit-day in the window.

Flags on each row:

| Flag | Meaning |
|---|---|
| `no_baseline` | No earlier snapshot, so that day has no delta. |
| `gap` | Previous snapshot is more than one calendar day earlier. The delta is kept and attributed to the later day. |
| `negative_delta` | Odometer or hour meter went backwards (reset or replacement). Flagged and **not counted**. |
| `zero_jump` | The reading and its timestamp are identical to the previous snapshot (the device did not report a new reading). A parked unit with a newer timestamp is not flagged. |
| `implausible_jump` | More than 1000 miles or 24 engine hours per day spanned. Flagged and **not counted**. |
| `unit_change` | Odometer unit changed between snapshots. The delta is still converted and counted. |
| `unknown_unit` | Odometer unit was neither `miles` nor `meters`. That delta is not counted. |

Counted totals omit negative and implausible deltas. Those signed values are returned as `uncounted_miles` and `uncounted_engine_hours`. Changes smaller than 0.0001 miles or hours are treated as zero so unit conversion is not reported as a reset.

```json
{ "start_date": "2026-10-01", "end_date": "2026-10-07", "group_by": "equipment" }
```

```json
{ "start_date": "2026-10-01", "end_date": "2026-10-07", "equipment_code": "T-12", "group_by": "date" }
```

## Scope fallback

`HCSS_SCOPE` is `heavyjob:read timecards:read telematics:read`. HCSS rejects the **entire** token request when any requested scope is not on the client. So the worker does not send one scope string for every call:

1. HeavyJob calls try the configured scope. If the token endpoint returns `invalid_scope`, they immediately retry with `heavyjob:read timecards:read` only and keep using that for 10 minutes. Existing tools keep working.
2. Telematics calls reuse that token only when the token response grants `telematics:read` (or omits `scope`, which in OAuth means the requested scopes were granted). Otherwise they request a **separate** token whose scope is exactly `telematics:read`.
3. `invalid_scope` on that separate request, a granted scope that does not list `telematics:read`, or HTTP 403 from the equipment endpoint all return the error sentence above. They are not swallowed.

`telematics:write` is rejected by config if it ever appears in `HCSS_SCOPE`.

## Telematics setup

Run these from `server/` after an HCSS admin enables `telematics:read` on the existing client (not `telematics:write`). Replace the placeholder `database_id` before `wrangler deploy`. This repo does not deploy or call the live API.

```bash
npx wrangler d1 create schrex-telematics
```

Paste the printed `database_id` into `server/wrangler.toml`, replacing `00000000-0000-0000-0000-000000000000`.

```bash
npx wrangler d1 migrations apply schrex-telematics --remote
```

Optional, for `wrangler dev` only:

```bash
npx wrangler d1 migrations apply schrex-telematics --local
```

Then deploy when you are ready (not part of this change):

```bash
npx wrangler deploy
```

The cron trigger is `0 9 * * *` (09:00 UTC daily). It fetches every telematics unit (registered and unregistered), paging with `nextCursor`, and upserts that UTC date into `meter_snapshots`. A missing `telematics:read` scope is logged and not retried all day. Other HCSS failures are thrown so Cloudflare retries them.

Free-plan limits that apply: 5 cron triggers per account, 10 ms CPU per cron invocation, 50 subrequests per invocation (this worker budgets 45), D1 5 million rows read / 100,000 rows written per day and 5 GB. A very large equipment payload can hit the 10 ms CPU cap (Error 1102) on the cron the same way a large HeavyJob page can. HCSS allows 100 requests per minute per company, shared with the nightly sync and the HeavyBid connector; paging is sequential.

Field names for the equipment payload are the published Telematics OpenAPI schema `ApiEquipmentRead` (`https://developer.hcssapps.com/hcss/reference/get_api-v1-equipment-1`). They have not been checked against a live response.
