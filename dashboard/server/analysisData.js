import { CLIENT_BACKENDS, clientOverview, validateClientFilters } from "./clientMetrics.js";
import { parseClients } from "./clients.js";
import { parseIntervalHours, parsePositiveInt, parseRange } from "./http.js";
import { pricingConfig } from "./pricing.js";

const DIMENSIONS = { model: "by_model", user: "by_user", time: "timeseries", client: "by_client" };
// Whole-row cap shared with the SQL chat path (clickhouse.js queryReadonly). Totals come from the
// full fold, so a truncated dimension never changes them.
const ROW_CAP = 200;
const FIELDS = ["client", "backend", "model", "user", "t", "cost_usd", "cost_basis", "cost_partial",
  "tokens", "observed_tokens", "tokens_partial", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_write_tokens", "reasoning_tokens", "sessions", "users", "unpriced", "missing_usage",
  // ADR-016: rejection-only Codex groups are not observed zero usage.
  "rejected_requests", "request_rejections_only",
  // ADR-015 observation evidence. The fold seeds one by_client row per enabled client and keeps totals
  // without records; like the web (clientPresentation.js), observed_records 0 without an idle counter
  // observation (timeline_observed) is unavailable, not a known zero.
  "observed_records", "timeline_observed"];
// Measures an unobserved row would otherwise present as a known zero (web MEASURES within FIELDS).
const UNOBSERVED_NULL = ["cost_usd", "tokens", "observed_tokens", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "sessions", "users", "rejected_requests"];
const unobserved = row => row.observed_records === 0 && row.timeline_observed !== true;
const project = row => {
  const unavailable = unobserved(row);
  return Object.fromEntries(FIELDS.filter(key => Object.hasOwn(row, key))
    .map(key => [key, unavailable && UNOBSERVED_NULL.includes(key) ? null : row[key]]));
};

export const USAGE_TOOL = { toolSpec: {
  name: "get_usage_summary",
  description: "Preferred source for dashboard costs/tokens: canonical Claude counters and deduplicated Codex completions with server pricing, cost_basis and partial flags. Returns one dimension plus totals, effective range and result_id. Rows with observed_records 0 and no timeline_observed are unobserved: their measures are null, never zero. At most 200 rows; truncated marks a cut (totals stay complete). Channels/groups require diagnostic SQL.",
  inputSchema: { json: {
    type: "object", additionalProperties: false,
    properties: {
      from: { type: "string", description: "ISO 8601 start with timezone" },
      to: { type: "string", description: "ISO 8601 exclusive end with timezone" },
      dimension: { type: "string", enum: Object.keys(DIMENSIONS) },
      client: { type: "string", enum: ["all", "claude", "codex"] },
      backend: { type: "string", enum: ["all", ...CLIENT_BACKENDS] },
      user: { type: "string", maxLength: 256 },
      model: { type: "string", maxLength: 256 },
      intervalHours: { type: "number", description: "Optional time bucket size in hours" },
    },
    required: ["from", "to", "dimension"],
  } },
} };

export function createUsageLookup({ overview = clientOverview, enabledClients = parseClients(process.env).enabledClients,
  capDays = parsePositiveInt(process.env.RANGE_CAP_DAYS, 90) } = {}) {
  return async (input, signal) => {
    signal.throwIfAborted();
    if (!input || !Object.hasOwn(DIMENSIONS, input.dimension)
        || Object.keys(input).some(key => !Object.hasOwn(USAGE_TOOL.toolSpec.inputSchema.json.properties, key)))
      throw new Error("Invalid usage summary input.");
    for (const key of ["from", "to"])
      if (typeof input[key] !== "string" || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(input[key]))
        throw new Error("Usage range needs ISO timestamps with timezones.");
    if (["user", "model"].some(key => typeof input[key] === "string" && /\*{6}@/.test(input[key])))
      throw new Error("A masked identifier cannot be used as a filter; the original identity is unavailable.");
    const { from, to } = parseRange(input, { capDays });
    const raw = { client: input.client, backend: input.backend, user: input.user, model: input.model,
      intervalHours: parseIntervalHours(input.intervalHours, 24), view: "cost" };
    validateClientFilters(raw, enabledClients);
    const result = await overview(from, to, raw, enabledClients, signal);
    signal.throwIfAborted();
    const dimension = result[DIMENSIONS[input.dimension]];
    return {
      rows: dimension.slice(0, ROW_CAP).map(row => ({
        ...project(row),
        label: [row.client, row.backend, row.model || row.user || row.t].filter(Boolean).join(" · "),
      })),
      totals: project(result.totals), quality: result.quality,
      effective_range: result.effective_range, bucket_hours: result.bucket_hours,
      cache_write_ttl: pricingConfig.cacheWriteTtl, source: "dashboard", truncated: dimension.length > ROW_CAP,
    };
  };
}
