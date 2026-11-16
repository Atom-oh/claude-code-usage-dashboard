import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUP_CTE, PROVIDER_GROUPS, claudeBackendSql, groupCte, parseProviderGroups } from "./grouping.js";
import { resolveClaudeBackend } from "./backend.js";
import { PROVIDER_TABLE, providerSchemaSql, providerBackfillSql } from "./claudeProviderSchema.js";

test("provider grouping stays off by default and keeps the legacy CTE", () => {
  assert.equal(PROVIDER_GROUPS, false);
  assert.equal(GROUP_CTE, groupCte());
  assert.doesNotMatch(GROUP_CTE, /claude_session_providers_v1/);
});

test("CLAUDE_PROVIDER_GROUPS accepts only explicit booleans", () => {
  for (const value of [undefined, "", "false", "0", "FALSE"]) assert.equal(parseProviderGroups(value), false);
  for (const value of ["true", "1", "TRUE"]) assert.equal(parseProviderGroups(value), true);
  for (const value of ["yes", "enabled", "2"]) assert.throws(() => parseProviderGroups(value), /CLAUDE_PROVIDER_GROUPS/);
});

test("provider CTE reads migration 009 and keeps session_group's shape", () => {
  const sql = groupCte({ provider: true });
  assert.match(sql, /^\s*WITH session_provider AS \(/);
  assert.match(sql, /\), session_group AS \(/);
  assert.match(sql, new RegExp(`FROM claude_code\\.${PROVIDER_TABLE}\\b`));
  assert.match(sql, /r\.SessionId AS SessionId/);
  assert.match(sql, /\) AS grp,\n\s*toUInt8\(p\.provider_bedrock = 1\) AS provider_bedrock,\n\s*toUInt8\(p\.provider_mantle = 1\) AS provider_mantle,\n\s*r\.claude_route AS claude_route\n/);
  // Both variants expose the same columns; the legacy CTE never claims provider evidence
  // but keeps the route evidence, which needs only the rollup.
  assert.match(groupCte(), /toUInt8\(0\) AS provider_bedrock,\n\s*toUInt8\(0\) AS provider_mantle,\n\s*arrayStringConcat\([\s\S]*\) AS claude_route\n/);
  assert.ok(sql.trimEnd().endsWith(")"), "consumers append `, next AS (...)`");
  // The legacy multiIf survives verbatim as the fallback for older clients.
  const legacy = groupCte().match(/multiIf\([\s\S]*?\n\s*\)/)[0];
  assert.ok(sql.includes(legacy));
});

