# Team attribution from the user directory

Status: approved by the user, 2026-11-14.

## Intent

Teams today come from the `team` OTel resource attribute that each device sends
([team attribute design](2026-11-04-team-attribute-design.md)). That value is
client-provided, so a user can send any team or none. Installations that sign in through
Cognito already hold an administrator-managed department for every user
(`custom:department` in the production pool). This change lets an administrator attribute
usage to teams from that directory, while installations without Cognito keep using the
device-provided value.

The user decided:

- **Mapping happens in the dashboard, not the collector.** The collector would bake the team
  into telemetry at install time, could not follow department changes, and cannot reach
  users who configure OTel without it.
- **Usage belongs to the team at the time it happened.** When a department changes, usage
  from that point on goes to the new team; earlier usage stays with the old one.
- **History starts at the first directory read.** Usage before the feature was enabled is
  attributed to the department first read, and the UI states that boundary.
- **Users who cannot be matched to the directory keep the device-provided team**, shown as
  a device-provided value.
- **An administrator chooses the directory attribute** (for example `custom:department`,
  the email domain or the name) in a new settings menu.
- **Workshops are out of the directory path.** They ingest with a shared password and no
  Cognito, and their `user.email` is an account-shaped identifier such as
  `222721278043@ws`, not a directory email. New workshop environments will send `team`
  instead of `team.id`; the dashboard does not add `team.id` support. Workshops keep the
  device-provided team only.

## Goals

- Directory-sourced team per user, with change history, for OIDC installations backed by a
  Cognito user pool.
- Existing team views (filter, user list team column, team cost section, team cost trend)
  use the resolved team without new pages.
- An admin-only settings page to choose the directory attribute and give readable labels to
  raw values (`field-ags-korea-all-cs` is not a team name).
- Every displayed team says where it came from: directory or device.

## Non-goals

- Changing the collector, the install flow or what devices send.
- Reading `team.id`, or any device attribute other than `team`.
- Manual per-user team assignment in the dashboard.
- Directories other than Cognito (Entra ID, Okta) in this change; keep the source behind
  one interface so they can be added later.
- Verified identity for telemetry: `user.email` stays client-provided, so a device can still
  claim another user's email and inherit that user's directory team. Document this; do not
  claim the directory makes attribution verified.

## Anti-goals

- Re-attributing past usage when a department changes. That breaks the user's rule.
- Silently showing a directory team for a user that only matched by a guess (for example a
  fuzzy name match). Matching is exact on email, case-insensitive.
- Treating "no team" and "unknown history" as the same thing in the UI.
- New public ingress, new VPC resources, or any auth weakening.

## Current state (verified in code on 2026-11-14)

- `dashboard/server/queries.js`: `sessionTeamsSql()` resolves one team per session from
  `otel_logs` (`TEAM_EXPR` over `ResourceAttributes['team']` and `LogAttributes['team']`),
  with the identity `LOG_USER` (`user.email`, then `enduser.id`). `listTeams`, `userTeams`,
  `costByTeam`, `costByTeamDaily` and the `team` filter all build on it.
- The collector keeps `team` (`dashboard/collector/privacy-processors.yaml` `keep_keys`) and
  drops unknown resource keys such as `team.id`.
- `dashboard/server/auth.js`: roles viewer, analyst, admin; `admin` has
  `installation:read`. Basic mode grants every permission to anyone with the password.
- The production pool has `custom:department` set for its 38 users. The pool is not
  managed by this repository's Terraform; `OIDC_ISSUER` names it
  (`https://cognito-idp.<region>.amazonaws.com/<pool id>`).
- The dashboard pod already has an IRSA role (`aws_iam_role.dashboard_bedrock` in
  `infra/dashboard.tf`) and, when device ingestion is enabled, read/write access to the
  `device_tokens` DynamoDB table (`infra/device_ingest.tf`).
- There is no settings page in the web app today.

## Design

### Sources

- **Directory source (Cognito).** Enabled only when `AUTH_MODE=oidc`, the issuer is a
  Cognito user pool, and an administrator has chosen an attribute. The server lists the
  pool's users (`cognito-idp:ListUsers`, paginated) and reads each user's `email` and the
  chosen attribute. Users without an email are skipped.
- **Device source.** The existing `team` resolution, unchanged, used whenever the directory
  has no entry for the session's user at that time.

The resolved team for a session is: the directory team of the session's user valid at the
session's first timestamp in the window, else the device team, else no team. A session that
spans a department change stays with the team valid at its start (builder's call to
refine only if usage at bucket grain needs it; record the choice).

### History

- A sync job reads the directory periodically (default every hour; the interval is a server
  setting) and once at startup. For each user it compares the value with the latest history
  entry and appends `{team, from}` only on change, with `from` set to the sync time. Change
  times are therefore accurate to the sync interval; document that.
- The first entry for a user gets `from = epoch`, implementing the "first read applies to
  the past" rule. The settings page shows when history began (the first sync time) so the
  UI can say "before this date: department at first sync".
- A user removed from the pool keeps their history; their last team stays valid (removal is
  not a department change). A user whose attribute is cleared gets an entry with
  `team = null` from that time (falls back to the device team).
- Changing the chosen attribute applies only from the switch time onward (user decision,
  2026-11-14). Settings keep an attribute timeline `[{attribute, from}]`; the first
  attribute starts at epoch. Usage before a switch keeps the previous attribute's history,
  and the new attribute's first read is valid from the switch time, never earlier. The
  query therefore resolves the attribute valid at the session start, then that attribute's
  history entry valid at the same time. Switching back to an earlier attribute reuses its
  stored series from the new switch time.

