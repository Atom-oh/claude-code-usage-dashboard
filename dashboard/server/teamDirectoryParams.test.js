import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setDirectorySnapshot, directoryParams, directoryMeta, directoryVersion } from "./teamDirectoryParams.js";
import { toChDateTime } from "./clickhouse.js";

beforeEach(() => setDirectorySnapshot(null, "none"));

test("unset snapshot adds empty arrays only for directory SQL", () => {
  assert.equal(directoryVersion(), "none");
  assert.deepEqual(directoryMeta(), { labels: {}, historyStart: null });
  assert.deepEqual(directoryParams("SELECT {dirKey:Array(String)}", { a: 1 }),
    { a: 1, dirIssuer: "", dirKey: [], dirTeam: [], dirFrom: [], dirTo: [] });
  assert.deepEqual(directoryParams("SELECT 1", { a: 1 }), { a: 1 });
});

test("interval times use the same format as toChDateTime", () => {
  const ms = 1731542400999;
  setDirectorySnapshot({ issuer: "i", keys: ["k"], teams: ["t"], froms: [ms], tos: [4102444800000], labels: { t: "T" }, historyStart: 5 }, "v1");
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.deepEqual(params.dirFrom, [toChDateTime(new Date(ms))]);
  assert.deepEqual(params.dirTo, [toChDateTime(new Date(4102444800000))]);
  assert.equal(directoryVersion(), "v1");
  assert.deepEqual(directoryMeta(), { labels: { t: "T" }, historyStart: 5 });
});
