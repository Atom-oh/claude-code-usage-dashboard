import { expect, test } from "vitest";
import {
  bucketKey,
  bucketState,
  buildModelCostFrame,
  chartTheme,
  displayModel,
  formatAxisUsd,
  formatUsd,
  formatUsdPrecise,
  fromByModelDaily,
  fromByModelTime,
  identityLabel,
  modelColorKey,
  modelLabel,
  OTHERS_COLOR_KEY,
  REASON_GROUPS,
  reasonLabel,
  rollupBuckets,
  STATE_LABELS,
  trendColor,
} from "./modelCostTrend.js";
import { modelColorFor, MODEL_TREND_COLORS, MODEL_TREND_OTHERS, MODEL_TREND_VENDOR_RAMPS } from "./colors.js";

const idle = (t) => ({ t, model: null, channel: null, known: null, partial: false, unavailable: 0,
  reasons: {}, observed_tokens: null, idle: true, estimated: false });
const c = (t, model, channel, known, extra = {}) => ({ t, model, channel, known, partial: false,
  unavailable: 0, reasons: {}, observed_tokens: 10, estimated: false, ...extra });
// n unavailable scopes with one reason.
const u = (reason, n = 1, extra = {}) => ({ unavailable: n, reasons: { [reason]: n }, ...extra });
const m = (t, model, known, extra = {}) => ({ t, model, channel: "anthropic", known, partial: false, unavailable: 0, reasons: {}, observed_tokens: 10, estimated: false, ...extra });
// An unattributed (model === null) Claude metadata cell with one report_missing exclusion.
const meta = (t, known, extra = {}) => ({ t, model: null, channel: null, known, partial: false, unavailable: 1,
  reasons: { report_missing: 1 }, observed_tokens: null, estimated: false, ...extra });
const H10 = "2026-09-14 10:00:00";
const D1 = "2026-09-01 00:00:00", D2 = "2026-09-02 00:00:00", D3 = "2026-09-03 00:00:00",
  D4 = "2026-09-04 00:00:00", D5 = "2026-09-05 00:00:00", D6 = "2026-09-06 00:00:00";
const CELLS = [
  c(D1, "claude-sonnet-5", "enterprise", 5),
  c(D1, "zai.glm-5", "bedrock", 1),
  c(D1, "claude-haiku-4-5", "enterprise", 0.5),
  c(D2, "claude-sonnet-5", "enterprise", 3),
  c(D2, "claude-opus-5", "bedrock", 0, { partial: true, unavailable: 2, reasons: { report_zero_with_tokens: 2 } }),
  c(D3, "claude-opus-5", "bedrock", null, u("report_missing", 1, { observed_tokens: null })),
  c(D4, "claude-sonnet-5", "enterprise", 0),
  idle(D5),
];
const BOUNDS = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-07T00:00:00.000Z" };

// Shared overview fixture for the fromByModelTime tests.
const NO_CODEX = { unknown_backend: 0, scope: 0, unknown_model: 0, invalid_usage: 0, missing_usage: 0 };
const OV = {
  bucket_hours: 1,
  effective_range: { from: "2026-09-14T10:00:00.000Z", to: "2026-09-14T14:00:00.000Z", requested_to: "2026-09-14T14:00:00.000Z" },
  timeseries: [
    { client: "claude", t: "2026-09-14T10:00:00Z", cost_usd: 2, cost_partial: true, unpriced: 2 },
    { client: "claude", t: "2026-09-14T11:00:00Z", cost_usd: 0, cost_partial: false, unpriced: 0, timeline_observed: true },
    { client: "claude", t: "2026-09-14T12:00:00Z", cost_usd: null, cost_partial: false, unpriced: 1, timeline_observed: true },
    { client: "codex", t: "2026-09-14T10:00:00Z", cost_usd: 0.004, cost_partial: true, unpriced: 3 },
  ],
  by_model_time: [
    { client: "claude", t: "2026-09-14T10:00:00Z", model: "claude-sonnet-5", backend: "anthropic", cost_usd: 2, cost_partial: true,
      unpriced: 2, unpriced_reasons: { report_missing: 1, report_zero_with_tokens: 1, missing_usage: 0 }, observed_tokens: 147 },
    { client: "codex", t: "2026-09-14T10:00:00Z", model: "openai.gpt-6-astra", backend: "bedrock-runtime", cost_usd: 0.004, cost_partial: false,
      unpriced: 0, unpriced_reasons: NO_CODEX, observed_tokens: 200 },
    { client: "codex", t: "2026-09-14T10:00:00Z", model: "global.openai.gpt-6-astra", backend: "bedrock-mantle", cost_usd: null, cost_partial: true,
      unpriced: 2, unpriced_reasons: { ...NO_CODEX, scope: 2 }, observed_tokens: 90 },
    { client: "codex", t: "2026-09-14T10:00:00Z", model: "", backend: "bedrock-mantle", cost_usd: null, cost_partial: true,
      unpriced: 1, unpriced_reasons: { ...NO_CODEX, missing_usage: 1 }, observed_tokens: null },
  ],
};

const CLAUDE_MODEL_CELL = m(H10, "claude-sonnet-5", 2, { partial: true, unavailable: 2,
  reasons: { report_missing: 1, report_zero_with_tokens: 1 }, observed_tokens: 147 });

// Shared hourly fixture for the rollupBuckets tests.
const hourly = [m("2026-09-23 23:00:00", "a", 1), m("2026-09-24 00:00:00", "a", 2), m("2026-09-24 01:00:00", "a", 4)];

