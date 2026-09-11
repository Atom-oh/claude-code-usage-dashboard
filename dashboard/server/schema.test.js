import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySeriesKeyProbe, classifyMigrations, classifyProjectColumnsProbe } from "./schema.js";

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

// 실측(2026-09-09): 컬럼이 없으면 @clickhouse/client가 code '47'/type 'UNKNOWN_IDENTIFIER'인
// ClickHouseError를, 접속 불가면 code 'ECONNREFUSED'인 평범한 Error를 던진다. 이 두 케이스를
// 같은 false로 접으면 "005 미적용"과 "클러스터에 못 붙었다"를 구분할 수 없어진다.
test("classifyProjectColumnsProbe returns true when the probe query succeeded", () => {
  assert.strictEqual(classifyProjectColumnsProbe(null), true);
  assert.strictEqual(classifyProjectColumnsProbe(undefined), true);
});

test("classifyProjectColumnsProbe returns false for a server-side SQL rejection (numeric code)", () => {
  assert.strictEqual(classifyProjectColumnsProbe({ code: "47", type: "UNKNOWN_IDENTIFIER" }), false);
  // 드라이버가 code를 숫자로 주더라도 같은 판정이어야 한다(String() 강제 변환).
  assert.strictEqual(classifyProjectColumnsProbe({ code: 47 }), false);
});

test("classifyProjectColumnsProbe returns null for a transport failure (non-numeric code)", () => {
  assert.strictEqual(classifyProjectColumnsProbe({ code: "ECONNREFUSED" }), null);
  assert.strictEqual(classifyProjectColumnsProbe({ code: "ETIMEDOUT" }), null);
  // 호스트가 뮤테이션으로 확인(2026-09-09): 정규식의 앵커(^...$)를 떼면 이 케이스만 판정이
  // 뒤집힌다 — 자리수를 품은 전송 계층 코드가 실재하므로(Node의 ERR_HTTP2_*) "숫자가 섞여
  // 있음"이 아니라 "전부 숫자"여야 서버 거절로 볼 수 있다.
  assert.strictEqual(classifyProjectColumnsProbe({ code: "ERR_HTTP2_STREAM_ERROR" }), null);
  assert.strictEqual(classifyProjectColumnsProbe(new Error("boom")), null);
  assert.strictEqual(classifyProjectColumnsProbe({ code: "" }), null);
});
