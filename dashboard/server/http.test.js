import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError, parseRange, parseIntervalHours, parseGroupMode, parsePositiveInt, parseFilters } from "./http.js";

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

test("parseGroupMode defaults to ab and rejects anything but ab/single", () => {
  assert.strictEqual(parseGroupMode(undefined), "ab");
  assert.strictEqual(parseGroupMode(""), "ab");
  assert.strictEqual(parseGroupMode("ab"), "ab");
  assert.strictEqual(parseGroupMode("single"), "single");
  for (const raw of ["AB", "Single", "nope", "0"]) {
    assert.throws(() => parseGroupMode(raw), /"ab".*"single"|"single".*"ab"/);
  }
});

test("parsePositiveInt returns the fallback when absent, and validates otherwise", () => {
  assert.strictEqual(parsePositiveInt(undefined, 90), 90);
  assert.strictEqual(parsePositiveInt("", 90), 90);
  const n = parsePositiveInt("7", 90);
  assert.strictEqual(n, 7);
  assert.strictEqual(typeof n, "number");
  for (const raw of ["0", "1.5", "abc", "-3"]) {
    assert.throws(() => parsePositiveInt(raw, 90));
  }
  // min이 하드코딩이 아니라 실제로 존중되는지 확인 — 기본 min:1이면 "0"은 거부되지만
  // min:0을 넘기면 통과해야 한다.
  assert.strictEqual(parsePositiveInt("0", 90, { min: 0 }), 0);
});

test("parseRange honors a configured defaultDays when from is absent", () => {
  const { from, to } = parseRange({ to: "2026-08-10T00:00:00Z" }, { defaultDays: 7 });
  assert.strictEqual(to.getTime() - from.getTime(), 7 * 86400000);
});

// 상한 경계는 strictly greater — 정확히 capDays와 같은 길이는 통과해야 90일 프리셋에 90일
// 상한을 걸어도 400이 나지 않는다. 한쪽만 검사하면 >과 >=를 구분할 수 없다.
test("parseRange cap boundary: exactly capDays passes, one ms more throws", () => {
  const from = new Date("2026-01-01T00:00:00Z");
  const exact = new Date(from.getTime() + 90 * 86400000);
  const overByOneMs = new Date(exact.getTime() + 1);

  const { from: f, to: t } = parseRange(
    { from: from.toISOString(), to: exact.toISOString() },
    { capDays: 90 }
  );
  assert.strictEqual(t.getTime() - f.getTime(), 90 * 86400000);

  assert.throws(
    () => parseRange({ from: from.toISOString(), to: overByOneMs.toISOString() }, { capDays: 90 }),
    (err) => err instanceof ValidationError && err.status === 400 && err.message === "range too long"
  );
});

test("a range-too-long error carries status 400 and does not echo either timestamp", () => {
  const from = "2026-01-01T00:00:00Z";
  const to = "2026-06-01T00:00:00Z";
  try {
    parseRange({ from, to }, { capDays: 90 });
    assert.fail("expected parseRange to throw");
  } catch (err) {
    assert.strictEqual(err instanceof ValidationError, true);
    assert.strictEqual(err.status, 400);
    assert.strictEqual(err.detail.includes(from), false);
    assert.strictEqual(err.detail.includes(to), false);
  }
});

// project 필터는 005 컬럼이 있는 클러스터에서만 SQL에 들어갈 수 있다 — 프로브가 true가
// 아니면(false = 미적용, null = 확인 못 함) 조용히 버려야 한다. `=== true`가 아니라 truthy
// 검사로 짜면 null이 통과해 쿼리 전체가 UNKNOWN_IDENTIFIER로 죽는다.
test("parseFilters passes project through only when projectColumns is exactly true", () => {
  const q = { group: "bedrock", user: "u@x", model: "claude-sonnet-5", project: "repo-a" };
  assert.deepStrictEqual(parseFilters(q, true), {
    group: "bedrock",
    user: "u@x",
    model: "claude-sonnet-5",
    project: "repo-a",
  });
  for (const probe of [false, null, undefined, "true", 1]) {
    assert.strictEqual(parseFilters(q, probe).project, undefined, `projectColumns=${String(probe)} must drop project`);
  }
});

test("parseFilters leaves the other three filters untouched and undefined when absent", () => {
  assert.deepStrictEqual(parseFilters({}, true), {
    group: undefined,
    user: undefined,
    model: undefined,
    project: undefined,
  });
  const only = parseFilters({ user: "u@x" }, false);
  assert.strictEqual(only.user, "u@x");
  assert.strictEqual(only.project, undefined);
});
