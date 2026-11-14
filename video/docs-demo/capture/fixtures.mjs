// Synthetic November 14 walkthrough data. No production API or credentials.
export const from = "2026-11-12T00:00:00.000Z";
export const to = "2026-11-14T00:00:00.000Z";
export const user = "alice@example.test";
export const taskId = "claude:0123456789abcdef0123456789abcdef";
const tokens = (input, cache_read, cache_write, output) => ({ input, cache_read, cache_write, output });
const usage = { client: "claude", backend: "anthropic", model: "claude-sonnet-5-5",
  tokens: 10800, observed_tokens: 10800, input_tokens: 300, cache_read_tokens: 9000,
  cache_write_tokens: 600, output_tokens: 900, reasoning_tokens: null, cost_usd: 2.5,
  cost_basis: "client_reported", cost_partial: false, tokens_partial: false, unpriced: 0,
  sessions: 4, users: 1, requests: 18, api_errors: 0, tool_calls: 12, tool_errors: 0 };
export const task = { id: taskId, client: "claude", started_at: "2026-11-13T03:00:00.000Z",
  duration_ms: 120000, duration_basis: "interaction_span", models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
  llm_calls: 3, subagents: 2, tokens: { ...tokens(300, 9000, 600, 900), observed_tokens: 10800, tokens_partial: false },
  cost_usd: 2.5, cost_partial: false, cost_basis: "mixed",
  workflows: [{ run_id: "demo-run", name: "docs-refresh" }] };
export const detail = {
  task, lanes: [
    { id: "main", label: "main", kind: "main", spawned_by: null, llm_calls: 1, cost_usd: 1, cost_partial: false },
    { id: "agent-a", label: "Explore", kind: "Explore", spawned_by: "tool-1", llm_calls: 1, cost_usd: 1.25, cost_partial: false },
    { id: "agent-b", label: "Explore", kind: "Explore", spawned_by: "tool-2", llm_calls: 1, cost_usd: 0.25, cost_partial: false },
  ],
  spans: [
    { id: "llm-1", parent: null, lane: "main", kind: "llm", name: "claude_code.llm_request",
      start_ms: 0, duration_ms: 4000, attrs: { model: "claude-sonnet-5-5", ttft_ms: 900,
        stop_reason: "tool_use", query_source_safe: "repl_main_thread", attempt: 1 },
      tokens: tokens(100, 3000, 200, 300), cost_usd: 1, cost_basis: "client_reported" },
    { id: "tool-1", parent: "llm-1", lane: "main", kind: "tool", name: "claude_code.tool",
      start_ms: 5000, duration_ms: 60000, attrs: { tool_name: "Agent", subagent_type: "Explore", success: true } },
    { id: "tool-2", parent: "llm-1", lane: "main", kind: "tool", name: "claude_code.tool",
      start_ms: 66000, duration_ms: 12000, attrs: { tool_name: "Agent", subagent_type: "Explore", success: true } },
    { id: "wait-1", parent: null, lane: "main", kind: "wait", name: "claude_code.tool.blocked_on_user",
      start_ms: 4500, duration_ms: 400, attrs: { decision: "accept", source: "user_temporary" } },
    { id: "llm-2", parent: "tool-1", lane: "agent-a", kind: "llm", name: "claude_code.llm_request",
      start_ms: 6000, duration_ms: 3000, attrs: { model: "claude-sonnet-5-5", query_source_safe: "agent",
        query_source_agent_id: "agent-a" },
      tokens: tokens(100, 5000, 300, 400), cost_usd: 1.25, cost_basis: "computed" },
    { id: "llm-3", parent: "tool-2", lane: "agent-b", kind: "llm", name: "claude_code.llm_request",
      start_ms: 70000, duration_ms: 2000, attrs: { model: "claude-haiku-5-5", query_source_safe: "agent",
        query_source_agent_id: "agent-b" },
      tokens: tokens(100, 1000, 100, 200), cost_usd: 0.25, cost_basis: "client_reported" },
  ],
  truncated: false, span_total: 6,
  context: { points: [
    { span: "llm-1", lane: "main", start_ms: 0, tokens: 3300, source: "repl_main_thread" },
    { span: "llm-2", lane: "agent-a", start_ms: 6000, tokens: 5400, source: "agent" },
    { span: "llm-3", lane: "agent-b", start_ms: 70000, tokens: 1200, source: "agent" },
  ], missing: 0, partial: false, compactions: [], limits: null },
  environment: { lookback_days: 14,
    mcp: { connected: 2, failed: 1, other: 0, servers: [
      { name: "github", status: "connected" }, { name: "docs", status: "connected" },
      { name: "search", status: "failed" },
    ] },
    plugins: { count: 8, skills: 12, agents: 4, commands: 9, with_mcp: 2, counts_partial: false } },
  why: [{ rule: "cache_read_share", value: 9000 / 10800 },
    { rule: "top_lane_share", value: { lane: "agent-a", share: 0.5 } },
    { rule: "most_expensive_call", value: { span: "llm-2", cost_usd: 1.25 } },
    { rule: "permission_wait", value: 400 }],
};

