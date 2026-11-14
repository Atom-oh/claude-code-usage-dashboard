# Directory-Sourced Team Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute usage to the Cognito directory team valid when it happened, with a device-provided fallback and an admin settings page to pick the directory attribute.

**Architecture:** A server sync job reads the Cognito pool hourly and appends per-user team history (digests only) to the existing device-token DynamoDB table. The server flattens history into validity intervals and injects them as bound array parameters into every query that uses `sessionTeamsSql()`, which resolves a session's team from the directory first and the device `team` attribute second. An admin-only `/settings` page picks the attribute, previews groupings and edits display labels.

**Tech Stack:** Node 22 ESM + Express, node:test, `@aws-sdk/lib-dynamodb`, new `@aws-sdk/client-cognito-identity-provider`, ClickHouse SQL, React 18 + Vitest, Terraform.

**Spec:** `docs/superpowers/specs/2026-11-14-cognito-team-mapping-design.md`

## Global Constraints

- Usage belongs to the team valid at the session's start; past usage is never re-attributed.
- The first directory read for a user is valid from epoch; an attribute switch is valid only from its save time.
- Never store or send a cleartext email or Cognito `sub`: `userKey = sha256(issuer + "\0" + sub)`, `emailKey = sha256(issuer + "\0" + email.toLowerCase())`, lowercase hex.
- Labels are display only; grouping, filters and cache stay on raw values.
- Directory teams require `AUTH_MODE=oidc`, a Cognito issuer (`https://cognito-idp.<region>.amazonaws.com/<poolId>`), and `INGEST_TOKEN_TABLE`; otherwise behavior equals today's device-only teams.
- A directory or store failure keeps the last snapshot and reports `stale: true`; it never drops teams.
- History bound: 20,000 flattened intervals; above it the directory is disabled with `reason: "directory_too_large"`.
- Team stays client-provided attribution (`user.email` is not verified); keep the caveat in docs.
- UI copy Korean-first; engineering docs English (`scripts/check-docs.py`).
- No `0.0.0.0/0`, no new VPC or public ingress; the only infra change is an IAM policy.
- New dependency pinned exactly like the others (`3.1154.0`), with lockfile updated by `npm install`.
- CHANGELOG `## [Unreleased]` → `### Added` entry.

## Review Focus

1. Cognito `ListUsers` denied or timing out on the first sync: teams must stay device-only with a visible "sync failed" status, and the server must still start. (Task 4 test `first sync failure keeps device teams and reports stale`.)
2. Email case differs between pool and telemetry (`Alice@Example.com` vs `alice@example.com`): they must match. (Task 1 test `emailKey is case-insensitive`, Task 5 SQL test asserts `lower(` around the identity.)
3. Two dashboard replicas sync at the same time: one history entry per change, never two. (Task 4 test `concurrent sync appends a change once`.)
4. An admin saves the same attribute again with only label edits: the attribute timeline must not gain an entry. (Task 6 test `label-only save keeps the attribute timeline`.)
5. A pool user with no email, a non-ASCII email, or an attribute value longer than 256 characters: skipped or ignored, never a crash or a broken SQL parameter. (Task 1 test `attributeValue ignores unusable values`, Task 4 test `users without a usable email are skipped`.)

---

### Task 1: Pure directory logic

**Files:**
- Create: `dashboard/server/teamDirectory.js`
- Test: `dashboard/server/teamDirectory.test.js`

