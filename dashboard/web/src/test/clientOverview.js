// Synthetic API data; no production identities or model calls.
export const codexUsage = {
  client: "codex", backend: "bedrock-mantle", model: "fixture-model",
  tokens: 270, input_tokens: 98, cache_read_tokens: 100, cache_write_tokens: 22,
  output_tokens: 50, reasoning_tokens: 15, cost_usd: 0.0042405,
  cost_basis: "aws_list_estimate", cost_partial: false, unpriced: 0, sessions: 1, users: 1,
  requests: 2, api_errors: 0, tool_calls: 1, tool_errors: 0,
  request_duration_ms: 120, ttft_ms: 45,
};

export function clientOverview(overrides = {}) {
  return {
    clients: ["codex"],
    observed_records: 2,
    totals: { ...codexUsage, users: null },
    by_client: [{ ...codexUsage }],
    by_model: [{ ...codexUsage }],
    by_user: [{ ...codexUsage, user: "alice@example.test" }],
    timeseries: [{ ...codexUsage, t: "2026-09-01T00:00:00.000Z" }],
    tools: [{ client: "codex", tool: "shell", calls: 1, errors: 0, duration_ms: 80 }],
    quality: { unpriced: 0, invalid: 0 },
    ...overrides,
  };
}
