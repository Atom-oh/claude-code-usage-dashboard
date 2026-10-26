import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexQuery } from "./clientMetrics.js";
import { costSourceForRange, parseCostReadFrom } from "./codexCostSource.js";

const from = new Date("2026-10-01T00:00:15Z");
const to = new Date("2026-10-26T00:00:45Z");

test("cost facts replace raw scans while retaining the existing grouping contract", () => {
  const { sql, params } = buildCodexQuery(from, to, { userExact: "synthetic@example.test" },
    undefined, "codex", 3600, { costView: true, costSource: "facts" });
  assert.match(sql, /claude_code\.codex_cost_events_v1/);
  assert.match(sql, /claude_code\.codex_cost_scope_v1/);
  assert.doesNotMatch(sql, /FROM claude_code\.otel_logs/);
  assert.doesNotMatch(sql, /mapSort|toFloat64OrZero/);
  assert.match(sql, /GROUP BY Timestamp, Identity/);
  assert.match(sql, /groupUniqArrayMerge\(Seconds\)/);
  assert.match(sql, /requires_usage/);
  assert.equal(params.clientUserExact, "synthetic@example.test");
});

test("facts selection is restricted to Codex cost views", () => {
  for (const [client, costView] of [["codex", false], ["claude", true], ["claude", false]]) {
    const { sql } = buildCodexQuery(from, to, {}, undefined, client, 3600,
      { costView, costSource: "facts" });
    assert.match(sql, /FROM claude_code\.otel_logs/);
    assert.doesNotMatch(sql, /codex_cost_events_v1/);
  }
});

test("raw remains the default cost source", () => {
  const { sql } = buildCodexQuery(from, to, {}, undefined, "codex", 3600, { costView: true });
  assert.match(sql, /FROM claude_code\.otel_logs/);
});

test("activation requires verified coverage of the whole range", () => {
  assert.equal(parseCostReadFrom(""), null);
  assert.equal(parseCostReadFrom(undefined), null);
  const boundary = parseCostReadFrom("2026-10-01T00:00:15Z");
  assert.equal(costSourceForRange(from, boundary), "facts");
  assert.equal(costSourceForRange(new Date(+from - 1000), boundary), "raw");
  assert.equal(costSourceForRange(from, null), "raw");
  for (const value of ["2026-10-01", "2026-02-30T00:00:00Z", "2026-10-01T00:00:00+00:00", "invalid"])
    assert.throws(() => parseCostReadFrom(value), /CODEX_COST_READ_FROM/);
});
