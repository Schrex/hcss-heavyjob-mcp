# HCSS HeavyJob read-only MCP server

Remote Streamable HTTP MCP server for HCSS HeavyJob, deployed on Cloudflare Workers as `schrex-hcss-heavyjob-mcp` (Schreiber Excavating).

It is **read-only**. HCSS calls are limited to GET endpoints and documented read-only POST query endpoints. OAuth scopes are `heavyjob:read` and `timecards:read`.

Sign-in is single-user OAuth: the person connecting enters an email and password on the connector's own page. Only the email in `ALLOWED_USER_EMAIL` can complete sign-in.

Secrets live only in Cloudflare (`wrangler secret put`). They are never committed. Names only:

- `HCSS_CLIENT_ID`
- `HCSS_CLIENT_SECRET`
- `ALLOWED_USER_EMAIL`
- `ACCESS_PASSWORD_HASH`
- `TOKEN_EPOCH`

Setup: [setup-guide.md](setup-guide.md).