test("bucketKey formats every accepted input as a UTC second key and rejects garbage", () => {
  expect(bucketKey("2026-09-01")).toBe("2026-09-01 00:00:00");
  expect(bucketKey("2026-09-01 10:00:00")).toBe("2026-09-01 10:00:00");
  expect(bucketKey("2026-09-01T10:37:23Z")).toBe("2026-09-01 10:37:23");
  expect(bucketKey("2026-09-01T10:37:23.456Z")).toBe("2026-09-01 10:37:23");
  expect(bucketKey(Date.UTC(2026, 8, 1, 5))).toBe("2026-09-01 05:00:00");
  expect(bucketKey("garbage")).toBeNull();
  expect(bucketKey(null)).toBeNull();
  expect(bucketKey(undefined)).toBeNull();
});

test("displayModel strips scope, vendor, version and date suffixes; labels keep the raw identity", () => {
  expect(displayModel("global.openai.gpt-6-astra")).toBe("openai.gpt-6-astra");
  expect(displayModel("us.openai.gpt-5.6-luna")).toBe("openai.gpt-5.6-luna");
  expect(displayModel("global.anthropic.claude-fable-5-1")).toBe("claude-fable-5-1");
  expect(displayModel("us.anthropic.claude-opus-5-v1:0")).toBe("claude-opus-5");
  expect(displayModel("claude-sonnet-5[1m]")).toBe("claude-sonnet-5");
  expect(displayModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  expect(displayModel("")).toBe("");
  expect(displayModel(null)).toBe("");
  expect(identityLabel(null, null)).toBe("모델 미귀속");
  expect(identityLabel("", "bedrock-mantle")).toBe("(모델 미상) · bedrock-mantle");
  expect(identityLabel("global.openai.gpt-6-astra", "bedrock-mantle")).toBe("global.openai.gpt-6-astra · bedrock-mantle");
  expect(modelLabel("")).toBe("(모델 미상)");
});

test("fromByModelDaily maps spend, coverage and reasons, never the computed cost", () => {
  const rows = [
    { day: "2026-09-01", group: "enterprise", model: "claude-sonnet-5", reported_cost: 5, reported_partial: false,
      reported_unavailable: 0, reported_reasons: { report_missing: 0, report_zero_with_tokens: 0 },
      reported_all_unavailable: false, observed_tokens: 100, cost: 4.9 },
    { day: "2026-09-01 00:00:00", group: "bedrock", model: "claude-opus-5", reported_cost: 0, reported_partial: true,
      reported_unavailable: 2, reported_reasons: { report_missing: 0, report_zero_with_tokens: 2 },
      reported_all_unavailable: false, observed_tokens: 50 },
    { day: "2026-09-02 00:00:00", group: "bedrock", model: "claude-opus-5", reported_cost: null, reported_partial: true,
      reported_unavailable: 1, reported_reasons: { report_missing: 1, report_zero_with_tokens: 0 },
      reported_all_unavailable: true, observed_tokens: null },
    { day: "2026-09-02", group: "bedrock", model: "m1", cost: 1, reported_cost: "1.5" },
    { day: "2026-09-03", group: "bedrock", model: "m2", reported_cost: null },
    { day: "bad", group: "bedrock", model: "x", reported_cost: 1 },
  ];
  const out = fromByModelDaily(rows);
  expect(out).toEqual([
    c(D1, "claude-opus-5", "bedrock", 0, { partial: true, unavailable: 2, reasons: { report_zero_with_tokens: 2 }, observed_tokens: 50 }),
    c(D1, "claude-sonnet-5", "enterprise", 5, { observed_tokens: 100 }),
    c(D2, "claude-opus-5", "bedrock", null, u("report_missing", 1, { observed_tokens: null })),
    c(D2, "m1", "bedrock", 1.5, { observed_tokens: null }),
    c(D3, "m2", "bedrock", null, u("unspecified", 1, { observed_tokens: null })),
  ]);
  expect("idle" in out[0]).toBe(false);
});

test("fromByModelTime builds model cells, timeline metadata and the idle fill per client", () => {
  const claude = fromByModelTime(OV, "claude");
  expect(claude).toEqual([
    CLAUDE_MODEL_CELL,
    idle("2026-09-14 11:00:00"),
    meta("2026-09-14 12:00:00", null),
    idle("2026-09-14 13:00:00"),
  ]);
  expect("idle" in claude[0]).toBe(false);
  expect("idle" in claude[2]).toBe(false);

  const codex = fromByModelTime(OV, "codex");
  expect(codex).toEqual([
    c(H10, "", "bedrock-mantle", null, u("missing_usage", 1, { observed_tokens: null })),
    c(H10, "global.openai.gpt-6-astra", "bedrock-mantle", null, u("scope", 2, { observed_tokens: 90 })),
    c(H10, "openai.gpt-6-astra", "bedrock-runtime", 0.004, { observed_tokens: 200 }),
    idle("2026-09-14 11:00:00"), idle("2026-09-14 12:00:00"), idle("2026-09-14 13:00:00"),
  ]);
  expect("idle" in codex[0]).toBe(false);
});

test("fromByModelTime marks a computed_estimate or mixed cost_basis as estimated, and nothing else", () => {
  const data = { ...OV, by_model_time: [
    { ...OV.by_model_time[0], cost_basis: "computed_estimate" },
    ...OV.by_model_time.slice(1),
  ], timeseries: [
    { ...OV.timeseries[0], cost_basis: "mixed" },
    ...OV.timeseries.slice(1),
  ] };
  const [claudeModelCell] = fromByModelTime(data, "claude");
  expect(claudeModelCell.estimated).toBe(true);
  expect(fromByModelTime(OV, "claude")[0].estimated).toBe(false);
  expect(fromByModelTime(OV, "codex").every((cell) => cell.estimated === false)).toBe(true);
  const metaData = { bucket_hours: 1, effective_range: { from: "2026-09-14T10:00:00.000Z", to: "2026-09-14T11:00:00.000Z" },
    timeseries: [{ client: "claude", t: "2026-09-14T10:00:00Z", cost_usd: 3, cost_partial: false, unpriced: 0, cost_basis: "mixed" }],
    by_model_time: [] };
  expect(fromByModelTime(metaData, "claude")[0].estimated).toBe(true);
});

test("fromByModelTime returns null when the by_model_time dimension is missing", () => {
  expect(fromByModelTime({ ...OV, by_model_time: undefined }, "claude")).toBeNull();
});

test("fromByModelTime returns an empty array for a client with no rows", () => {
  const codexOnly = {
    ...OV,
    timeseries: OV.timeseries.filter((r) => r.client === "codex"),
    by_model_time: OV.by_model_time.filter((r) => r.client === "codex"),
  };
  expect(fromByModelTime(codexOnly, "claude")).toEqual([]);
});

test("fromByModelTime turns an observed $0 timeline bucket and the gap after it into idle cells", () => {
  const data = {
    bucket_hours: 1,
    effective_range: { from: "2026-09-14T10:00:00.000Z", to: "2026-09-14T12:00:00.000Z" },
    timeseries: [{ client: "claude", t: "2026-09-14T10:00:00Z", cost_usd: 0, cost_partial: false, unpriced: 0, timeline_observed: true }],
    by_model_time: [],
  };
  expect(fromByModelTime(data, "claude")).toEqual([idle("2026-09-14 10:00:00"), idle("2026-09-14 11:00:00")]);
});

test("fromByModelTime keeps a partial $0 timeline bucket as a known partial cell", () => {
  const data = {
    bucket_hours: 1,
    effective_range: { from: "2026-09-14T10:00:00.000Z", to: "2026-09-14T11:00:00.000Z" },
    timeseries: [{ client: "claude", t: "2026-09-14T10:00:00Z", cost_usd: 0, cost_partial: true, unpriced: 1, timeline_observed: true }],
    by_model_time: [],
  };
  expect(fromByModelTime(data, "claude")).toEqual([
    meta(H10, 0, { partial: true }),
  ]);
});

test("fromByModelTime adds an unattributed residual cell beside model rows, ordered first", () => {
  const data = {
    bucket_hours: 1,
    effective_range: { from: "2026-09-14T10:00:00.000Z", to: "2026-09-14T11:00:00.000Z" },
    timeseries: [{ client: "claude", t: "2026-09-14T10:00:00Z", cost_usd: 2, cost_partial: true, unpriced: 3 }],
    by_model_time: OV.by_model_time.filter((r) => r.client === "claude"),
  };
  expect(fromByModelTime(data, "claude")).toEqual([
    meta(H10, null),
    CLAUDE_MODEL_CELL,
  ]);
});

test("split scopes stay separate cells but share one display series", () => {
  const codex = fromByModelTime(OV, "codex");
  const scoped = codex.filter((cell) => cell.model === "openai.gpt-6-astra" || cell.model === "global.openai.gpt-6-astra");
  expect(scoped.length).toBe(2);
  expect(scoped.map((cell) => cell.model)).toEqual(["global.openai.gpt-6-astra", "openai.gpt-6-astra"]);
  const frame = buildModelCostFrame(codex, { bucketHours: 1 });
  const astra = frame.series.filter((s) => s.model === "openai.gpt-6-astra");
  expect(astra.length).toBe(1);
  expect(astra[0].known).toBe(0.004);
  expect(astra[0].hasIssue).toBe(true);
});

test("fromByModelTime skips the idle fill above the interval cap", () => {
  const start = Date.parse("2026-09-14T10:00:00Z");
  const capped = { ...OV, effective_range: { ...OV.effective_range, to: new Date(start + 5001 * 3600000).toISOString() } };
  expect(fromByModelTime(capped, "codex").length).toBe(3);
  const atCap = { ...OV, effective_range: { ...OV.effective_range, to: new Date(start + 5000 * 3600000).toISOString() } };
  expect(fromByModelTime(atCap, "codex").length).toBe(5002);
  // An unaligned from adds a first partial bucket: 5000h from 10:37 spans 5001 aligned buckets.
  const unaligned = (h) => ({ ...OV, effective_range: { from: "2026-09-14T10:37:00.000Z", to: new Date(start + 37 * 60000 + h * 3600000).toISOString() } });
  expect([fromByModelTime(unaligned(5000), "codex").length, fromByModelTime(unaligned(4999), "codex").length]).toEqual([3, 5003]);
});

test("rollupBuckets merges minute cells into hours, keeping a partial first hour", () => {
  const input = [
    m("2026-09-24 10:37:00", "a", 1),
    m("2026-09-24 10:59:00", "a", 2, { partial: true, unavailable: 1, reasons: { report_missing: 1 } }),
    m("2026-09-24 10:59:00", "b", null, u("report_zero_with_tokens", 2, { observed_tokens: null })),
    m("2026-09-24 11:00:00", "b", 0.5),
    idle("2026-09-24 10:38:00"),
    idle("2026-09-24 11:01:00"),
  ];
  expect(rollupBuckets(input, 1, { sourceHours: 1 / 60 })).toEqual([
    idle("2026-09-24 10:00:00"),
    m("2026-09-24 10:00:00", "a", 3, { partial: true, unavailable: 1, reasons: { report_missing: 1 }, observed_tokens: 20 }),
    m("2026-09-24 10:00:00", "b", null, u("report_zero_with_tokens", 2, { observed_tokens: null })),
    idle("2026-09-24 11:00:00"),
    m("2026-09-24 11:00:00", "b", 0.5),
  ]);
});

test("rollupBuckets marks a merged bucket estimated when any member was, even mixed with a report", () => {
  const input = [
    m("2026-09-24 10:00:00", "a", 1, { estimated: false }),
    m("2026-09-24 10:30:00", "a", 2, { estimated: true }),
  ];
  const [rolled] = rollupBuckets(input, 1, { sourceHours: 1 / 60 });
  expect(rolled.estimated).toBe(true);
  expect(rolled.known).toBe(3);
});

test("rollupBuckets aligns days and weeks to the epoch like ClickHouse toStartOfInterval", () => {
  expect(rollupBuckets(hourly, 24, { sourceHours: 1 }).map((x) => [x.t, x.known]))
    .toEqual([["2026-09-23 00:00:00", 1], ["2026-09-24 00:00:00", 6]]);
  expect(rollupBuckets(hourly, 168, { sourceHours: 1 }).map((x) => [x.t, x.known]))
    .toEqual([["2026-09-17 00:00:00", 1], ["2026-09-24 00:00:00", 6]]);
  expect(rollupBuckets(hourly, 1, { sourceHours: 1 })).toEqual(hourly);
});

test("rollupBuckets rejects a smaller target and passes null through", () => {
  expect(() => rollupBuckets(hourly, 1, { sourceHours: 24 })).toThrow(RangeError);
  expect(() => rollupBuckets(hourly, 24)).toThrow(RangeError);
  expect(rollupBuckets(null, 24, { sourceHours: 1 })).toBeNull();
});

test.each([
  [[c(D1, "a", "e", 5)], "known"],
  [[c(D1, "a", "e", 5), c(D1, "b", "e", null, u("scope"))], "partial"],
  [[c(D1, "a", "e", 2, { partial: true, unavailable: 1, reasons: { scope: 1 } })], "partial"],
  [[c(D1, "a", "e", 0), c(D1, "b", "e", null, u("scope"))], "partial"],
  [[idle(D1), c(D1, "b", "e", null, u("scope"))], "unavailable"],
  [[c(D1, "b", "e", null, u("scope"))], "unavailable"],
  [[c(D1, "a", "e", 0), idle(D1)], "zero"],
  [[idle(D1), idle(D1)], "idle"],
  [[c(D1, "a", "e", 1), idle(D1)], "known"],
  [[], "nodata"],
])("bucketState precedence case %# resolves to %s", (members, expected) => {
  expect(bucketState(members)).toBe(expected);
});

test("a rolled-up bucket of idle plus a measured $0 is zero", () => {
  const rolled = rollupBuckets([idle("2026-09-24 00:00:00"), m("2026-09-24 01:00:00", "a", 0)], 24, { sourceHours: 1 });
  expect(buildModelCostFrame(rolled, { bucketHours: 24 }).buckets[0].state).toBe("zero");
});

test("buildModelCostFrame flags a bucket hasEstimate when any contributing cell is, and counts it in totals", () => {
  const cells = [
    c(D1, "claude-sonnet-5", "enterprise", 5, { estimated: true }),
    c(D2, "claude-sonnet-5", "enterprise", 3, { estimated: false }),
  ];
  const f = buildModelCostFrame(cells, { bounds: BOUNDS, bucketHours: 24 });
  expect(f.buckets.map((b) => [b.t, b.hasEstimate])).toEqual([
    [D1, true], [D2, false], [D3, false], [D4, false], [D5, false], [D6, false],
  ]);
  expect(f.totals.estimateBuckets).toBe(1);
});

test("buildModelCostFrame picks top-N series, folds the rest into 기타 and states every bucket", () => {
  const f = buildModelCostFrame(CELLS, { top: 2, bounds: BOUNDS, bucketHours: 24 });
  const s = { label: "claude-sonnet-5", pinned: false, hasIssue: false };
  expect(f.series).toEqual([
    { ...s, key: "s0", model: "claude-sonnet-5", colorKey: "claude-sonnet-5", hatch: false, known: 8, observed_tokens: 30 },
    { ...s, key: "s1", model: "zai.glm-5", label: "zai.glm-5", colorKey: "other-2", hatch: true, known: 1, observed_tokens: 10 },
  ]);
  expect(f.others).toEqual({ key: "__others", label: "기타 2개 모델", count: 2, models: ["claude-haiku-4-5", "claude-opus-5"], known: 0.5, affected: ["claude-opus-5"] });
  expect(f.buckets.map((b) => [b.t, b.state, b.total]))
    .toEqual([[D1, "known", 6.5], [D2, "partial", 3], [D3, "unavailable", null], [D4, "zero", 0], [D5, "idle", null], [D6, "nodata", null]]);
  expect(f.buckets.map((b) => [b.segments, b.others])).toEqual([
    [{ s0: 5, s1: 1 }, 0.5],
    [{ s0: 3, s1: null }, 0],
    [{ s0: null, s1: null }, null],
    [{ s0: 0, s1: null }, null],
    [{ s0: null, s1: null }, null],
    [{ s0: null, s1: null }, null],
  ]);
  expect(f.buckets[1].unavailable).toBe(2);
  expect(f.buckets[1].reasons).toEqual({ report_zero_with_tokens: 2 });
  expect(f.buckets[1].partialSeries).toEqual([]);
  expect(f.buckets[1].othersPartial).toBe(true);
  expect(f.buckets[1].issues).toEqual([
    { model: "claude-opus-5", channel: "bedrock", label: "claude-opus-5 · bedrock", unavailable: 2, reasons: { report_zero_with_tokens: 2 }, series: "__others" },
  ]);
  expect(f.buckets[5].unavailable).toBe(0);
  expect(f.buckets[5].reasons).toEqual({});
  expect(f.buckets[5].issues).toEqual([]);
  expect(f.buckets[5].othersPartial).toBe(false);
  const opus = { model: "claude-opus-5", channel: "bedrock", label: "claude-opus-5 · bedrock", inOthers: true };
  expect(f.totals).toEqual({
    known: 9.5,
    reviewBuckets: 2,
    idleBuckets: 1,
    estimateBuckets: 0,
    reasons: { report_zero_with_tokens: 2, report_missing: 1 },
    identityCount: 1,
    issues: [
      { key: "report_missing", label: "보고 비용 없음", count: 1, identities: [{ ...opus, count: 1 }] },
      { key: "report_zero_with_tokens", label: "보고 0·토큰 있음", count: 2, identities: [{ ...opus, count: 2 }] },
    ],
  });
  expect(f.othersBreakdown).toEqual([
    { model: "claude-haiku-4-5", label: "claude-haiku-4-5", channel: "enterprise", known: 0.5, unavailable: 0 },
    { model: "claude-opus-5", label: "claude-opus-5", channel: "bedrock", known: 0, unavailable: 3 },
  ]);
  expect(f.sparse).toBe(false);
  expect(f.empty).toBe(false);
  expect(f.allUnavailable).toBe(false);
});

test("every known amount lands in exactly one segment", () => {
  const knownSum = CELLS
    .filter((cell) => cell.idle !== true && cell.known !== null)
    .reduce((s, cell) => s + cell.known, 0);
  const check = (f) => {
    for (const b of f.buckets) {
      const segs = Object.values(b.segments).reduce((s, v) => s + (v ?? 0), 0) + (b.others ?? 0);
      expect(segs).toBeCloseTo(b.total ?? 0, 9);
    }
    expect(knownSum).toBeCloseTo(f.totals.known, 9);
  };
  check(buildModelCostFrame(CELLS, { top: 2, bounds: BOUNDS, bucketHours: 24 }));
  check(buildModelCostFrame(CELLS, { top: 1 }));
  check(buildModelCostFrame(CELLS, { top: 6 }));
});

test("ranking uses known cost regardless of vendor, then observed tokens with unknown last, then name", () => {
  const cells = [
    c(D1, "claude-b", "e", 2, { observed_tokens: 5 }),
    c(D1, "claude-a", "e", 2, { observed_tokens: 5 }),
    c(D1, "claude-c", "e", 2, { observed_tokens: null }),
    c(D1, "zai.glm-5", "e", 2, { observed_tokens: 9 }),
    c(D1, "claude-e", "e", null, u("scope", 1, { observed_tokens: 100 })),
    c(D1, "openai.gpt-6-astra", "e", 3, { observed_tokens: 1 }),
  ];
  expect(buildModelCostFrame(cells).series.map((s) => s.model))
    .toEqual(["openai.gpt-6-astra", "zai.glm-5", "claude-a", "claude-b", "claude-c", "claude-e"]);
});

test("membership is fixed for the period and pinned models join the series", () => {
  const cells = [c(D1, "a", "e", 10), c(D1, "b", "e", 5), c(D1, "c", "e", 1), c(D2, "c", "e", 20)];
  const top1 = buildModelCostFrame(cells, { top: 1 });
  expect(top1.series.map((s) => s.model)).toEqual(["c"]);
  expect(top1.buckets[0].segments).toEqual({ s0: 1 });
  expect(top1.buckets[0].others).toBe(15);
  expect(top1.buckets[1].segments).toEqual({ s0: 20 });
  expect(top1.buckets[1].others).toBeNull();

  const pinnedA = buildModelCostFrame(cells, { top: 1, pinned: ["global.a"] });
  expect(pinnedA.series.map((s) => [s.model, s.pinned])).toEqual([["c", false], ["a", true]]);
  expect(pinnedA.others.models).toEqual(["b"]);

  const pinnedNone = buildModelCostFrame(cells, { top: 1, pinned: ["zzz", ""] });
  expect(pinnedNone.series.map((s) => s.model)).toEqual(["c"]);
});

test("a model with unavailable cells is flagged in its series and in 기타", () => {
  const cells = [
    c(D1, "x", "e", 10),
    c(D2, "x", "e", null, u("scope")),
    c(D1, "y", "e", 1),
    c(D2, "y", "e", null, u("unknown_model")),
    c(D1, "z", "e", 0.5),
  ];
  const f = buildModelCostFrame(cells, { top: 1 });
  expect(f.series.map((s) => [s.model, s.hasIssue])).toEqual([["x", true]]);
  expect(f.buckets[1].partialSeries).toEqual(["s0"]);
  expect(f.others.models).toEqual(["y", "z"]);
  expect(f.others.affected).toEqual(["y"]);
  expect(f.buckets[1].othersPartial).toBe(true);
});

test("the bucket grid follows the bounds and is capped", () => {
  const one = [c(D1, "a", "e", 1)];
  const keys = (f) => f.buckets.map((b) => b.t);

  const daily = buildModelCostFrame(one, { bounds: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" }, bucketHours: 24 });
  expect(keys(daily)).toEqual([D1, D2, D3]);
  expect(daily.sparse).toBe(false);
  expect(daily.buckets.map((b) => b.state)).toEqual(["known", "nodata", "nodata"]);

  const capped = buildModelCostFrame(one, { bounds: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" }, bucketHours: 24, maxIntervals: 2 });
  expect(keys(capped)).toEqual([D1]);
  expect(capped.sparse).toBe(true);

  const far = buildModelCostFrame(one, {
    bounds: { from: "2026-09-01T00:00:00.000Z", to: new Date(Date.parse("2026-09-01T00:00:00Z") + 5001 * 86400000) },
    bucketHours: 24,
  });
  expect(keys(far)).toEqual([D1]);
  expect(far.sparse).toBe(true);

  const unbounded = buildModelCostFrame(one, { bucketHours: 24 });
  expect(keys(unbounded)).toEqual([D1]);
  expect(unbounded.sparse).toBe(true);

  const weekly = buildModelCostFrame([c("2026-09-17 00:00:00", "a", "e", 1)], {
    bounds: { from: "2026-09-10T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" },
    bucketHours: 168,
  });
  expect(keys(weekly)).toEqual(["2026-09-10 00:00:00", "2026-09-17 00:00:00", "2026-09-24 00:00:00"]);
});

test("all-unavailable, idle-only and empty frames are distinguished", () => {
  const allUnavailable = buildModelCostFrame([c(D1, "m", "bedrock", null, u("report_missing"))]);
  expect(allUnavailable.allUnavailable).toBe(true);
  expect(allUnavailable.totals.known).toBeNull();

  const idleOnly = buildModelCostFrame([idle(D1), idle(D2)]);
  expect(idleOnly.allUnavailable).toBe(false);
  // Idle is recorded-usage zero, not a known amount.
  expect(idleOnly.totals.known).toBeNull();
  const idleAndMissing = buildModelCostFrame([idle(D1), c(D2, "m", "b", null, u("scope"))]);
  expect([idleAndMissing.allUnavailable, idleAndMissing.totals.known, idleAndMissing.buckets[0].total]).toEqual([true, null, null]);
  expect(idleOnly.buckets.map((b) => b.state)).toEqual(["idle", "idle"]);

  const empty = buildModelCostFrame([]);
  expect(empty.empty).toBe(true);
  expect(empty.buckets).toEqual([]);

  expect(buildModelCostFrame(null).empty).toBe(true);
});

test.each([
  [0, "$0.00"], [0.004, "<$0.01"], [0.009, "<$0.01"], [0.01, "$0.01"], [1234.567, "$1,234.57"],
  [485.5623, "$485.56"], [1000000, "$1,000,000.00"], [null, "—"],
])("formatUsd(%s) is %s", (value, expected) => {
  expect(formatUsd(value)).toBe(expected);
});

test.each([
  [0, "$0"], [0.000123456789, "$0.000123457"], [485.5623, "$485.562"], [1234.56789, "$1,234.57"],
  [1234567.891, "$1,234,570"], [0.5, "$0.5"], [6.5, "$6.5"], [null, "—"],
])("formatUsdPrecise(%s) is %s", (value, expected) => {
  expect(formatUsdPrecise(value)).toBe(expected);
});

test.each([
  [0, "$0"], [0.005, "$0.005"], [0.25, "$0.25"], [0.123, "$0.12"], [2.5, "$2.5"], [250, "$250"],
  [999, "$999"], [1000, "$1K"], [1200, "$1.2K"], [12500, "$12.5K"], [1500000, "$1.5M"], [NaN, ""],
])("formatAxisUsd(%s) is %s", (value, expected) => {
  expect(formatAxisUsd(value)).toBe(expected);
});

test("REASON_GROUPS and STATE_LABELS carry the fixed keys and Korean labels", () => {
  expect(REASON_GROUPS.map((g) => [g.key, g.label])).toEqual([
    ["report_missing", "보고 비용 없음"],
    ["report_zero_with_tokens", "보고 0·토큰 있음"],
    ["scope", "범위·백엔드 불일치"],
    ["unknown_model", "단가 미등록 모델"],
    ["invalid_usage", "유효하지 않은 사용량"],
    ["missing_usage", "사용량 미기록"],
    ["unspecified", "사유 미확인"],
  ]);
  expect(reasonLabel("unknown_backend")).toBe("범위·백엔드 불일치");
  expect(reasonLabel("scope")).toBe("범위·백엔드 불일치");
  expect(reasonLabel("missing_usage")).toBe("사용량 미기록");
  expect(reasonLabel("nope")).toBe("사유 미확인");
  expect(STATE_LABELS).toEqual({
    known: "확인됨", zero: "$0 (측정값)", partial: "부분합",
    unavailable: "확인 불가", idle: "기록된 사용 없음", nodata: "데이터 없음",
  });
});

const REGISTERED = [
  "claude-fable-5", "claude-fable-5-1", "claude-sonnet-5", "claude-opus-5", "claude-opus-5-5",
  "claude-opus-4-8", "claude-haiku-4-5", "openai.gpt-5.6-sol", "openai.gpt-6-astra", "openai.gpt-5.6-luna",
];

test.each(REGISTERED)("modelColorKey(%s) is the registered solid key", (name) => {
  expect(modelColorKey(name)).toEqual({ key: name, hatch: false });
});

test("modelColorKey resolves aliases to registered keys and does not depend on call order", () => {
  expect(modelColorKey("global.openai.gpt-6-astra").key).toBe("openai.gpt-6-astra");
  expect(modelColorKey("gpt-5.6-sol").key).toBe("openai.gpt-5.6-sol");
  expect(modelColorKey("us.anthropic.claude-opus-5-v1:0").key).toBe("claude-opus-5");
  const names = [...REGISTERED, "claude-sonnet-4-5", "claude-opus-4-7", "xai.grok-4.6", "kimi-k3"];
  const forwards = names.map((name) => modelColorKey(name));
  const reversed = [...names].reverse().map((name) => modelColorKey(name)).reverse();
  expect(reversed).toEqual(forwards);
});

test.each([
  ["zai.glm-5", "other-2"], ["xai.grok-4.6", "other-0"], ["moonshotai.kimi-k2.5", "other-1"],
  ["kimi-k3", "other-1"], ["claude-instant-1", "anthropic-2"],
  ["openai.gpt-5.6-terra", "openai-1"], ["", "other-0"],
])("unregistered model %s gets the hatched vendor key %s", (name, key) => {
  expect(modelColorKey(name)).toEqual({ key, hatch: true });
});

test("vendor ramp keys resolve to the muted ramp shades", () => {
  expect(trendColor("other-2")).toBe("#7B9195");
  expect(trendColor("anthropic-0", "dark")).toBe("#8D7C73");
  expect(trendColor("openai-1")).toBe("#4F8D89");
  // A non-family vendor model is hatched with the slate ramp, never a warning-like red.
  expect([modelColorKey("xai.grok-4.6"), trendColor(modelColorKey("xai.grok-4.6").key)]).toEqual([{ key: "other-0", hatch: true }, "#53676B"]);
});

// Other known Claude models and families keep the existing modelColorFor color, solid, in both themes.
test.each([
  ["claude-sonnet-4-5", "#B7C0F5"], ["us.anthropic.claude-sonnet-4-6-v1:0", "#93A0EC"], ["claude-opus-4-7", "#F5C09B"],
  ["claude-haiku-3-5", "#A8DCC0"], ["claude-opus-9", "#EDB48E"],
])("known Claude model %s stays solid with its modelColorFor color %s", (model, color) => {
  const { key, hatch } = modelColorKey(model);
  expect(hatch).toBe(false);
  expect([trendColor(key), trendColor(key, "dark")]).toEqual([color, color]);
});

test("trendColor resolves model, 기타 and fallback colors per theme; chartTheme reads the surface", () => {
  expect(trendColor("claude-sonnet-5")).toBe("#5B6BDB");
  expect(trendColor("claude-sonnet-5", "dark")).toBe("#6E7DE6");
  expect(trendColor("openai.gpt-6-astra")).toBe("#5325B9");
  expect(trendColor("openai.gpt-6-astra", "dark")).toBe("#7044EB");
  expect(trendColor("openai.gpt-5.6-luna")).toBe("#025A8D");
  expect(trendColor("openai.gpt-5.6-luna", "dark")).toBe("#056AB3");
  expect(trendColor(OTHERS_COLOR_KEY)).toBe("#A3A9B6");
  expect(trendColor(OTHERS_COLOR_KEY, "dark")).toBe("#5E6678");
  expect(trendColor("nope")).toBe("#A3A9B6");
  for (const theme of ["light", "dark"]) {
    const neutral = MODEL_TREND_OTHERS[theme];
    expect(Object.values(MODEL_TREND_COLORS[theme])).not.toContain(neutral);
    for (const vendor of Object.keys(MODEL_TREND_VENDOR_RAMPS)) {
      expect(MODEL_TREND_VENDOR_RAMPS[vendor][theme]).not.toContain(neutral);
    }
  }
  expect(chartTheme("#ffffff")).toBe("light");
  expect(chartTheme("#fff")).toBe("light");
  expect(chartTheme("#171c27")).toBe("dark");
  expect(chartTheme("rgb(23, 28, 39)")).toBe("dark");
  expect(chartTheme("")).toBe("light");
});

test.each([
  ["claude-sonnet-5", "#6C7CE0"], ["claude-sonnet-4-6", "#93A0EC"], ["claude-sonnet-4-5", "#B7C0F5"],
  ["claude-opus-5", "#E8845F"], ["claude-opus-4-8", "#F0A47C"], ["claude-opus-4-7", "#F5C09B"],
  ["claude-opus-4-6", "#FAD8BE"], ["claude-opus-4-5", "#FDEADB"], ["claude-haiku-4-5", "#7FC9A0"],
  ["claude-haiku-3-5", "#A8DCC0"], ["claude-3-5-haiku", "#A8DCC0"], ["claude-fable-5", "#E091B0"],
  ["claude-fable-5-1", "#D67CA0"], ["claude-opus-5-5", "#EDB48E"], ["claude-sonnet-9", "#8290E8"],
  ["claude-haiku-9", "#93D2B0"], ["zai.glm-5", null], ["openai.gpt-6-astra", null], ["", null],
])("existing modelColorFor(%s) is unchanged", (model, expected) => {
  expect(modelColorFor(model)).toBe(expected);
});

// Host-added after a mutation sweep: each case below failed to go red when its rule was
// removed from modelCostTrend.js, so it pins that rule directly.
test("rollupBuckets marks a merged cell partial when a member was unavailable", () => {
  const rolled = rollupBuckets([
    m("2026-09-24 10:00:00", "a", 1),
    m("2026-09-24 10:30:00", "a", null, u("scope", 1, { observed_tokens: null })),
  ], 1, { sourceHours: 1 / 60 });
  expect(rolled).toEqual([
    m("2026-09-24 10:00:00", "a", 1, { partial: true, unavailable: 1, reasons: { scope: 1 } }),
  ]);
  expect(bucketState(rolled)).toBe("partial");
});

test("an unattributed cell stays in 기타 even when the empty-model row is a series", () => {
  const f = buildModelCostFrame([
    c(D1, "", "bedrock-mantle", 2),
    { t: D1, model: null, channel: null, known: 0, partial: true, unavailable: 1, reasons: { report_missing: 1 }, observed_tokens: null },
  ]);
  expect(f.series.map((s) => [s.model, s.label])).toEqual([["", "(모델 미상)"]]);
  expect(f.buckets[0].segments).toEqual({ s0: 2 });
  expect(f.buckets[0].others).toBe(0);
  expect(f.buckets[0].issues.map((i) => [i.label, i.series])).toEqual([["모델 미귀속", "__others"]]);
  expect(f.totals.issues[0].identities).toEqual([{ model: null, channel: null, label: "모델 미귀속", count: 1, inOthers: true }]);
});

test("the bucket grid is kept at exactly maxIntervals intervals", () => {
  const f = buildModelCostFrame([c(D1, "a", "e", 1)], {
    bounds: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-04T00:00:00.000Z" }, bucketHours: 24, maxIntervals: 3,
  });
  expect(f.sparse).toBe(false);
  expect(f.buckets.map((b) => b.t)).toEqual([D1, D2, D3]);
  const unaligned = (maxIntervals) => buildModelCostFrame([c(D1, "a", "e", 1)], {
    bounds: { from: "2026-09-01T10:37:00.000Z", to: "2026-09-04T10:37:00.000Z" }, bucketHours: 24, maxIntervals });
  expect(unaligned(3).sparse).toBe(true);
  expect(unaligned(4).buckets.map((b) => b.t)).toEqual([D1, D2, D3, D4]);
});

test("a known $0 timeline beside unpriced model rows stays a partial $0 bucket", () => {
  // Server-fold shape: a timeline-only $0 row plus a zero-with-tokens report.
  const at = "2026-09-14T10:00:00Z";
  const cells = fromByModelTime({ bucket_hours: 1, effective_range: { from: at, to: "2026-09-14T11:00:00Z" },
    timeseries: [{ client: "claude", t: at, cost_usd: 0, cost_partial: true, unpriced: 1 }],
    by_model_time: [{ client: "claude", t: at, model: "claude-opus-5", backend: "bedrock-runtime", cost_usd: null,
      cost_partial: true, unpriced: 1, unpriced_reasons: { report_zero_with_tokens: 1 } }] }, "claude");
  expect(cells).toEqual([meta(H10, 0, { unavailable: 0, reasons: {} }),
    c(H10, "claude-opus-5", "bedrock-runtime", null, u("report_zero_with_tokens", 1, { observed_tokens: null }))]);
  const f = buildModelCostFrame(cells);
  expect(f.buckets.map((b) => [b.state, b.total, b.unavailable])).toEqual([["partial", 0, 1]]);
  expect(f.others.label).toBe("모델 미귀속");
});

test("the grid's first key follows the shared (from) and the detail (floor) convention", () => {
  const er = { from: "2026-09-14T10:37:00.000Z", to: "2026-09-14T13:00:00.000Z" };
  const shared = fromByModelTime({ ...OV, effective_range: er, by_model_time: [],
    timeseries: [{ client: "codex", t: "2026-09-14T10:37:00Z", cost_usd: 1, cost_partial: false, unpriced: 0 }] }, "codex");
  const keys = (cells, bounds, bucketHours) => buildModelCostFrame(cells, { bounds, bucketHours }).buckets.map((b) => b.t);
  expect(keys(shared, er, 1)).toEqual(["2026-09-14 10:37:00", "2026-09-14 11:00:00", "2026-09-14 12:00:00"]);
  expect(keys(shared, er, 1)).toEqual(shared.map((x) => x.t));
  // 10:37-12:30 touches 3 aligned hours.
  expect(buildModelCostFrame(shared, { bounds: { ...er, to: "2026-09-14T12:30:00Z" }, bucketHours: 1, maxIntervals: 2 }).sparse).toBe(true);
  expect(keys([c(D1, "a", "e", 1)], { from: "2026-09-01T10:37:00.000Z", to: "2026-09-03T00:00:00.000Z" }, 24)).toEqual([D1, D2]);
});

test.each([
  [{ effective_range: undefined }], [{ effective_range: { from: OV.effective_range.to, to: OV.effective_range.from } }], [{ bucket_hours: 0 }],
])("fromByModelTime without a valid range or bucket size stays sparse (%#)", (patch) => {
  expect(fromByModelTime({ ...OV, ...patch }, "codex")).toEqual(fromByModelTime(OV, "codex").filter((x) => x.idle !== true));
});