test("provider multiIf order: bedrock evidence, then firstParty, then heuristic", () => {
  const sql = groupCte({ provider: true });
  const order = ["p.provider_bedrock = 1 OR p.provider_mantle = 1, 'bedrock'", "r.bedrock_model = 1, 'bedrock'",
    "p.provider_first_party = 1 AND r.org = 1, 'enterprise'", "p.provider_first_party = 1, 'unknown'",
    "r.legacy_grp"].map((branch) => sql.indexOf(branch));
  assert.ok(order.every((index) => index > 0), "every branch is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

// JS mirror of the SQL branches above, pinned to sessions observed on 2026-11-04 and 2026-11-15.
test("provider classification mirror yields the observed session outcomes", () => {
  const legacy = (models, hasOrg) => {
    if (models.some((m) => m !== "" && !m.startsWith("claude-"))) return "bedrock";
    if (hasOrg) return "enterprise";
    if (models.some((m) => m !== "")) return "bedrock";
    return "unknown";
  };
  const classify = (providers, models, hasOrg) => {
    if (providers.includes("bedrock") || providers.includes("mantle")) return "bedrock";
    if (models.some((m) => m !== "" && !m.startsWith("claude-"))) return "bedrock";
    if (providers.includes("firstParty")) return hasOrg ? "enterprise" : "unknown";
    return legacy(models, hasOrg);
  };
  // Bedrock provider with bare model ids and an organization (mixed resume).
  assert.equal(classify(["bedrock", "firstParty"], ["claude-opus-5-5"], true), "bedrock");
  // Bedrock provider without model observations.
  assert.equal(classify(["bedrock"], [], false), "bedrock");
  // CLAUDE_CODE_USE_MANTLE alone reports 'mantle'.
  assert.equal(classify(["mantle"], ["anthropic.claude-opus-5-5"], false), "bedrock");
  // firstParty after upgrade, global.anthropic.* before it: bedrock evidence wins.
  assert.equal(classify(["firstParty"], ["claude-opus-5-5", "global.anthropic.claude-opus-5-5"], true), "bedrock");
  assert.equal(classify(["firstParty"], ["claude-sonnet-5-5"], true), "enterprise");
  // firstParty without organization: API key or failed login, not 3P.
  assert.equal(classify(["firstParty"], ["claude-sonnet-5-5"], false), "unknown");
  assert.equal(classify(["firstParty"], [], false), "unknown");
  // Unrecognized or absent provider values keep the heuristic.
  assert.equal(classify(["vertex"], ["claude-sonnet-5"], false), legacy(["claude-sonnet-5"], false));
  assert.equal(classify([], ["claude-sonnet-5"], true), "enterprise");
});

test("provider schema stores only membership keys from metric attributes", () => {
  const sql = providerSchemaSql({ replicated: true });
  assert.match(sql, /ReplicatedReplacingMergeTree\('\/clickhouse\/tables\/\{shard\}\/claude_session_providers_v1'/);
  assert.match(sql, /ORDER BY \(SessionId, Provider, hour\)/);
  assert.match(sql, /TTL hour \+ INTERVAL 180 DAY DELETE/);
  assert.match(sql, /SQL SECURITY DEFINER/);
  assert.match(sql, /Attributes\['anthropic\.provider'\] != ''/);
  assert.doesNotMatch(sql, /custom_base_url|UserEmail|Value/);
  assert.match(providerSchemaSql(), /ENGINE = ReplacingMergeTree\(\)/);
});

test("provider backfill is bounded to one day", () => {
  const sql = providerBackfillSql();
  assert.match(sql, /dateDiff\('second', \{backfillFrom:DateTime\('UTC'\)\}, \{backfillTo:DateTime\('UTC'\)\}\) > 86400/);
  assert.match(sql, /TimeUnix >= \{backfillFrom:DateTime\('UTC'\)\} AND TimeUnix < \{backfillTo:DateTime\('UTC'\)\}/);
});

// JS mirror of CLAUDE_ROUTE over a session's rollup model ids.
const ANTHROPIC_ID = /^([a-z][a-z0-9-]*\.)?anthropic\.claude-/;
const claudeRoute = (models) => [...new Set(models.filter((m) => ANTHROPIC_ID.test(m))
  .map((m) => resolveClaudeBackend(m, "bedrock")))].join(",");

test("route evidence: the session's routed Anthropic ids, from the rollup in both modes", () => {
  for (const sql of [groupCte(), groupCte({ provider: true })]) {
    assert.match(sql, /arrayStringConcat\(groupUniqArrayIf\(multiIf\(match\(Model, '\^\(us\|us-gov\|eu\|apac\|jp\|au\|in\|global\)\\\\\.'\)/);
    assert.match(sql, /match\(Model, '\^\(\[a-z\]\[a-z0-9-\]\*\\\\\.\)\?anthropic\\\\\.claude-'\)\), ','\) AS claude_route/);
    assert.equal(sql.match(/claude_session_providers_v1/g)?.length ?? 0, sql === groupCte() ? 0 : 1);
  }
  // Sessions observed 2026-11-15 (metric model ids; their api_request logs were all bare).
  assert.equal(claudeRoute(["global.anthropic.claude-opus-5-5"]), "bedrock-runtime");
  assert.equal(claudeRoute(["anthropic.claude-opus-5-5", "anthropic.claude-haiku-5-5"]), "bedrock-mantle");
  // A pinned bare id under ANTHROPIC_BEDROCK_REGION_PREFIX leaves no route evidence.
  assert.equal(claudeRoute(["claude-fable-5-1"]), "");
  // Non-Anthropic ids are not Claude route evidence.
  assert.equal(claudeRoute(["openai.gpt-6-astra", "global.anthropic.claude-opus-5-5"]), "bedrock-runtime");
  // A session on both routes is ambiguous; its bare rows fall through.
  assert.equal(claudeRoute(["global.anthropic.claude-opus-5", "anthropic.claude-sonnet-5"]), "bedrock-runtime,bedrock-mantle");
});

test("Claude backend: bare claude ids take route evidence, then one reported provider", () => {
  const sql = claudeBackendSql("m.Model");
  const order = ["= 'enterprise', 'anthropic'",
    "startsWith(m.Model, 'claude-') AND ug.claude_route IN ('bedrock-mantle', 'bedrock-runtime'), ug.claude_route",
    "startsWith(m.Model, 'claude-') AND ug.provider_mantle = 1 AND ug.provider_bedrock = 0, 'bedrock-mantle'",
    "startsWith(m.Model, 'claude-') AND ug.provider_bedrock = 1 AND ug.provider_mantle = 0, 'bedrock-runtime'",
    "multiIf(match(m.Model"].map((branch) => sql.indexOf(branch));
  assert.ok(order.every((index) => index > 0), "every branch is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // JS mirror used for per-call task pricing.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "enterprise", { route: "bedrock-runtime" }), "anthropic");
  // Bedrock+Mantle with anthropic.* ids reports 'bedrock'; the route evidence wins.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { route: "bedrock-mantle", providerBedrock: true }), "bedrock-mantle");
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { route: "bedrock-runtime" }), "bedrock-runtime");
  // No route evidence (pinned bare id): one reported provider decides.
  assert.equal(resolveClaudeBackend("claude-fable-5[1m]", "bedrock", { providerBedrock: true }), "bedrock-runtime");
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { providerMantle: true }), "bedrock-mantle");
  // Mixed routes or both providers are ambiguous.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { route: "bedrock-runtime,bedrock-mantle", providerBedrock: true }), "bedrock-runtime");
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { route: "bedrock-runtime,bedrock-mantle" }), "unknown");
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { providerBedrock: true, providerMantle: true }), "unknown");
  // Without session evidence a bare id stays unknown.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock"), "unknown");
  // Prefixed ids keep their own resolution whatever the session says.
  assert.equal(resolveClaudeBackend("global.anthropic.claude-opus-5-5", "bedrock", { route: "bedrock-mantle" }), "bedrock-runtime");
  assert.equal(resolveClaudeBackend("openai.gpt-6-astra", "bedrock", { route: "bedrock-runtime", providerBedrock: true }), "bedrock-mantle");
});