**Interfaces:**
- Produces:
  - `parseCognitoIssuer(issuer: string) -> { region: string, poolId: string } | null` (regex `^https://cognito-idp\.([a-z0-9-]+)\.amazonaws\.com/([a-z0-9-]+_[A-Za-z0-9]+)/?$`).
  - `DERIVED_ATTRIBUTES = ["email_domain"]`; `attributeValue(user: {email, attributes: Record<string,string>}, attribute: string) -> string | null` — `email_domain` is the part after the last `@`, lowercased; values are trimmed; empty, non-string or over 256 characters → `null`.
  - `userKey(issuer, sub) -> string`, `emailKey(issuer, email) -> string | null` (null when the email is not ASCII or has no `@`).
  - `appendHistory(entries: Entry[], { team: string|null, emailKey: string }, at: number) -> Entry[] | null` where `Entry = { team: string|null, from: number, emailKey: string }`; returns `null` when the latest entry already has the same `team` and `emailKey`; the first entry gets `from: 0`.
  - `flattenIntervals({ attributes: [{attribute, from}], histories: Record<attribute, Array<{entries: Entry[]}>>, limit = 20000 }) -> { keys: string[], teams: string[], froms: number[], tos: number[] } | { error: "directory_too_large" }` — each history entry is clipped to its attribute's window `[attribute.from, next attribute.from)` and to `[entry.from, next entry.from)`; `team: null` becomes `""`; `tos` uses `4102444800000` (2100-01-01) for open ends; empty intervals are dropped.

- [ ] **Step 1: Write the failing tests**

```js
test("parseCognitoIssuer accepts only Cognito pool issuers", () => {
  assert.deepEqual(parseCognitoIssuer("https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_u01c65YjO"),
    { region: "ap-northeast-2", poolId: "ap-northeast-2_u01c65YjO" });
  assert.equal(parseCognitoIssuer("https://login.example.com/"), null);
});
test("emailKey is case-insensitive", () => {
  assert.equal(emailKey("iss", "Alice@Example.com"), emailKey("iss", "alice@example.com"));
  assert.match(emailKey("iss", "a@b"), /^[a-f0-9]{64}$/);
  assert.equal(emailKey("iss", "직원@example.com"), null);
});
test("attributeValue ignores unusable values", () => {
  const user = { email: "a@Example.COM", attributes: { "custom:department": "  hana ", long: "x".repeat(257), empty: "" } };
  assert.equal(attributeValue(user, "custom:department"), "hana");
  assert.equal(attributeValue(user, "email_domain"), "example.com");
  assert.equal(attributeValue(user, "long"), null);
  assert.equal(attributeValue(user, "empty"), null);
  assert.equal(attributeValue({ attributes: {} }, "email_domain"), null);
});
test("appendHistory records only changes and starts at epoch", () => {
  const first = appendHistory([], { team: "hana", emailKey: "k" }, 500);
  assert.deepEqual(first, [{ team: "hana", from: 0, emailKey: "k" }]);
  assert.equal(appendHistory(first, { team: "hana", emailKey: "k" }, 900), null);
  assert.deepEqual(appendHistory(first, { team: "cs", emailKey: "k" }, 900).at(-1), { team: "cs", from: 900, emailKey: "k" });
});
test("flattenIntervals clips history to each attribute window", () => {
  const out = flattenIntervals({
    attributes: [{ attribute: "custom:department", from: 0 }, { attribute: "email_domain", from: 1000 }],
    histories: {
      "custom:department": [{ entries: [{ team: "hana", from: 0, emailKey: "k" }, { team: "cs", from: 600, emailKey: "k" }] }],
      email_domain: [{ entries: [{ team: "example.com", from: 0, emailKey: "k" }] }],
    },
  });
  assert.deepEqual(out, { keys: ["k", "k", "k"], teams: ["hana", "cs", "example.com"],
    froms: [0, 600, 1000], tos: [600, 1000, 4102444800000] });
  assert.deepEqual(flattenIntervals({ attributes: [{ attribute: "a", from: 0 }],
    histories: { a: [{ entries: [{ team: "t", from: 0, emailKey: "k" }] }] }, limit: 0 }), { error: "directory_too_large" });
});
```

