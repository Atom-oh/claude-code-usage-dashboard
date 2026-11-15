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
  assert.match(sql, /\) AS grp,\n\s*toUInt8\(p\.provider_bedrock = 1\) AS provider_bedrock\n/);
  // Both variants expose provider_bedrock; the legacy CTE never claims provider evidence.
  assert.match(groupCte(), /toUInt8\(0\) AS provider_bedrock/);
  assert.ok(sql.trimEnd().endsWith(")"), "consumers append `, next AS (...)`");
  // The legacy multiIf survives verbatim as the fallback for older clients.
  const legacy = groupCte().match(/multiIf\([\s\S]*?\n\s*\)/)[0];
  assert.ok(sql.includes(legacy));
});

test("provider multiIf order: bedrock evidence, then firstParty, then heuristic", () => {
  const sql = groupCte({ provider: true });
  const order = ["p.provider_bedrock = 1, 'bedrock'", "r.bedrock_model = 1, 'bedrock'",
    "p.provider_first_party = 1 AND r.org = 1, 'enterprise'", "p.provider_first_party = 1, 'unknown'",
    "r.legacy_grp"].map((branch) => sql.indexOf(branch));
  assert.ok(order.every((index) => index > 0), "every branch is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

// JS mirror of the SQL branches above, pinned to sessions observed on 2026-11-04.
test("provider classification mirror yields the observed session outcomes", () => {
  const legacy = (models, hasOrg) => {
    if (models.some((m) => m !== "" && !m.startsWith("claude-"))) return "bedrock";
    if (hasOrg) return "enterprise";
    if (models.some((m) => m !== "")) return "bedrock";
    return "unknown";
  };
  const classify = (providers, models, hasOrg) => {
    if (providers.includes("bedrock")) return "bedrock";
    if (models.some((m) => m !== "" && !m.startsWith("claude-"))) return "bedrock";
    if (providers.includes("firstParty")) return hasOrg ? "enterprise" : "unknown";
    return legacy(models, hasOrg);
  };
  // Bedrock provider with bare model ids and an organization (mixed resume).
  assert.equal(classify(["bedrock", "firstParty"], ["claude-opus-5-5"], true), "bedrock");
  // Bedrock provider without model observations.
  assert.equal(classify(["bedrock"], [], false), "bedrock");
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

test("Claude backend: provider-reported Bedrock serves bare claude ids from runtime", () => {
  const sql = claudeBackendSql("m.Model");
  const order = ["= 'enterprise', 'anthropic'", "ug.provider_bedrock = 1 AND startsWith(m.Model, 'claude-'), 'bedrock-runtime'",
    "'bedrock-mantle'"].map((branch) => sql.indexOf(branch));
  assert.ok(order.every((index) => index > 0), "every branch is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // JS mirror used for per-call task pricing.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "enterprise", true), "anthropic");
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", true), "bedrock-runtime");
  assert.equal(resolveClaudeBackend("claude-fable-5[1m]", "bedrock", true), "bedrock-runtime");
  // Without provider evidence (legacy heuristic or provider mode off) a bare id stays unknown.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", false), "unknown");
  assert.equal(resolveClaudeBackend("global.anthropic.claude-opus-5-5", "bedrock", false), "bedrock-runtime");
  // Non-Anthropic ids keep their own resolution even with provider evidence.
  assert.equal(resolveClaudeBackend("openai.gpt-6-astra", "bedrock", true), "bedrock-mantle");
});

test("Claude backend: a login row in a Bedrock-channel session stays Anthropic", () => {
  const sql = claudeBackendSql("m.Model", "''", "m.Org");
  const order = ["= 'enterprise', 'anthropic'", "(m.Org) AND startsWith(m.Model, 'claude-'), 'anthropic'",
    "ug.provider_bedrock = 1", "'bedrock-mantle'"].map((branch) => sql.indexOf(branch));
  assert.ok(order.every((index) => index > 0), "every branch is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Callers without a per-row signal keep the session/model rules.
  assert.doesNotMatch(claudeBackendSql("m.Model"), /\(\) AND/);
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", false, true), "anthropic");
  // The row signal outranks session-level provider evidence.
  assert.equal(resolveClaudeBackend("claude-opus-5-5", "bedrock", true, true), "anthropic");
  // It never reclassifies a prefixed Bedrock id.
  assert.equal(resolveClaudeBackend("global.anthropic.claude-opus-5-5", "bedrock", false, true), "bedrock-runtime");
  const noProvider = claudeBackendSql("m[1]", "''", "m[2] = '1'", { provider: false });
  assert.doesNotMatch(noProvider, /provider_bedrock/);
  assert.match(noProvider, /\(m\[2\] = '1'\) AND startsWith\(m\[1\], 'claude-'\), 'anthropic'/);
});