### Storage

- Reuse the `device_tokens` DynamoDB table with dedicated partition keys, the way
  enrollment records already do (my call: no new table or IAM table grant). This makes
  directory teams depend on device ingestion being enabled (true in production:
  `INGEST_ENABLED=1`, verified 2026-11-14); the settings page says so when it is not.
- Keep the table's contract that no cleartext owner identifiers are stored
  (`infra/device_ingest.tf`). Neither the email nor the Cognito `sub` is stored in clear
  (my call). Identifiers use the same unkeyed digest style as device owners
  (`deviceTokens.js`): `userKey = sha256(issuer + "\0" + sub)` and
  `emailKey = sha256(issuer + "\0" + lower(email))`.
  - `owner = "settings"`, `id = "team-mapping"`: `{ attributes: [{attribute, from}],
    labels: {raw: label}, updatedAt, updatedBy, version }`. `updatedBy` is the admin's owner digest, not an email.
  - `owner = "team-history#<attribute>"`, `id = <userKey>`: `{ entries: [{team, from,
    emailKey}], version }`. Each entry carries the email digest valid at that time, so a
    user whose email changes keeps old sessions attributed through the old digest (my
    call). Writes are conditional on `version` so two replicas syncing at once cannot both
    append.
- Raw directory values (department names) are stored in clear; they are team names, not
  personal identifiers.

### Query integration

- The server loads the current history (38 users today; bound it, for example 20,000
  entries, and fail closed with an explicit "directory too large" state above that) and
  passes it to ClickHouse as bound array parameters: email digests, teams and `from`
  timestamps. No email reaches the query and no key is needed: ClickHouse computes
  `lower(hex(SHA256(concat(issuer, '\0', lower(identity)))))` per session (my call). No
  ClickHouse writes; the reader stays read-only.
- `sessionTeamsSql()` gains the directory join: for each session, match its email digest
  and pick the entry with the greatest `from` not after the session's first timestamp. Output adds `team_source` (`directory` or `device`). Labels are applied
  in the server response, not in SQL, so a label change does not change cached SQL.
- The cache key includes the mapping version (settings version plus a history digest), so
  a sync or settings change invalidates cached team results.
- `/api/teams` and `/api/users/teams` return each team with its source; a team value that
  exists from both sources is one team for filtering.

### Settings page

- New route `/settings`, admin only, through a new permission `settings:manage` granted to
  `admin`. In Basic mode the page is read-only and explains that directory teams need SSO
  (Basic grants every permission, so it must not allow editing there).
- Contents: directory status (connected pool, last sync, user count, history start), the
  attribute picker (populated from the pool's schema: standard attributes such as `email`
  domain and `name`, plus `custom:*`), a preview table of raw values with user counts and an
  editable label per value, and a save action.
- Attribute preview (user decision, 2026-11-14): choosing an attribute in the picker, before
  saving, shows how the current directory would group under it: each value with its user
  count and the number of users with no value. The administrator compares attributes this
  way and saves the best one; nothing changes until save. Attributes can be switched any
  number of times, each switch taking effect from its save time.
- There is no option to recompute past usage under a new attribute or new history: it
  would let one save rewrite historical team costs, against the attribution rule. Saving is a same-origin `PUT` with the
  existing OIDC origin check; never on `GET`.
- "Email domain" is a derived attribute (the part after `@`), not a Cognito field.

### Display

- Labels are display names only; they never merge teams (my call). Grouping and the
  `team` filter stay on raw values, so the SQL and cache are label-independent. Settings
  reject two directory values with the same label. A directory label that equals a
  device-provided team name stays a separate team, distinguished by the source marker.
- Team names show the label when one exists, else the raw value.
- Device-provided teams carry a small "device-provided value" marker (Korean UI copy) in the user list, filter options
  and team cost tables; directory teams carry none. Tooltips explain both.
- The team cost section states the history start date when the selected range begins before
  it.

### Infrastructure

- Add `cognito-idp:ListUsers` and `cognito-idp:DescribeUserPool` for the pool ARN derived
  from `oidc_issuer` to the dashboard IRSA role, only when the issuer is a Cognito pool.
  Region and pool ID come from the issuer URL; the account is the deployment account
  (`data.aws_caller_identity`). A pool in another account is out of scope (my call; the
  production pool is in the deployment account, verified 2026-11-14).
- No network changes: the Cognito API is reached through the existing egress path.

## Constraints

- English engineering docs; Korean-first UI copy (`dashboard/web/AGENTS.md`).
- Team stays attribution, not verified identity; keep that caveat everywhere team is
  documented.
- Bound SQL parameters only; respect the reader's settings limits.
- Unavailable is not zero: a directory outage keeps the last stored history and shows a
  stale-sync warning; it never drops teams to "none".
- CHANGELOG Unreleased entry; docs: `docs/metrics.md` team definition,
  `docs/reference/security.md` (new IAM grant and permission), `docs/api-reference.md`,
  `docs/runbooks/organization-sso.md` (attribute setup).

## Left to the builder

- Sync scheduling details across two replicas (leader election is not required if the
  conditional writes hold).
- Exact SQL shape for the time-valid join and its performance on the 90-day log window.
- UI layout of the settings page within existing `Card`/`DataTable` conventions.
- Test strategy, following existing node:test and Vitest patterns.
