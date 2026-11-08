const TYPES = new Set(["bar", "stacked_bar", "line"]);
const UNITS = new Set(["usd", "tokens", "count", "percent"]);
const field = value => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 160;
const own = (row, key) => Object.hasOwn(row, key);
const columnUnit = key => key === "cost_usd" ? "usd"
  : key === "tokens" || key === "observed_tokens" || key.endsWith("_tokens") ? "tokens"
    : ["sessions", "users", "unpriced", "missing_usage", "rejected_requests"].includes(key) ? "count" : undefined;

function numeric(value) {
  if (value === null) return null;
  // ClickHouse can encode large integers as strings. Never turn missing, blank,
  // booleans, NaN or infinity into zero.
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new Error("Chart series must contain finite numbers or null.");
  // An integer beyond the safe range has already lost precision: unknown, never a rounded
  // point (same rule as observedTokens.js).
  return Number.isInteger(number) && !Number.isSafeInteger(number) ? null : number;
}

export const CHART_TOOL = {
  toolSpec: {
    name: "show_chart",
    description: "Display a fixed chart from a previous query result_id. Select columns only; never resend rows or generate chart code. Use unique x values (label preserves client/backend identities); filter client/backend for a time trend. Never stack inclusive tokens with their subsets; use disjoint SQL columns instead. At most 3 charts, 50 points and 3 series.",
    inputSchema: { json: {
      type: "object", additionalProperties: false,
      properties: {
        result_id: { type: "string" },
        type: { type: "string", enum: [...TYPES] },
        title: { type: "string", maxLength: 160 },
        x: { type: "string", description: "Category/time column in stored rows" },
        x_type: { type: "string", enum: ["category", "time"] },
        series: { type: "array", minItems: 1, maxItems: 3, items: {
          type: "object", properties: { key: { type: "string" }, label: { type: "string" } }, required: ["key", "label"],
        } },
        unit: { type: "string", enum: [...UNITS] },
      },
      required: ["result_id", "type", "title", "x", "series", "unit"],
    } },
  },
};

export function buildChatChart(spec, results) {
  if (!spec || Object.keys(spec).some(k => !["result_id", "type", "title", "x", "x_type", "series", "unit"].includes(k)))
    throw new Error("Only chart metadata and stored result references are allowed.");
  const source = results.get(spec.result_id);
  if (!source) throw new Error("Unknown chart result_id.");
  if (!TYPES.has(spec.type) || !UNITS.has(spec.unit) || !label(spec.title) || !field(spec.x)
      || (spec.x_type !== undefined && !["category", "time"].includes(spec.x_type))
      || !Array.isArray(spec.series) || spec.series.length < 1 || spec.series.length > 3)
    throw new Error("Invalid chart template or columns.");
  const keys = new Set();
  for (const item of spec.series) {
    if (!item || !field(item.key) || !label(item.label) || keys.has(item.key) || item.key === spec.x)
      throw new Error("Invalid chart series.");
    const expected = columnUnit(item.key);
    if ((expected && expected !== spec.unit) || (source.source === "dashboard" && !expected))
      throw new Error("Chart unit must match every selected column.");
    keys.add(item.key);
  }
  if (spec.type === "stacked_bar") {
    const components = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"];
    if ((keys.has("input_tokens") && (keys.has("cache_read_tokens") || keys.has("cache_write_tokens")))
        || (keys.has("output_tokens") && keys.has("reasoning_tokens"))
        || ((keys.has("tokens") || keys.has("observed_tokens")) && components.some(key => keys.has(key)))
        || (keys.has("tokens") && keys.has("observed_tokens")))
      throw new Error("Stacked token series overlap; select disjoint components.");
  }
  const rows = source.rows.slice(0, 50);
  if (!rows.length) throw new Error("No observed rows to chart.");
  // Dashboard folds seed one row per enabled client and keep totals without records. A row with
  // observed_records 0 and no idle counter observation (timeline_observed) is unavailable, not a known
  // zero (ADR-015; mirrors web clientPresentation.js). SQL rows carry no such markers.
  const unobserved = row => source.source === "dashboard" && row.observed_records === 0 && row.timeline_observed !== true;
  const data = rows.map(row => {
    if (!row || typeof row !== "object" || !own(row, spec.x)
        || !["string", "number"].includes(typeof row[spec.x]))
      throw new Error("Missing chart category column.");
    const x = String(row[spec.x]);
    if (x.length > 160) throw new Error("Chart category is too long.");
    const result = { [spec.x]: x };
    for (const key of keys) {
      if (!own(row, key)) throw new Error("Missing chart series column.");
      const value = numeric(row[key]);
      result[key] = unobserved(row) ? null : value;
    }
    return result;
  });
  if (new Set(data.map(row => row[spec.x])).size !== data.length)
    throw new Error("Chart x values must be unique; use label or filter the dimension.");
  const costBases = [...new Set(source.rows.map(row => row?.cost_basis).filter(Boolean))]
    .map(basis => ["client_reported", "aws_list_estimate", "computed_estimate", "mixed"].includes(basis) ? basis : "unknown");
  return {
    type: spec.type, title: spec.title, x: spec.x, x_type: spec.x_type || "category",
    series: spec.series.map(({ key, label }) => ({ key, label })), unit: spec.unit, data,
    source: source.source === "dashboard" ? "dashboard" : "sql",
    coverage: source.source === "dashboard" ? "canonical" : "unverified",
    cost_bases: [...new Set(costBases)],
    ...(source.effective_range ? { effective_range: source.effective_range } : {}),
    truncated: Boolean(source.truncated || source.rows.length > rows.length),
    partial: source.rows.some(row => row?.cost_partial === true || row?.tokens_partial === true),
  };
}