test("Claude backend: a login row in a Bedrock-channel session stays Anthropic", () => {
  const sql = claudeBackendSql("m.Model", "''", "m.Org");
  const order = ["= 'enterprise', 'anthropic'", "(m.Org) AND startsWith(m.Model, 'claude-'), 'anthropic'",
    "ug.claude_route IN", "ug.provider_mantle = 1", "ug.provider_bedrock = 1", "multiIf(match(m.Model"].map((branch) => sql.indexOf(branch));
  assert.ok(order.every((index) => index > 0), "every branch is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Callers without a per-row signal keep the session/model rules.
  assert.doesNotMatch(claudeBackendSql("m.Model"), /\(\) AND/);
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { hasOrg: true }), "anthropic");
  // The row signal outranks session-level route and provider evidence.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", { hasOrg: true, route: "bedrock-runtime", providerBedrock: true }), "anthropic");
  // It never reclassifies a prefixed Bedrock id.
  assert.equal(resolveClaudeBackend("global.anthropic.claude-opus-5-5", "bedrock", { hasOrg: true }), "bedrock-runtime");
  const noSession = claudeBackendSql("m[1]", "''", "m[2] = '1'", { sessionEvidence: false });
  assert.doesNotMatch(noSession, /provider_bedrock|provider_mantle|claude_route/);
  assert.match(noSession, /\(m\[2\] = '1'\) AND startsWith\(m\[1\], 'claude-'\), 'anthropic'/);
});
