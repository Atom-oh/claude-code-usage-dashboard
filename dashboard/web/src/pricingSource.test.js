import { expect, test } from "vitest";
import { formatPriceListTime, priceSourceText } from "./pricingSource.js";

const utc = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", timeZone: "UTC" });
const FALLBACK = "목록에 없는 모델은 서버 내장 단가표를 쓰고, 운영자 단가 설정이 있으면 그 값이 우선합니다.";

test("runtime source names the live lookup and fetch time", () => {
  expect(priceSourceText({ source: "runtime", fetchedAt: "2026-10-28T03:19:00Z", models: [] }, utc))
    .toBe(`단가 출처: AWS Price List 실시간 조회(2026-10-28 03:19 UTC 조회). ${FALLBACK}`);
});

test("snapshot source names the build snapshot and fetch time", () => {
  expect(priceSourceText({ source: "snapshot", fetchedAt: "2026-10-28T03:19:00Z", models: [] }, utc))
    .toBe(`단가 출처: AWS Price List 빌드 스냅샷(2026-10-28 03:19 UTC 조회). ${FALLBACK}`);
});

test("missing or invalid fetch time stays explicit", () => {
  expect(priceSourceText({ source: "snapshot", fetchedAt: null }, utc)).toContain("(조회 시각 미확인)");
  expect(priceSourceText({ source: "snapshot", fetchedAt: "not a date" }, utc)).toContain("(조회 시각 미확인)");
});

test("code source names the built-in table", () => {
  expect(priceSourceText({ source: "code", fetchedAt: null, models: [] }, utc))
    .toBe("단가 출처: 서버 내장 단가표(AWS Price List 단가 없음). 운영자 단가 설정이 있으면 그 값이 우선합니다.");
});

test("absent or unknown source is reported as unknown", () => {
  expect(priceSourceText(undefined, utc)).toBe("단가 출처: 미확인.");
  expect(priceSourceText({}, utc)).toBe("단가 출처: 미확인.");
  expect(priceSourceText({ source: "other" }, utc)).toBe("단가 출처: 미확인.");
});

test("formatPriceListTime formats minutes with zone and rejects non-strings", () => {
  expect(formatPriceListTime("2026-10-28T03:19:00Z", utc)).toBe("2026-10-28 03:19 UTC");
  expect(formatPriceListTime(undefined)).toBeNull();
});
