import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReadonly } from "./clickhouse.js";

test("classifyReadonly is true for readonly=1", () => {
  assert.strictEqual(classifyReadonly({ ro: 1 }), true);
});

test("classifyReadonly is true for readonly=2 (read-only plus settings changes)", () => {
  assert.strictEqual(classifyReadonly({ ro: 2 }), true);
});

test("classifyReadonly is false for readonly=0", () => {
  assert.strictEqual(classifyReadonly({ ro: 0 }), false);
});

// 실측(2026-09-02): @clickhouse/client는 JSONEachRow에서 정수를 문자열로 돌려줄 수 있다
// (예: {"ro":"1"}, typeof === "string"). Number() 없이 짜면 Number.isFinite("1")이 false를
// 반환해(isFinite는 타입 강제 변환을 하지 않는다) 이 함수가 문자열 입력마다 조용히 null만
// 반환하고 기능이 에러 없이 죽는다 — 이 케이스가 그 버그를 실제로 잡아내는 유일한 단정문이다
// (1~3번은 입력이 이미 숫자라 강제 변환이 있든 없든 통과한다).
test("classifyReadonly coerces string inputs (the client can return integers as JSON strings)", () => {
  assert.strictEqual(classifyReadonly({ ro: "1" }), true);
  assert.strictEqual(classifyReadonly({ ro: "2" }), true);
  assert.strictEqual(classifyReadonly({ ro: "0" }), false);
});

test("classifyReadonly is null when the row is missing or empty", () => {
  assert.strictEqual(classifyReadonly(undefined), null);
  assert.strictEqual(classifyReadonly(null), null);
  assert.strictEqual(classifyReadonly({}), null);
});

test("classifyReadonly is null when ro is not a number", () => {
  assert.strictEqual(classifyReadonly({ ro: "abc" }), null);
  assert.strictEqual(classifyReadonly({ ro: {} }), null);
});

test("classifyReadonly is null for an explicitly null ro", () => {
  assert.strictEqual(classifyReadonly({ ro: null }), null);
});
