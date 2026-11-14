import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { setDirectorySnapshot, directoryParams, directoryMeta, directoryVersion } from "./teamDirectoryParams.js";
import { toChDateTime } from "./clickhouse.js";

beforeEach(() => setDirectorySnapshot(null, "none"));

test("unset snapshot adds empty arrays only for directory SQL", () => {
  assert.equal(directoryVersion(), "none");
  assert.deepEqual(directoryMeta(), { labels: {}, historyStart: null, directory: false });
  assert.deepEqual(directoryParams("SELECT {dirKey:Array(String)}", { a: 1 }),
    { a: 1, dirIssuer: "", dirKey: [], dirTeam: [], dirFrom: [], dirTo: [] });
  assert.deepEqual(directoryParams("SELECT 1", { a: 1 }), { a: 1 });
});

test("interval times use the same format as toChDateTime", () => {
  const ms = 1731542400999;
  setDirectorySnapshot({ issuer: "i", keys: ["k"], teams: ["t"], froms: [ms], tos: [4102444800000], labels: { t: "T" }, historyStart: 5, directory: true }, "v1");
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.deepEqual(params.dirFrom, [toChDateTime(new Date(ms))]);
  assert.deepEqual(params.dirTo, [toChDateTime(new Date(4102444800000))]);
  assert.equal(directoryVersion(), "v1");
  assert.deepEqual(directoryMeta(), { labels: { t: "T" }, historyStart: 5, directory: true });
});

test("4,000 realistic intervals stay below 900,000 bytes of URL-encoded query parameters", () => {
  // The client's own formatter, as used for param_* query-string values.
  const { formatQueryParams } = createRequire(import.meta.url)("@clickhouse/client/dist/common/data_formatter/format_query_params.js");
  const count = 4000;
  setDirectorySnapshot({
    issuer: "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_Example1",
    keys: Array.from({ length: count }, (_, i) => createHash("sha256").update(`user${i}@example.com`).digest("hex")),
    teams: Array.from({ length: count }, (_, i) => `field-team-${String(i).padStart(4, "0")}-${"x".repeat(24)}`),
    froms: Array.from({ length: count }, (_, i) => 1731542400000 + i * 1000),
    tos: Array.from({ length: count }, () => 4102444800000),
  }, "v");
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.equal(params.dirKey.length, count);
  assert.ok(params.dirTeam.every((team) => team.length === 40));
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [`param_${key}`, formatQueryParams({ value })]));
  assert.ok(query.toString().length < 900000, `${query.toString().length} bytes`);
});