- [ ] **Step 2: Run and confirm failure** — `cd dashboard/server && node --test teamDirectory.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement the Interfaces above in `dashboard/server/teamDirectory.js`.** Use `node:crypto` `createHash("sha256")`; ASCII check `/^[\x21-\x7e]+$/`.
- [ ] **Step 4: Run** `node --test teamDirectory.test.js` → PASS.
- [ ] **Step 5: Commit** `git add dashboard/server/teamDirectory*.js && git commit -m "feat(teams): add directory history logic"`

### Task 2: Team records in the device-token table

**Files:**
- Modify: `dashboard/server/deviceTokenStore.js` (add methods to the returned object; reuse its private `send` and `keyNames`)
- Test: `dashboard/server/deviceTokenStore.test.js`

**Interfaces:**
- Produces on the store returned by `createDynamoDeviceStore`:
  - `getTeamSettings(options) -> { attributes, labels, updatedAt, updatedBy, version } | null` (key `owner="settings"`, `id="team-mapping"`, `ConsistentRead`).
  - `putTeamSettings(record, expectedVersion: number|null, options) -> boolean` — `PutCommand` with `version = expectedVersion + 1` (or `1`), condition `attribute_not_exists(#id)` when `expectedVersion === null`, else `#version = :expected`; `false` on a lost condition.
  - `listTeamHistory(attribute, options) -> Array<{ id, entries, version }>` — `QueryCommand` on `owner = "team-history#" + attribute`, following `LastEvaluatedKey`.
  - `putTeamHistory(attribute, { id, entries }, expectedVersion: number|null, options) -> boolean` — same conditional pattern.

- [ ] **Step 1: Write failing tests** `team settings and history writes are version-conditional` (assert the `ConditionExpression` and `ExpressionAttributeValues[":expected"]` sent, and that a `ConditionalCheckFailedException` returns `false`) and `team history lists every page` (two pages via `LastEvaluatedKey`), using the file's existing fake-client pattern.
- [ ] **Step 2: Run** `node --test deviceTokenStore.test.js` → FAIL.
- [ ] **Step 3: Implement** the four methods (pass `conditional = true` to `send` for the puts).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(teams): store team settings and history`

### Task 3: Cognito directory client

**Files:**
- Create: `dashboard/server/cognitoDirectory.js`
- Modify: `dashboard/server/package.json`, `dashboard/server/package-lock.json` (`npm install --save-exact @aws-sdk/client-cognito-identity-provider@3.1154.0`)
- Test: `dashboard/server/cognitoDirectory.test.js`

**Interfaces:**
- Produces: `createCognitoDirectory({ region, poolId, client? }) -> { listUsers(signal) -> Promise<Array<{ sub, email, attributes }>>, attributeNames(signal) -> Promise<string[]> }`.
  - `listUsers` pages `ListUsersCommand` (`Limit: 60`, `PaginationToken`), maps `Attributes` to an object, takes `sub` and `email` from it, and stops with an error after 10,000 users.
  - `attributeNames` reads `DescribeUserPoolCommand` `SchemaAttributes[].Name`, keeps `name`, `email` and every `custom:*` that is a `String`, then appends `DERIVED_ATTRIBUTES`; order: `custom:*` sorted, then `name`, `email_domain`.
  - Every SDK call is aborted after 5,000 ms.

- [ ] **Step 1: Write failing tests** `listUsers pages and maps attributes` (fake `client.send` returning two pages; assert `[{ sub: "s1", email: "a@x", attributes: { sub: "s1", email: "a@x", "custom:department": "hana" } }, …]`) and `attributeNames offers custom string attributes and derived ones` (schema with `custom:department` String, `custom:budget` Number, `name`, `email` → `["custom:department", "name", "email_domain"]`).
- [ ] **Step 2: Run** `node --test cognitoDirectory.test.js` → FAIL.
- [ ] **Step 3: Implement**; default client `new CognitoIdentityProviderClient({ region, maxAttempts: 2 })` (IRSA credentials).
- [ ] **Step 4: Run** → PASS; `npm test` still passes.
- [ ] **Step 5: Commit** `feat(teams): read users from the Cognito pool`

### Task 4: Sync job and query parameters

**Files:**
- Create: `dashboard/server/teamSync.js`, `dashboard/server/teamDirectoryParams.js`
- Modify: `dashboard/server/clickhouse.js` (`query()` and `queryReadonly()` pass params through `directoryParams`)
- Test: `dashboard/server/teamSync.test.js`, `dashboard/server/clickhouse.test.js` (or the existing file that tests `query`; create `teamDirectoryParams.test.js` if none fits)

**Interfaces:**
- Consumes: Task 1 (`attributeValue`, `userKey`, `emailKey`, `appendHistory`, `flattenIntervals`), Task 2 store methods, Task 3 directory.
- Produces:
  - `teamDirectoryParams.js`: `setDirectorySnapshot(snapshot: { issuer, keys, teams, froms, tos, labels, historyStart } | null, version: string)`, `directoryVersion() -> string` (`"none"` when unset), `directoryMeta() -> { labels: Record<string,string>, historyStart: number|null }` (`{ labels: {}, historyStart: null }` when unset), `directoryParams(sql, params) -> params` — adds `dirIssuer`, `dirKey`, `dirTeam`, `dirFrom`, `dirTo` (ms numbers converted to `toChDateTime`) only when `sql` contains `{dirKey:`; with no snapshot it adds empty arrays and `dirIssuer: ""`.
  - `teamSync.js`: `createTeamSync({ store, directory, issuer, now = Date.now, intervalMs = 3600000 }) -> { start(), stop(), syncOnce(signal) -> Promise<void>, status() -> TeamDirectoryStatus }` with `TeamDirectoryStatus = { available: true, lastSync: number|null, lastError: string|null, stale: boolean, users: number, historyStart: number|null, reason: string|null }`.
  - `syncOnce`: read settings; if none, publish an empty snapshot; else for the latest attribute, list users, skip users whose `emailKey` is null, and for each user `appendHistory` and `putTeamHistory` with the stored version (on `false`, re-read that user's record once and retry); then load histories for every attribute in the timeline, `flattenIntervals`, and `setDirectorySnapshot` with `version = sha256(JSON.stringify(intervals) + settings.version)`. `historyStart` is the time of the first successful sync that wrote history: if `settings.historyStart` is absent, set it to `now()` via `putTeamSettings` after the writes; publish it and `settings.labels` in the snapshot.
  - On any thrown error: keep the previous snapshot, set `stale: true`, `lastError` to the error code (never the message text from AWS).

- [ ] **Step 1: Write failing tests:**
  - `first sync records the department from epoch and publishes intervals` — fake directory with one user `{ sub: "s", email: "A@x", attributes: { "custom:department": "hana" } }`, settings `{ attributes: [{ attribute: "custom:department", from: 0 }], version: 1 }`; after `syncOnce`, assert one `putTeamHistory` with entries `[{ team: "hana", from: 0, emailKey: emailKey(issuer, "a@x") }]` and `directoryParams("{dirKey:Array(String)}", {}).dirTeam` equals `["hana"]`.
  - `a department change appends from the sync time` — second `syncOnce` with `now = () => 5000` and department `cs` → entries end with `{ team: "cs", from: 5000 }`.
  - `concurrent sync appends a change once` — store whose first `putTeamHistory` returns `false` and whose re-read already contains the change → no second write.
  - `first sync failure keeps device teams and reports stale` — directory `listUsers` rejects → `status()` has `stale: true`, `lastError: "directory_unavailable"`, and `directoryParams` still yields empty arrays.
  - `users without a usable email are skipped` — users with no email and `직원@x` produce no writes.
  - `directoryParams leaves unrelated SQL untouched` — `directoryParams("SELECT 1", { a: 1 })` returns `{ a: 1 }`.
- [ ] **Step 2: Run** `node --test teamSync.test.js` → FAIL.
- [ ] **Step 3: Implement**; `start()` runs `syncOnce` immediately (errors captured, never thrown) and then on `setInterval(intervalMs).unref()`.
- [ ] **Step 4: Run** → PASS; full `npm test` passes.
- [ ] **Step 5: Commit** `feat(teams): sync directory teams and expose query parameters`

### Task 5: Resolve session teams from the directory

**Files:**
- Modify: `dashboard/server/queries.js` (`sessionTeamsSql`, `listTeams`, `userTeams`, `foldUserTeams`), `dashboard/server/index.js` (`cacheKey` appends `&teamdir=${directoryVersion()}`)
- Test: `dashboard/server/queries.test.js`, `dashboard/server/app.test.js`

**Interfaces:**
- Consumes: Task 4 `directoryVersion()` and the `{dir*}` parameter names.
- Produces:
  - `sessionTeamsSql(clients, since)` output columns: `client, session, team, team_source, user, last_seen`. Each branch also emits `min(Timestamp) AS started`; the outer query computes `started = min(started)`, the device team as today, and the directory team as
    `arrayFirstIndex((k, f, t) -> k = lower(hex(SHA256(concat({dirIssuer:String}, '\0', lower(user))))) AND f <= started AND started < t, {dirKey:Array(String)}, {dirFrom:Array(DateTime64(3))}, {dirTo:Array(DateTime64(3))})`
    then `team = if(i > 0 AND {dirTeam:Array(String)}[i] != '', {dirTeam:Array(String)}[i], device_team)` and `team_source = multiIf(i > 0 AND {dirTeam:Array(String)}[i] != '', 'directory', device_team IS NOT NULL, 'device', NULL)`. A session whose only team evidence is the directory must still appear, so the branch filter `value IS NOT NULL` moves to the device-team computation instead of excluding the session. Use the `user` (latest identity) already computed. Builder may restructure the SQL, keeping these columns and semantics.
  - `listTeams` → `{ teams: string[], sources: Record<team, "directory"|"device"|"both">, labels, historyStart }` (the last two from `directoryMeta()`).
  - `userTeams` / `foldUserTeams` rows → `{ user, team, teams, sources: string[] }` (`sources[i]` belongs to `teams[i]`).

- [ ] **Step 1: Update/write failing tests:**
  - Replace the exact `TEAM_EXPR` assertion near `queries.test.js:635` with assertions that the SQL contains `{dirKey:Array(String)}`, `lower(user)`, `AS team_source` and `started < t`.
  - `foldUserTeams keeps the source of each team` — rows `[{ user: "u", team: "hana", team_source: "directory", seen: "2" }, { user: "u", team: "dev", team_source: "device", seen: "1" }]` → `[{ user: "u", team: "hana", teams: ["hana", "dev"], sources: ["directory", "device"] }]`.
  - `listTeams marks teams seen from both sources` (mock query rows `[{team:"hana",team_source:"directory"},{team:"hana",team_source:"device"}]` → `sources.hana === "both"`).
  - In `app.test.js`, assert `cacheKey` source includes `teamdir=`.
- [ ] **Step 2: Run** `node --test queries.test.js app.test.js` → FAIL.
- [ ] **Step 3: Implement.** `listTeams` selects `DISTINCT team, team_source`.
- [ ] **Step 4: Run** full `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(teams): resolve session teams from directory history`

### Task 6: Team settings API

**Files:**
- Create: `dashboard/server/teamSettingsRoutes.js`
- Modify: `dashboard/server/auth.js` (`PERMISSIONS.admin` gains `"settings:manage"`), `dashboard/server/index.js` (create store/directory/sync when the Global Constraints conditions hold; `installTeamSettings(app)` after `collectorFeature.installManagement(app)`; `teamSync.start()` only when not imported for tests — follow the existing "imports never listen" rule)
- Test: `dashboard/server/teamSettingsRoutes.test.js`, `dashboard/server/auth.test.js`

**Interfaces:**
- Consumes: Task 2 store, Task 3 directory, Task 4 sync.
- Produces: `createTeamSettings({ authentication, store, directory, sync, now }) -> { install(app) }` with routes (all `authentication.requirePermission("settings:manage")`, JSON, no-store):
  - `GET /api/settings/teams` → `{ available, reason, poolId, status: TeamDirectoryStatus, attributes: [{attribute, from}], current: string|null, labels, options: string[], version }`. When unavailable, `available: false` and `reason` one of `"basic_auth"`, `"not_cognito"`, `"ingest_disabled"`.
  - `GET /api/settings/teams/preview?attribute=<name>` → `{ attribute, values: [{ value, users }], missing }` computed from `directory.listUsers` and `attributeValue`; `values` sorted by `users` desc then value; 400 `invalid_attribute` when not in `options`.
  - `PUT /api/settings/teams` body `{ attribute: string, labels: Record<string,string>, version: number|null }` (16 KiB limit) → 200 with the new GET body; 409 `directory_unavailable` when unavailable (this covers Basic mode, where every permission passes); 400 `invalid_attribute`; 400 `duplicate_label` when two raw values share a label; label values trimmed, 1–80 characters, keys ≤ 256; 409 `version_conflict` on a lost condition. Appends `{ attribute, from: now() }` only when `attribute` differs from the latest; stores `updatedBy` as the device-owner digest of the principal; then calls `sync.syncOnce()` without awaiting its failure.

- [ ] **Step 1: Write failing tests:**
  - `viewers and analysts cannot read team settings` (403) and `admins can` (200).
  - `Basic mode reads but cannot save` — `PUT` → 409 `directory_unavailable`.
  - `saving a new attribute appends it from the save time` — `now = () => 7000`; timeline gains `{ attribute: "email_domain", from: 7000 }`.
  - `label-only save keeps the attribute timeline` — same attribute, new labels → timeline length unchanged, labels stored.
  - `duplicate labels and unknown attributes are rejected` (400 `duplicate_label`, 400 `invalid_attribute`).
  - `preview groups users without saving` — asserts `values` and `missing`, and no store write.
  - `PUT without the configured Origin is refused` — rely on the global OIDC origin check (403).
  - `auth.test.js`: `settings:manage` belongs to `admin` only.
- [ ] **Step 2: Run** `node --test teamSettingsRoutes.test.js auth.test.js` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(teams): add admin team settings API`

### Task 7: Team labels and source markers in existing views

**Files:**
- Modify: `dashboard/web/src/TeamsContext.jsx`, `dashboard/web/src/components/FilterBar.jsx`, `dashboard/web/src/components/TeamCostSection.jsx`
- Test: `dashboard/web/src/TeamsContext.test.jsx` (create if absent), `dashboard/web/src/components/FilterBar.test.jsx`, `dashboard/web/src/components/TeamCostSection.test.jsx`

**Interfaces:**
- Consumes: Task 5 `/api/teams` (`teams`, `sources`, `labels`, `historyStart`) and `/api/users/teams` (`sources`).
- Produces: `teamsValue(list, users)` adds `labels` and `sources` maps; `teamName(teams, raw) -> string` (label or raw); `teamText(teams, user, { csv })` renders names, appending ` (기기 제공 값)` to device-sourced teams outside CSV; CSV gets names only.

- [ ] **Step 1: Write failing tests:** `teamText shows labels and marks device teams` (`labels: { "field-ags-korea-all-cs": "Korea CS" }`, user teams `["field-ags-korea-all-cs", "dev"]` with sources `["directory", "device"]` → `"Korea CS, dev (기기 제공 값)"`; CSV → `"Korea CS, dev"`); FilterBar option text uses the label while the selected URL value stays raw; TeamCostSection shows `이 날짜 이전은 처음 동기화한 부서 기준입니다` with the date when the range starts before `historyStart`.
- [ ] **Step 2: Run** `cd dashboard/web && npx vitest run src/TeamsContext.test.jsx src/components/FilterBar.test.jsx src/components/TeamCostSection.test.jsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(web): show directory team labels and device markers`

### Task 8: Settings page

**Files:**
- Create: `dashboard/web/src/pages/Settings.jsx`, `dashboard/web/src/pages/Settings.test.jsx`
- Modify: `dashboard/web/src/App.jsx` (`/settings` rendered like `/installation`, outside `TeamsProvider`), `dashboard/web/src/components/Sidebar.jsx` (item `{ to: "/settings", label: "설정", hint: "팀 매핑" }` when `permissions` includes `settings:manage`), `dashboard/web/src/clientNavigation.js` (`isDashboardPath` allows `/settings`), `dashboard/web/src/App.test.jsx`

**Interfaces:**
- Consumes: Task 6 API.
- Produces: page sections — directory status (pool, last sync, users, history start, stale warning), attribute picker (radio list from `options`, current marked), preview table (`값`, `사용자 수`, `표시 이름` input) loaded on selection, a missing-value count, save button (`저장하면 지금부터 이 기준으로 집계합니다. 이전 사용량은 바뀌지 않습니다.`), and an unavailable notice per `reason` (`basic_auth`: `팀 매핑은 조직 로그인(SSO)에서만 사용할 수 있습니다.`).

- [ ] **Step 1: Write failing tests:** renders status and options; selecting an option requests `/api/settings/teams/preview?attribute=…` and shows counts without saving; save sends `PUT` with `{ attribute, labels, version }` and shows the success state; 409 `version_conflict` shows a reload prompt; `available: false` hides the form and shows the reason text; `App.test.jsx` asserts `/settings` is reachable and the sidebar item appears only with `settings:manage`.
- [ ] **Step 2: Run** `npx vitest run src/pages/Settings.test.jsx src/App.test.jsx` → FAIL.
- [ ] **Step 3: Implement** with existing `Card`, `PageHeader`, `DataTable` and the `fetch` pattern used by `CollectorConnect.jsx`/`CollectorSetup.jsx` for unsafe requests (`credentials: "same-origin"`, `checkAuthentication`).
- [ ] **Step 4: Run** `npm test && npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(web): add admin settings page for team mapping`

### Task 9: IAM grant and documentation

**Files:**
- Modify: `infra/dashboard.tf` (locals parsing `var.oidc_issuer` with the Task 1 regex; `aws_iam_role_policy.dashboard_team_directory` on `aws_iam_role.dashboard_bedrock`, `count` = 1 only for a Cognito issuer, actions `cognito-idp:ListUsers`, `cognito-idp:DescribeUserPool`, resource `arn:aws:cognito-idp:<region>:${data.aws_caller_identity.current.account_id}:userpool/<poolId>`), `docs/metrics.md` (team definition), `docs/reference/security.md` (IAM grant, `settings:manage`, digests-only storage, client-provided email caveat), `docs/api-reference.md` (three settings routes; `/api/teams` and `/api/users/teams` new fields), `docs/runbooks/organization-sso.md` (choosing the attribute; first sync applies to the past; switches apply forward), `docs/reference/frontend.md` (`/settings` route), `infra/device_ingest.tf` comment (table also holds team settings and digest-keyed history), `CHANGELOG.md`.

- [ ] **Step 1: Run** `terraform fmt -check -recursive infra/ && (cd infra && terraform init -backend=false && terraform validate)` after the edit → both succeed.
- [ ] **Step 2: Run** `python3 scripts/check-docs.py` and `bash tests/run-all.sh` → pass.
- [ ] **Step 3: Commit** `feat(infra): grant the dashboard read access to the Cognito pool; document team mapping`

## Deployment note (not a task)

Terraform must be applied from current `main` after merge (IAM policy), then the image rolled out. Until an admin saves an attribute, behavior is unchanged.
