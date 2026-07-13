# API Reference

## Base URL
Internal only, behind Basic Auth. No public base URL — access via the deployed dashboard
(`https://<cloudfront-domain>/api/...`) or locally at `http://localhost:8080/api/...`.

## Authentication
HTTP Basic Auth, applied globally by Express middleware in `dashboard/server/index.js`
(`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` env vars). Auth is skipped entirely if both env
vars are unset (local dev) and always skipped for `GET /healthz`.

## Common Query Parameters
Every data route below accepts these (parsed by `parseRange()` / `route()` in `index.js`).
`POST /api/chat` (see the Chat section) is the one exception — it takes a JSON body instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | ISO 8601 datetime | No | Range start. Default: `to - 2 days` (workshop default). For uniq/existence endpoints (`overview/active-users`, `adoption/levels`, `adoption/timeseries`, and the leaderboard's active-days count), `from` is rounded down to the containing hour server-side, so up to 59 minutes of activity just before `from` can be included — a deliberate rollup-grain trade-off, negligible on multi-day ranges but noticeable on narrow (sub-hour) custom ranges |
| `to` | ISO 8601 datetime | No | Range end. Default: now |
| `group` | string (`bedrock`\|`enterprise`) | No | Filter by inferred experiment group. `unknown` sessions are excluded from group-scoped queries by default (~11% of sessions have no bedrock/enterprise signal) — a few "totals" endpoints (`active-users`, `adoption/levels`, `adoption/timeseries`, `cost/summary`, `overview/kpi`) include them instead since they report org-wide totals, not an A/B split |
| `user` | string | No | Filter by user email (partial match) |
| `model` | string | No | Filter by model name (partial match, normalized) |
| `intervalHours` | number | No | Bucket size for timeseries endpoints (fractional hours like `0.25` = 15 min for chart drag-zoom, 1 = hourly, 24 = daily, 168 = weekly). Only honored by endpoints marked *timeseries* below. Requests with `intervalHours < 1` are clamped to `1` server-side if the `from`/`to` span exceeds 4 hours (minute-bucket queries fall back to scanning the raw table, which is only cheap for narrow ranges). |
| `email` | string | Only for `GET /api/users/{daily,decisions-by-tool,heatmap}` | Exact-match user email for the per-user drilldown endpoints. Not a general filter — ignored by every other route. |

For the three drilldown endpoints (`daily`/`decisions-by-tool`/`heatmap`), `group` is honored
and optional: omitted, they return the user's full activity across all sessions (including
`unknown`); passed, they scope to that session group — used by the Users page drawer, which
now opens from a per-user-x-group leaderboard row and passes that row's `group` so the
drilldown matches the row's own numbers.

## Endpoints

All data endpoints below are `GET`, take no request body, and return JSON (array of rows, or
a single object for snapshot endpoints). `POST /api/chat` is the sole exception (JSON body,
SSE response) — see the Chat section. Errors return `{"error": "<message>"}` with HTTP 500.

### Overview
| Path | Returns |
|---|---|
| `GET /api/overview/kpi` | Group-level session/user/commit/PR/token/LOC summary |
| `GET /api/overview/active-users` | Ungrouped unique active user count (includes `unknown` sessions — a "totals" endpoint, see `group` param above) |
| `GET /api/overview/tokens-timeseries` | *timeseries* — token usage per group over time |
| `GET /api/overview/cache-efficiency` | Cache read ratio (`cache_read_ratio`) + token-type breakdown per group: `cache_read`, `input_side` (input + cacheRead + cacheCreation, the ratio's denominator), `uncached_input`, `cache_write`, `output_tokens` |
| `GET /api/overview/model-distribution` | Token distribution by group x model |

### Productivity
| Path | Returns |
|---|---|
| `GET /api/productivity/normalized` | LOC / commits per million tokens, per group |
| `GET /api/productivity/decisions` | Accept/reject counts per group |
| `GET /api/productivity/decisions-by-tool` | Accept/reject counts per group x tool |
| `GET /api/productivity/active-time` | *timeseries* — active-time seconds per group |
| `GET /api/productivity/agenticness` | *timeseries* — tool calls per prompt per group |
| `GET /api/productivity/engagement` | *timeseries* — daily users/sessions/PRs |
| `GET /api/productivity/loc-timeseries` | *timeseries* — lines added/removed per group |

### Usage
| Path | Returns |
|---|---|
| `GET /api/usage/tool-mcp` | Tool/MCP invocation counts |
| `GET /api/usage/skills` | Skill invocation counts (subject to OTel redaction of third-party skill names) |
| `GET /api/usage/connectors` | MCP connector usage |

### Users
| Path | Returns |
|---|---|
| `GET /api/users/leaderboard` | Per-user x group metrics + productivity score (real session group, not majority-vote — a user active in both groups gets one row per group). Also includes `user_active_days`: group-agnostic distinct active days, identical across a straddling user's group rows — used to recompute an org-wide (ungrouped) productivity score without double-counting days a user was active in both groups |
| `GET /api/users/tools` | Per-user x group tool usage |
| `GET /api/users/skills` | Per-user x group skill usage |
| `GET /api/users/cost-efficiency` | Per-user x group `$/LOC`, `$/commit` |
| `GET /api/users/daily` | *timeseries* — daily sessions/LOC/tokens/commits for one user. **Requires `email` param** (exact match; not filtered by `user`/`model`). Optional `group` scopes to that session group. Not covered by the cache warmer. |
| `GET /api/users/decisions-by-tool` | Accept/reject counts per tool for one user. **Requires `email` param.** Optional `group` scopes to that session group. Not covered by the cache warmer. |
| `GET /api/users/heatmap` | GitHub-style daily session-count heatmap, last 91 days from `to`. **Requires `email` param**; ignores `from`. Optional `group` scopes to that session group. Not covered by the cache warmer. |

### Cost
| Path | Returns |
|---|---|
| `GET /api/cost/summary` | Group-level computed + reported cost, token breakdown |
| `GET /api/cost/by-model` | Cost/tokens per group x model |
| `GET /api/cost/by-user-model` | Cost/tokens per user x group x model (real session group, not majority-vote) |
| `GET /api/cost/by-model-daily` | *timeseries* — cost per group x model over time |
| `GET /api/cost/by-model-compare` | Current vs. previous equal-length period, per model |
| `GET /api/cost/tiers` | Cost broken down by token tier (uncachedInput/cacheRead/cacheWrite/output), split by group: `{"bedrock": {...}, "enterprise": {...}}` |

### Adoption
| Path | Returns |
|---|---|
| `GET /api/adoption/levels` | DAU/WAU/MAU snapshot + total members |
| `GET /api/adoption/timeseries` | *timeseries* — DAU/WAU/MAU rolling window per day |

### Chat (AI Assistant)
| Path | Returns |
|---|---|
| `POST /api/chat` | Server-Sent Events stream. Body: `{"messages": [{"role": "user"\|"assistant", "content": "..."}]}`. Backed by Bedrock; internally allowed to run read-only ClickHouse SQL via a sandboxed tool — see `sanitizeSql()` in `dashboard/server/chat.js`. |

## Error Codes

| Code | Description |
|------|-------------|
| 401 | Unauthorized — missing/invalid Basic Auth credentials (only when `BASIC_AUTH_*` is configured) |
| 500 | Internal Server Error — usually a ClickHouse query error; check server logs for the underlying `ClickHouseError` |

## Rate Limits
None enforced at the application layer. The dashboard is used by a small workshop cohort;
if this changes, add rate limiting before removing this note.
