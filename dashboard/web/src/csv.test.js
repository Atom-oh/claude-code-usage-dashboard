import { afterEach, expect, test } from "vitest";
import { toCsv, csvFilename } from "./csv.js";
import { setPiiMask } from "./fmt.js";

// fmt.js의 piiMask는 모듈 전역 let이다 — 마스킹 케이스가 그걸 바꾸므로 각 테스트가
// 자기 상태를 세팅하고 기본값(fail-closed ON)으로 되돌린다.
afterEach(() => setPiiMask(true));

test("header from labels, empty rows -> header only", () => {
  const csv = toCsv(
    [
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ],
    []
  );
  expect(csv).toBe("\uFEFF" + "A,B");
});

test("BOM at index 0", () => {
  const csv = toCsv([{ key: "a", label: "A" }], []);
  expect(csv.charCodeAt(0)).toBe(0xfeff);
});

test("quoting: comma, doubled quote, CRLF", () => {
  const csv = toCsv([{ key: "v", label: "V" }], [{ v: 'a"b' }, { v: "x,y" }]);
  const rows = csv.slice(1).split("\r\n");
  expect(rows[0]).toBe("V");
  expect(rows[1]).toBe('"a""b"');
  expect(rows[2]).toBe('"x,y"');

  // CRLF를 담은 필드는 따옴표 안에 CRLF를 그대로 남긴다(RFC 4180) — 그래서 이 케이스만은
  // 전체를 \r\n으로 쪼개 행 단위로 볼 수 없다(그 필드 안에서도 쪼개진다). 전체 문자열을 본다.
  expect(toCsv([{ key: "v", label: "V" }], [{ v: "line1\r\nline2" }])).toBe(`﻿V\r\n"line1\r\nline2"`);
});

test("CRLF between rows, none at the end", () => {
  const csv = toCsv(
    [{ key: "v", label: "V" }],
    [{ v: "1" }, { v: "2" }]
  );
  // BOM은 헤더 줄 앞에 붙으므로 먼저 떼고 쪼갠다 — 안 그러면 parts[0]이 "﻿V"다.
  const parts = csv.slice(1).split("\r\n");
  expect(parts.length).toBe(3);
  expect(parts).toEqual(["V", "1", "2"]);
});

test("toText takes precedence over the raw value", () => {
  const columns = [
    { key: "n", label: "N", toText: (v, r) => `${v}/${r.d}` },
    { key: "m", label: "M" },
  ];
  const csv = toCsv(columns, [{ n: 5, d: "x", m: 7 }]);
  const rows = csv.slice(1).split("\r\n");
  expect(rows[1]).toBe("5/x,7");
});

test("toText receives the row as its second argument", () => {
  const columns = [{ key: "n", label: "N", toText: (v, r) => `${v}/${r.d}` }];
  const csv = toCsv(columns, [{ n: 5, d: "day-value" }]);
  const rows = csv.slice(1).split("\r\n");
  expect(rows[1]).toBe("5/day-value");
});

test("masked user", () => {
  setPiiMask(true);
  const csv = toCsv([{ key: "user", label: "U" }], [{ user: "alice@example.com" }], { piiMask: true });
  expect(csv).toContain("al******@example.com");
  expect(csv).not.toContain("alice@example.com");
});

test("unmasked user", () => {
  setPiiMask(false);
  const csv = toCsv([{ key: "user", label: "U" }], [{ user: "alice@example.com" }], { piiMask: false });
  expect(csv).toContain("alice@example.com");
});

test("a users count column is untouched in masked mode", () => {
  setPiiMask(true);
  const csv = toCsv([{ key: "users", label: "사용자" }], [{ users: 12 }], { piiMask: true });
  const rows = csv.slice(1).split("\r\n");
  expect(rows[1]).toBe("12");
});

test("csvFilename format", () => {
  const name = csvFilename("cost_by_model", new Date("2026-08-01T00:00:00Z"), new Date("2026-09-03T23:59:00Z"));
  expect(name).toBe("cost_by_model_20260801_20260903.csv");
});

// 이 검사는 호스트 타임존이 UTC면 아무것도 핀하지 못한다(실측 2026-09-03: 이 머신과 CI가
// TZ 미설정=UTC라, getUTCFullYear를 getFullYear로 바꾼 뮤테이션이 11개 테스트를 전부 통과했다).
// process.env.TZ 대입은 그 뒤에 생성되는 Date에 즉시 반영되므로(실측: 23:30Z가 로컬 8/1 →
// 8/2로 바뀜), 구간을 만들기 전에 non-UTC 존을 강제해 UTC/로컬 구분이 실제로 생기게 한다.
test("csvFilename uses the UTC calendar day, not the local one", () => {
  const saved = process.env.TZ;
  try {
    // 연말 경계를 고른다: 2026-12-31T23:30Z는 서울에서 2027-01-01이라 연·월·일이 한꺼번에
    // 갈린다. 한 항목만 갈리는 구간(예: 8/1 23:30Z)을 쓰면 월·연 getter를 로컬로 바꾼
    // 뮤테이션이 살아남는다(실측 2026-09-03).
    process.env.TZ = "Asia/Seoul"; // UTC+09
    const d = new Date("2026-12-31T23:30:00Z");
    // 통제 단정문 — 이 fixture가 UTC와 로컬을 실제로 구분한다는 것부터 확인한다.
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).not.toEqual([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]);
    expect(d.getFullYear()).not.toBe(d.getUTCFullYear());
    expect(d.getMonth()).not.toBe(d.getUTCMonth());
    expect(d.getDate()).not.toBe(d.getUTCDate());
    expect(csvFilename("x", d, d)).toBe("x_20261231_20261231.csv");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("csvFilename degrades when a date is missing or invalid", () => {
  expect(csvFilename("cost_by_model", undefined, undefined)).toBe("cost_by_model.csv");
  expect(csvFilename("cost_by_model", new Date("not-a-date"), new Date("2026-09-03T23:59:00Z"))).toBe("cost_by_model.csv");
});
