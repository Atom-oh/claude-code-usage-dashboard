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

test("observed token counts never replace canonical denominators or token subsets", () => {
  const row = presentationRow({ ...codexUsage, observed_tokens: 148, tokens_partial: false });
  expect(row.observed_tokens).toBe(148);
  expect(row.tokens).toBe(270);
  expect(row.tokens_per_session).toBe(270);
  expect(row.usd_per_million_tokens).toBeCloseTo(15.7055556);
  expect(row.cache_read_pct).toBeCloseTo(45.454545);
  expect(row.reasoning_pct).toBe(30);
  expect(row.token_status).toBe("관측됨");
});

test("usable observed token subtotals keep unavailable canonical ratios unavailable", () => {
  const row = presentationRow({ ...codexUsage, observed_tokens: 148, tokens_partial: true,
    tokens: null, input_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    output_tokens: null, reasoning_tokens: null });
  expect(row.observed_tokens).toBe(148);
  expect(row.token_status).toBe("부분합");
  for (const key of ["tokens", "input_total", "cache_read_pct", "reasoning_pct",
    "tokens_per_session", "usd_per_million_tokens"]) expect(row[key]).toBeNull();
  expect(row.cost_usd).toBe(0.0042405);
  expect(row.cost_per_session).toBe(0.0042405);
});

test("partial aggregate overflow suppresses canonical token rates without changing component fractions", () => {
  const row = presentationRow({ ...codexUsage, tokens: 1e20, observed_tokens: null, tokens_partial: true });
  expect(row.tokens).toBe(1e20);
  expect(row.observed_tokens).toBeNull();
  expect(row.tokens_per_session).toBeNull();
  expect(row.usd_per_million_tokens).toBeNull();
  expect(row.cache_read_pct).toBeCloseTo(45.454545);
  expect(row.reasoning_pct).toBe(30);
  expect(row.cost_per_session).toBe(0.0042405);
});

test.each([
  [{}, 270, "관측됨"],
  [{ observed_tokens: null }, null, "미확인"],
  [{ observed_tokens: undefined }, null, "미확인"],
  [{ observed_tokens: -1 }, null, "미확인"],
  [{ observed_tokens: 1.5 }, null, "미확인"],
  [{ observed_tokens: Number.MAX_SAFE_INTEGER + 1 }, null, "미확인"],
  [{ observed_tokens: false }, null, "미확인"],
  [{ observed_tokens: 0, tokens_partial: true }, 0, "부분합"],
  [{ observed_tokens: null, tokens_partial: true }, null, "미확인"],
  [{ observed_tokens: 148, unpriced: 2, cost_partial: true }, 148, "관측됨"],
  [{ observed_tokens: 0, observed_records: 0 }, null, "미확인"],
  [{ observed_tokens: 0, observed_records: 0, timeline_observed: true }, 0, "관측됨"],
  [{ observed_tokens: null, observed_records: 0, timeline_observed: true }, null, "미확인"],
])("observed token display preserves absence, null, zero and independent cost status: %j",
  (fields, value, status) => {
    const row = presentationRow({ ...codexUsage, ...fields });
    expect(row.observed_tokens).toBe(value);
    expect(row.token_status).toBe(status);
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

test.each([
  ["client_reported", "클라이언트 보고"],
  ["aws_list_estimate", "AWS 정가 추정"],
])("known-cost units retain observed denominators and label partial %s subtotals", (cost_basis, label) => {
  const row = presentationRow({ ...codexUsage, cost_basis, cost_partial: true, unpriced: 2,
    cost_usd: 0.012, sessions: 3, users: 2, tokens: 600 });
  expect(row.cost_basis_label).toBe(`${label} · 부분합 · 미산정 2건 제외`);
  expect(row.cost_per_session).toBe(0.004);
  expect(row.cost_per_user).toBe(0.006);
  expect(row.usd_per_million_tokens).toBe(20);
  expect(row.cost_partial).toBe(true);
  expect(row.unpriced).toBe(2);
});

test("cost status distinguishes complete, partial zero and entirely unknown costs", () => {
  expect(presentationRow(codexUsage).cost_basis_label).toBe("AWS 정가 추정");
  expect(presentationRow({ ...codexUsage, cost_usd: 0, cost_partial: true, unpriced: 1 }))
    .toMatchObject({ cost_usd: 0, cost_per_session: 0,
      cost_basis_label: "AWS 정가 추정 · 부분합 · 미산정 1건 제외" });
  expect(presentationRow({ ...codexUsage, cost_usd: null, cost_partial: true, unpriced: 2 }))
    .toMatchObject({ cost_usd: null, cost_per_session: null, cost_basis_label: "AWS 정가 추정 · 미산정 · 2건 제외" });
  expect(presentationRow({ ...codexUsage, cost_partial: true, unpriced: undefined }).cost_basis_label)
    .toBe("AWS 정가 추정 · 부분합");
});

test("computed_estimate and mixed cost bases disclose the estimated count separately", () => {
  expect(presentationRow({ ...codexUsage, cost_basis: "computed_estimate" }).cost_basis_label)
    .toBe("계산 추정");
  expect(presentationRow({ ...codexUsage, cost_basis: "computed_estimate", cost_estimated: 3 })
    .cost_basis_label).toBe("계산 추정 · 추정 3건");
  expect(presentationRow({ ...codexUsage, cost_basis: "mixed", cost_estimated: 2 }).cost_basis_label)
    .toBe("보고+추정 · 추정 2건");
  expect(presentationRow({ ...codexUsage, cost_basis: "mixed", cost_partial: true, unpriced: 1,
    cost_estimated: 2 }).cost_basis_label).toBe("보고+추정 · 부분합 · 미산정 1건 제외 · 추정 2건");
});

test("partial cost does not fill missing token components, identities or zero denominators", () => {
  const row = presentationRow({ ...codexUsage, cost_partial: true, unpriced: 1,
    tokens: null, cache_write_tokens: null, sessions: 0, users: null });
  expect(row.cost_usd).toBe(codexUsage.cost_usd);
  for (const key of ["tokens", "input_total", "cache_read_pct", "tokens_per_session",
    "cost_per_session", "cost_per_user", "usd_per_million_tokens"]) expect(row[key]).toBeNull();
  expect(row.cost_basis_label).toContain("부분합");
});

test("timestamp parsing preserves the instant for both API forms", () => {
  expect(formatClientTime("2026-09-01 03:04:00")).toBe(formatClientTime("2026-09-01T03:04:00.000Z"));
  expect(formatClientTime(Date.UTC(2026, 8, 1, 3, 4))).toBe(formatClientTime("2026-09-01T03:04:00.000Z"));
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
      epoch: formatClientTime(1788293063789),
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
  expect(actual.epoch).toBe(actual.iso);
});
