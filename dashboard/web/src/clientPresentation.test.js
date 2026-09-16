import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { presentationRow, formatPercent, formatClientTime } from "./clientPresentation.js";
import { codexUsage } from "./test/clientOverview.js";

test("cache fractions use all input while reasoning remains a subset of output", () => {
  const row = presentationRow(codexUsage);
  expect(row.input_total).toBe(220);
  expect(row.cache_read_pct).toBeCloseTo(45.454545);
  expect(row.reasoning_pct).toBe(30);
  expect(row.tokens_per_session).toBe(270);
  expect(row.cost_per_session).toBe(0.0042405);
  expect(row.usd_per_million_tokens).toBeCloseTo(15.7055556);
  expect(row.tokens).toBe(270);
  expect(codexUsage).not.toHaveProperty("input_total");
});

test.each([null, undefined, "", " ", false, NaN, Infinity, -1])(
  "unknown/invalid numeric value %j cannot become zero or a derived percentage",
  (value) => {
    const row = presentationRow({ ...codexUsage, cost_usd: value, reasoning_tokens: value, cache_write_tokens: value });
    expect(row.cost_per_session).toBeNull();
    expect(row.usd_per_million_tokens).toBeNull();
    expect(row.reasoning_pct).toBeNull();
    expect(row.cache_read_pct).toBeNull();
    expect(formatPercent(row.reasoning_pct)).toBe("—");
  },
);

test("zero numerators are observed; absent and zero denominators are not ratios", () => {
  const row = presentationRow({ ...codexUsage, cost_usd: 0, reasoning_tokens: 0, api_errors: 0, users: null, sessions: 0 });
  expect(row.reasoning_pct).toBe(0);
  expect(row.cost_per_user).toBeNull();
  expect(row.cost_per_session).toBeNull();
  expect(row.tokens_per_session).toBeNull();
  expect(row.error_records_per_request).toBe(0);
  expect(formatPercent(row.reasoning_pct)).toBe("0%");
  expect(presentationRow({ ...codexUsage, output_tokens: 0 }).reasoning_pct).toBeNull();
});

test("error records/request may exceed one, but impossible token subsets are unavailable", () => {
  const row = presentationRow({ ...codexUsage, api_errors: 5, requests: 2, reasoning_tokens: 51 });
  expect(row.error_records_per_request).toBe(2.5);
  expect(row.reasoning_pct).toBeNull();
});

test("an enabled client without observations cannot appear as measured zero", () => {
  const row = presentationRow({ ...codexUsage, observed_records: 0, tokens: 0, cost_usd: 0, requests: 0 });
  expect(row.tokens).toBeNull();
  expect(row.cost_usd).toBeNull();
  expect(row.requests).toBeNull();
  expect(row.cost_per_session).toBeNull();
  expect(row.cost_basis).toBe("aws_list_estimate");
});

test("timestamp parsing preserves the instant for both API forms", () => {
  expect(formatClientTime("2026-09-01 03:04:00")).toBe(formatClientTime("2026-09-01T03:04:00.000Z"));
  expect(formatClientTime(null)).toBe("—");
});


test.each([
  ["Asia/Seoul", "05:04", /9\.\s*2\./],
  ["America/New_York", "16:04", /9\.\s*1\./],
])("timestamp labels follow the browser zone %s, including date rollover", (zone, clock, date) => {
  const moduleUrl = pathToFileURL(resolve("src/clientPresentation.js")).href;
  const script = `import { formatClientTime, formatClientTimestamp, BROWSER_TIME_ZONE } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify({
      iso: formatClientTime("2026-09-01T20:04:23.789Z"),
      full: formatClientTimestamp("2026-09-01T20:04:23.789Z"),
      winter: formatClientTimestamp("2026-01-01T03:04:23.789Z"),
      zone: BROWSER_TIME_ZONE,
      invalid: formatClientTimestamp("invalid"),
      naive: formatClientTime("2026-09-01 20:04:23.789"),
      offset: formatClientTime("2026-09-02T05:04:23.789+09:00"),
    }));`;
  const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { encoding: "utf8", env: { ...process.env, TZ: zone } }));
  expect(actual.iso).toContain(clock);
  expect(actual.full).toContain(clock);
  expect(actual.full).toContain("23.789");
  expect(actual.full).toContain("2026");
  expect(actual.zone).toBe(zone);
  expect(actual.invalid).toBe("—");
  if (zone === "America/New_York") {
    expect(actual.winter).toContain("2025");
    expect(actual.winter).toContain("22:04");
  }
  expect(actual.iso).toMatch(date);
  expect(actual.naive).toBe(actual.iso);
  expect(actual.offset).toBe(actual.iso);
});
