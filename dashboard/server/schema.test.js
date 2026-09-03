import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySeriesKeyProbe, classifyMigrations } from "./schema.js";

test("classifySeriesKeyProbe returns true when only segment keys matched", () => {
  assert.strictEqual(classifySeriesKeyProbe({ seg: 2000, legacy: 0 }), true);
});

test("classifySeriesKeyProbe returns false when only legacy keys matched", () => {
  assert.strictEqual(classifySeriesKeyProbe({ seg: 0, legacy: 2000 }), false);
});

test("classifySeriesKeyProbe returns null on mixed counts (MATERIALIZE COLUMN in flight)", () => {
  assert.strictEqual(classifySeriesKeyProbe({ seg: 1200, legacy: 800 }), null);
});

test("classifySeriesKeyProbe returns null when no rows matched either key", () => {
  assert.strictEqual(classifySeriesKeyProbe({ seg: 0, legacy: 0 }), null);
});

// 실측(2026-09-02): @clickhouse/client는 JSONEachRow에서 UInt64 집계를 문자열로 돌려준다
// ({"seg":"0","legacy":"7"}, typeof === "string"). `legacy === 0` 같은 엄격 비교로 짜면
// 문자열 "0"과 절대 같지 않아 이 함수가 영구히 null만 반환하고, 기능은 에러 없이 조용히
// 죽는다 — 이 두 케이스가 그 버그를 실제로 잡아내는 유일한 단정문이다(1~4번은 이미 숫자라
// 우연히 동작하는 잘못된 구현도 통과시킨다).
test("classifySeriesKeyProbe coerces string inputs (real client returns UInt64 as JSON string)", () => {
  assert.strictEqual(classifySeriesKeyProbe({ seg: "2000", legacy: "0" }), true);
  assert.strictEqual(classifySeriesKeyProbe({ seg: "0", legacy: "7" }), false);
});

test("classifySeriesKeyProbe returns null on garbage input (Number.isFinite guard)", () => {
  assert.strictEqual(classifySeriesKeyProbe({}), null);
});

test("classifyMigrations returns a sorted unique array for number rows", () => {
  assert.deepStrictEqual(classifyMigrations([{ version: 2 }, { version: 3 }]), [2, 3]);
});

test("classifyMigrations coerces string version rows and sorts them", () => {
  assert.deepStrictEqual(classifyMigrations([{ version: "3" }, { version: "2" }]), [2, 3]);
});

test("classifyMigrations collapses duplicate versions", () => {
  assert.deepStrictEqual(
    classifyMigrations([{ version: 3 }, { version: 3 }, { version: 2 }]),
    [2, 3]
  );
});

test("classifyMigrations returns an empty array for an empty ledger (measured, not unknown)", () => {
  assert.deepStrictEqual(classifyMigrations([]), []);
});

test("classifyMigrations returns null for undefined (undetermined)", () => {
  assert.strictEqual(classifyMigrations(undefined), null);
});

test("classifyMigrations returns null for null (undetermined)", () => {
  assert.strictEqual(classifyMigrations(null), null);
});

test("classifyMigrations returns null for a non-array", () => {
  assert.strictEqual(classifyMigrations({}), null);
});

// 기본 Array#sort는 사전식이라 [10, 2]가 그대로 [10, 2]로 돌아온다 — 숫자 비교자
// (a, b) => a - b가 없으면 이 케이스가 깨진다.
test("classifyMigrations sorts numerically, not lexicographically", () => {
  assert.deepStrictEqual(classifyMigrations([{ version: 10 }, { version: 2 }]), [2, 10]);
});