export function apiResponse(url) {
  const start = url.searchParams.get("from") || from, end = url.searchParams.get("to") || to;
  const hours = Number(url.searchParams.get("intervalHours")) || 1;
  const step = hours * 3600000;
  const periods = [];
  for (let t = Math.floor(Date.parse(start) / step) * step, i = 0; t < Date.parse(end); t += step, i++) {
    periods.push({ ...usage, t: new Date(t).toISOString(), observed_tokens: (i % 7 + 1) * 3600,
      tokens: (i % 7 + 1) * 3600, cost_usd: (i % 7 + 1) * 0.25 });
  }
  const effective = { from: start, to: end, requested_to: end };
  switch (url.pathname) {
    case "/api/config": return { enabledClients: ["claude", "codex"], piiMask: true, groupMode: "single",
      defaultRangeDays: 2, rangeCapDays: 90, schema: {}, pricing: { cacheWriteTtl: "1h", overriddenModels: [] },
      session: { mode: "oidc", role: "analyst", expiresAt: "2026-11-15T12:00:00.000Z",
        permissions: ["telemetry:read", "collector:manage"] } };
    case "/api/health/data": return { status: "ok", latest: to, ageMinutes: 0, staleAfterMinutes: 360 };
    case "/api/clients/activity":
    case "/api/clients/overview": return { clients: ["claude"], observed_records: 48,
      totals: usage, by_client: [usage], by_model: [usage], by_user: [{ ...usage, user }],
      timeseries: periods, tools: [], quality: {}, bucket_hours: hours, effective_range: effective,
      applied_filters: { userExact: url.searchParams.get("userExact") || "" } };
    case "/api/users/tasks": return { tasks: [task, { ...task, id: `${taskId}-2`, cost_usd: 1.25,
      started_at: "2026-11-13T01:30:00.000Z", llm_calls: 2, subagents: 1, workflows: [] }],
      coverage: { claude: "observed" }, partial: true };
    case "/api/users/tasks/detail": return detail;
    case "/api/clients/productivity": return { by_client: [] };
    case "/api/clients/token-economics": return {
      effective_range: effective, bucket_hours: hours, by_client: [{
        client: "claude", cost_basis: "client_reported",
        current: { users: 1, sessions: 4, turns: 12, requests: 24, tokens: 48000, cost: 12,
          factors: { users: 1, sessions_per_user: 4, turns_per_session: 3, requests_per_turn: 2,
            tokens_per_request: 2000, cost_per_token: 0.00025 }, cost_per_million_tokens: 250 },
        previous: null, unavailable: { decomposition: "no_previous" }, decomposition: { unavailable: "no_previous" },
        models: [], exemplars: null, outcome: null,
        trend: periods.map((row, i) => {
          const value = i % 8 < 3 ? null : (i % 8 + 1) / 10;
          return { t: row.t, cost_per_user: value === null ? null : value * 2, cost_per_session: value,
            cost_per_1k_requests: value === null ? null : value * 5, tokens_per_request: value === null ? null : 2000,
            cache_hit_rate: value === null ? null : 0.65 + i % 5 * 0.05 };
        }),
      }],
    };
    case "/api/collector": return { enabled: true, endpoint: "https://dashboard.example/api/ingest",
      installScriptUrl: "https://dashboard.example/api/ingest/install.sh", tokenLifetimeDays: 30,
      collectorVersion: "0.163.1", platforms: ["linux", "darwin"] };
    case "/api/collector/devices": return { devices: [], nextCursor: null };
    default: return [];
  }
}
