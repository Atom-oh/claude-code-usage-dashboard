import { clientOverview, validateClientFilters } from "./clientMetrics.js";
import { parseClients } from "./clients.js";
import { parseIntervalHours, parsePositiveInt, parseRange } from "./http.js";
import { pricingConfig } from "./pricing.js";

const DIMENSIONS = { model: "by_model", user: "by_user", time: "timeseries", client: "by_client" };
const FIELDS = ["client", "backend", "model", "user", "t", "cost_usd", "cost_basis", "cost_partial",
  "tokens", "observed_tokens", "tokens_partial", "input_tokens", "output_tokens", "cache_read_tokens",
  "cache_write_tokens", "reasoning_tokens", "sessions", "users", "unpriced", "missing_usage",
  // ADR-016: rejection-only Codex groups are not observed zero usage.
  "rejected_requests", "request_rejections_only"];
const project = row => Object.fromEntries(FIELDS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));

export const USAGE_TOOL = { toolSpec: {
  name: "get_usage_summary",
  description: "Preferred source for dashboard costs/tokens: canonical Claude counters and deduplicated Codex completions with server pricing, cost_basis and partial flags. Returns one dimension plus totals, effective range and result_id. Channels/groups require diagnostic SQL.",
  inputSchema: { json: {
    type: "object", additionalProperties: false,
    properties: {
      from: { type: "string", description: "ISO 8601 start with timezone" },
      to: { type: "string", description: "ISO 8601 exclusive end with timezone" },
      dimension: { type: "string", enum: Object.keys(DIMENSIONS) },
      client: { type: "string", enum: ["all", "claude", "codex"] },
      backend: { type: "string", enum: ["all", "bedrock-mantle", "bedrock-runtime", "anthropic", "unknown"] },
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
    return {
      rows: result[DIMENSIONS[input.dimension]].map(row => ({
        ...project(row),
        label: [row.client, row.backend, row.model || row.user || row.t].filter(Boolean).join(" · "),
      })),
      totals: project(result.totals), quality: result.quality,
      effective_range: result.effective_range, bucket_hours: result.bucket_hours,
      cache_write_ttl: pricingConfig.cacheWriteTtl, source: "dashboard", truncated: false,
    };
  };
}
