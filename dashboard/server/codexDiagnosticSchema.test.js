import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_USAGE_KEYS } from "./codexRequests.js";
import { DIAGNOSTIC_COLUMNS, diagnosticAttributesSql, diagnosticBackfillSql,
  diagnosticSchemaSql, diagnosticTransform } from "./codexDiagnosticSchema.js";

test("diagnostic transform retains full identity states and second-grain selection dimensions", () => {
  const sql = diagnosticTransform();
  assert.match(sql, /toStartOfSecond\(Timestamp\) AS Second/);
  assert.match(sql, /mapSort\(ResourceAttributes\) AS r/);
  assert.match(sql, /mapSort\(LogAttributes\) AS a/);
  assert.match(sql, /uniqExactState\(tuple\(toString\(toTimeZone\(Timestamp, 'UTC'\)\), r, a\)\) AS Identities/);
  assert.match(sql, /min\(Timestamp\) AS MinTimestamp/);
  assert.match(sql, /max\(Timestamp\) AS MaxTimestamp/);
  assert.match(sql, /startsWith\(EventName, 'codex\.'\)/);
  assert.match(sql, /startsWith\(a\['event.name'\], 'codex\.'\)/);
  assert.match(sql, /GROUP BY UserEmail, Second, Model, ConversationId, Backend, ProjectName, AttributesJSON/);
  for (const field of ["user.email", "enduser.id", "conversation.id", "model", "backend", "project.name"])
    assert.ok(sql.includes(`['${field}']`), field);
});

test("diagnostic transform selects duplicate map keys in the same canonical order as raw logs", () => {
  const sql = diagnosticTransform();
  assert.match(sql, /coalesce\(nullIf\(r\['user.email'\], ''\)/);
  assert.match(sql, /a\['model'\] AS Model/);
  assert.match(sql, /a\['conversation.id'\] AS ConversationId/);
  assert.match(sql, /r\['project.name'\] AS ProjectName/);
  assert.ok(sql.includes(`toJSONString(${diagnosticAttributesSql("a")}) AS AttributesJSON`));
  assert.doesNotMatch(sql, /LogAttributes\[|ResourceAttributes\[|toJSONString\(mapSort/);
});

test("diagnostic attributes retain displayed inputs and normalize unused sensitive values to presence", () => {
  const sql = diagnosticAttributesSql("attributes");
  for (const field of ["event.name", "event.kind", "duration_ms", "attempt", "http.response.status_code",
    "error", "error.message", "success", "tool_name", "decision", "source", "startup.phase", ...CODEX_USAGE_KEYS])
    assert.ok(sql.includes(`'${field}'`), field);
  assert.match(sql, /mapApply/);
  assert.match(sql, /'present'/);
  assert.doesNotMatch(sql, /conversation.id|model_reasoning_effort|prompt_length|app.version|provider_name/);
});

test("diagnostic schema uses exact merged states with matching replicated storage retention", () => {
  const sql = diagnosticSchemaSql(), replicated = diagnosticSchemaSql({ replicated: true });
  assert.match(sql, /ENGINE = AggregatingMergeTree\(\)/);
  assert.match(sql, /ORDER BY \(UserEmail, Second, Model, ConversationId, Backend, ProjectName, AttributesJSON\)/);
  assert.match(sql, /MinTimestamp SimpleAggregateFunction\(min, DateTime64\(9\)\)/);
  assert.match(sql, /MaxTimestamp SimpleAggregateFunction\(max, DateTime64\(9\)\)/);
  assert.match(sql, /Identities AggregateFunction\(uniqExact, Tuple\(String, Map\(LowCardinality\(String\), String\), Map\(LowCardinality\(String\), String\)\)\)/);
  assert.match(sql, /DEFINER = CURRENT_USER SQL SECURITY DEFINER/);
  assert.match(sql, /INTERVAL 90 DAY DELETE/);
  assert.match(replicated, /ReplicatedAggregatingMergeTree/);
  assert.match(replicated, /ON CLUSTER 'replicated'/);
  assert.match(replicated, /INTERVAL 45 DAY TO VOLUME 'cold'/);
  assert.doesNotMatch(sql + replicated, /POPULATE|180 DAY|ttl_only_drop_parts/);
});

test("diagnostic backfill shares the insertion transform and binds a positive day-bounded UTC interval", () => {
  const sql = diagnosticBackfillSql();
  assert.ok(sql.includes(`INSERT INTO claude_code.codex_diagnostic_events_v1 (${DIAGNOSTIC_COLUMNS.map(([name]) => name).join(", ")})`));
  assert.ok(sql.includes(diagnosticTransform("Timestamp >= {backfillFrom:DateTime('UTC')} AND Timestamp < {backfillTo:DateTime('UTC')}")));
  assert.match(sql, /throwIf/);
  assert.match(sql, /\{backfillTo:DateTime\('UTC'\)\} <= \{backfillFrom:DateTime\('UTC'\)\}/);
  assert.match(sql, /> 86400/);
});
