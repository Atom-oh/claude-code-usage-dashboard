import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError, parseRange, parseIntervalHours } from "./http.js";

test("parseRange returns the requested window when both dates are valid", () => {
  const { from, to } = parseRange({ from: "2026-08-01T00:00:00Z", to: "2026-08-03T00:00:00Z" });
  assert.strictEqual(from.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.strictEqual(to.toISOString(), "2026-08-03T00:00:00.000Z");
});

test("parseRange defaults to a 2-day window ending now when from and to are absent", () => {
  const { from, to } = parseRange({});
  assert.strictEqual(to.getTime() - from.getTime(), 2 * 86400000);
});

// 빈 문자열은 미지정과 같게 취급한다(truthiness 규칙) — `=== undefined` 구현이면 여기서 실패한다.
test("parseRange treats an empty from/to the same as absent", () => {
  const { from, to } = parseRange({ from: "", to: "" });
  assert.strictEqual(to.getTime() - from.getTime(), 2 * 86400000);
});

test("parseRange rejects an unparseable to", () => {
  assert.throws(
    () => parseRange({ to: "garbage" }),
    (err) => err instanceof ValidationError && err.status === 400
  );
});

test("parseRange rejects an unparseable from", () => {
  assert.throws(
    () => parseRange({ from: "garbage", to: "2026-08-03T00:00:00Z" }),
    (err) => err instanceof ValidationError && err.status === 400
  );
});

test("parseRange rejects from equal to to", () => {
  assert.throws(
    () => parseRange({ from: "2026-08-01T00:00:00Z", to: "2026-08-01T00:00:00Z" }),
    (err) => err instanceof ValidationError && err.status === 400
  );
});

test("parseRange rejects from after to", () => {
  assert.throws(
    () => parseRange({ from: "2026-08-03T00:00:00Z", to: "2026-08-01T00:00:00Z" }),
    (err) => err instanceof ValidationError && err.status === 400
  );
});

test("parseRange rejects an array-valued to (Express parses ?to=a&to=b as an array)", () => {
  assert.throws(
    () => parseRange({ to: ["2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"] }),
    (err) => err instanceof ValidationError && err.status === 400
  );
});

test("parseIntervalHours defaults to 24 when absent or empty", () => {
  assert.strictEqual(parseIntervalHours(undefined), 24);
  assert.strictEqual(parseIntervalHours(""), 24);
  assert.strictEqual(parseIntervalHours(undefined, 1), 1);
});

test("parseIntervalHours accepts a fractional minute bucket", () => {
  assert.strictEqual(parseIntervalHours("0.25"), 0.25);
});

test("parseIntervalHours accepts the 24*31 upper bound and rejects one hour past it", () => {
  assert.strictEqual(parseIntervalHours("744"), 24 * 31);
  assert.throws(
    () => parseIntervalHours("745"),
    (err) => err instanceof ValidationError && err.status === 400
  );
});

test("parseIntervalHours rejects zero, negatives, non-numbers and absurd values", () => {
  for (const raw of ["0", "-1", "-0.25", "abc", "1e9", "Infinity", "NaN", ["1", "2"]]) {
    assert.throws(
      () => parseIntervalHours(raw),
      (err) => err instanceof ValidationError && err.status === 400
    );
  }
});

test("ValidationError carries status 400 and a non-empty detail", () => {
  assert.throws(
    () => parseRange({ to: "garbage" }),
    (err) =>
      err instanceof ValidationError &&
      err.status === 400 &&
      err.name === "ValidationError" &&
      typeof err.detail === "string" &&
      err.detail.length > 0
  );
});

// 제출한 값이 에러 본문에 그대로 반사되지 않는다는 규칙을 나중에 슬쩍 완화하지 못하게 고정하는 테스트.
test("a validation error never echoes the submitted value", () => {
  try {
    parseRange({ to: "CANARY-9c1f" });
    assert.fail("expected parseRange to throw");
  } catch (err) {
    assert.strictEqual(err.message.includes("CANARY-9c1f"), false);
    assert.strictEqual(err.detail.includes("CANARY-9c1f"), false);
  }
});
