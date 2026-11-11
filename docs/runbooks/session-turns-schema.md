# Runbook: Session turn/request key sets

## Contract

Migration 010 adds `session_turns_v1` and its ingestion view `session_turns_v1_mv`. Per
`(Client, SessionId, hour, Kind, Model, UserIdentity)` the table keeps an exact
`uniqExact` state of 64-bit key hashes, so turns and API requests can be counted per
session and hour without scanning `otel_logs`. States union: a repeated delivery, a
repeated backfill or an overlap with the live view cannot change a count. Hourly counts
must be merged (`uniqExactMerge(Keys)`) over the whole window, never summed across hours.

| Client | Source events | `SessionId` | `Kind` | `Model` | Key |
|---|---|---|---|---|---|
| `claude` | `user_prompt`, `claude_code.user_prompt` | `SessionId` | `turn` | empty | prompt id, else sequence plus timestamp, else timestamp plus attribute hash |
| `claude` | `api_request`, `claude_code.api_request` | `SessionId` | `request` | `model` | sequence plus timestamp, else timestamp plus attribute hash |
| `codex` | `codex.user_prompt` | `conversation.id` | `turn` | empty | timestamp plus resource and log attributes |

The Claude keys are the ones `sessionTurns` uses; both come from
[sessionTurnsSchema.js](../../dashboard/server/sessionTurnsSchema.js), so the live query and
the table cannot drift. Rows without a session are excluded. `UserIdentity` is
`user.email`, else `enduser.id`, else empty. Retention is 90 days (`DELETE`), with a 45-day
move to the `cold` volume when replicated. Codex rows are a diagnostic feed and never feed
completion-log usage or cost ([interpretation](../reference/codex-observability.md)).

Schema installation alone changes no query. A transform change requires a new table
version and migration.

## Install and backfill

Follow the snapshot, replica and privilege checks in the
[cost schema runbook](codex-cost-schema.md#1-install-without-activating-reads), using the
stable migration identity rather than the collector identity.

1. Require ledger 004. Execute `clickhouse-migration-010.sql` once through the selected
   writer connection, then verify the table and view on every replica.
2. Confirm the view uses explicit `SQL SECURITY DEFINER`, its creator still exists, and
   collector inserts into `otel_logs` continue without new grants.
3. Run `clickhouse-backfill-010.sql` serially on one replica per shard with bound UTC
   `backfillFrom`/`backfillTo` (positive, at most one day each), from the oldest retained
   log hour through installation plus one settled hour. Backfill uses `insert_deduplicate=0`
   safely because states union.
4. Compare the table against the raw logs for the backfilled window. Any difference blocks
   activation:

```sql
SELECT Client, Kind, uniqExactMerge(Keys) AS keys
FROM claude_code.session_turns_v1
WHERE hour >= {from:DateTime('UTC')} AND hour < {to:DateTime('UTC')}
GROUP BY Client, Kind ORDER BY Client, Kind;
```

   Run the same grouping over `otel_logs` with the keys from `sessionTurnsSchema.js` for
   the same `Timestamp` window and compare. Expired raw rows cannot be reconstructed, so
   hours before the first backfilled hour are a coverage gap, not an error.

## Activate and roll back

Set `SESSION_TURNS_READ_FROM` to the verified UTC start of the `session_turns_v1`
backfill and deploy. There is no raw-log fallback. A window that starts before it, any
window while it is unset or empty, and any window older than the 90-day log retention
report chain/decomposition as unavailable (`not_backfilled` or `retention`), never zero
and never raw-log values.

Unset `SESSION_TURNS_READ_FROM` and redeploy to roll back; this disables token-economics
reads. Retain the table and view.
