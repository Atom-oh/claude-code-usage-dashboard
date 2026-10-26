import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticSelection, diagnosticSourceForRange, parseDiagnosticReadFrom } from "./codexDiagnosticSource.js";

const from = new Date("2026-10-01T00:00:15Z"), to = new Date("2026-10-26T00:00:45Z");

test("diagnostic activation requires a verified whole-second UTC cutover covering the selected range", () => {
  assert.equal(parseDiagnosticReadFrom(undefined), null);
  assert.equal(parseDiagnosticReadFrom(""), null);
  const boundary = parseDiagnosticReadFrom("2026-10-01T00:00:15Z");
  assert.equal(diagnosticSourceForRange(from, to, boundary), "states");
  assert.equal(diagnosticSourceForRange(new Date(+from - 1), to, boundary), "raw");
  assert.equal(diagnosticSourceForRange(new Date(+from + 123), to, boundary), "states");
  assert.equal(diagnosticSourceForRange(from, to, null), "raw");
  for (const value of ["2026-10-01", "2026-02-30T00:00:00Z", "2026-10-01T00:00:00+00:00",
    "2026-10-01T00:00:00.123Z", "invalid", null, 1])
    assert.throws(() => parseDiagnosticReadFrom(value), /CODEX_DIAGNOSTIC_READ_FROM/);
});

test("diagnostic source merges identities before finalization with half-open bounds and original timestamps", () => {
  const { sql, params } = diagnosticSelection(from, to);
  assert.match(sql, /FROM claude_code\.codex_diagnostic_events_v1 FINAL/);
  assert.match(sql, /Second >= \{from:DateTime\} AND Second < \{to:DateTime\}/);
  assert.match(sql, /finalizeAggregation\(Identities\) AS weight/);
  assert.match(sql, /toString\(toTimeZone\(MaxTimestamp, 'UTC'\)\) AS timestamp/);
  assert.match(sql, /toString\(toTimeZone\(MinTimestamp, 'UTC'\)\) AS first_timestamp/);
  assert.match(sql, /JSONExtract\(AttributesJSON, 'Map\(String,String\)'\) AS attributes/);
  assert.doesNotMatch(sql, /GROUP BY|otel_logs|uniqExactMerge/);
  assert.equal(params.from, "2026-10-01 00:00:15");
  assert.equal(params.to, "2026-10-26 00:00:45");
});

test("diagnostic model-session evidence precedes backend filtering and retains user/project identity", () => {
  const { sql, params } = diagnosticSelection(from, to,
    { user: "fixture'", model: "model'", backend: "bedrock-runtime" });
  const modelSessions = sql.slice(sql.indexOf("model_sessions AS"), sql.indexOf("SELECT toString"));
  assert.match(modelSessions, /SELECT ConversationId, UserEmail, ProjectName FROM diagnostic_events/);
  assert.match(modelSessions, /ConversationId != ''/);
  assert.match(modelSessions, /positionCaseInsensitive\(Model, \{clientModel:String\}\)/);
  assert.doesNotMatch(modelSessions, /clientBackend/);
  for (const event of ["sse_event", "websocket_event", "api_request", "api_error", "tool_result", "tool_decision", "turn_ttft"])
    assert.ok(modelSessions.includes(`'codex.${event}'`), event);
  assert.match(sql, /\(ConversationId, UserEmail, ProjectName\) IN \(SELECT \* FROM model_sessions\)/);
  assert.match(sql, /Model = ''/);
  assert.match(sql, /positionCaseInsensitive\(UserEmail, \{clientUser:String\}\)/);
  assert.match(sql, /Backend = \{clientBackend:String\}/);
  assert.doesNotMatch(sql, /fixture'|model'/);
  assert.equal(params.clientUser, "fixture'");
  assert.equal(params.clientModel, "model'");
});
