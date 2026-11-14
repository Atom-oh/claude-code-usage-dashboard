// Synthetic guide fixtures. All identities and prices are fictional; no production data.
// Trace shape adapted from the immutable video/docs-demo/capture fixture.
export const from = "2026-11-12T00:00:00.000Z";
export const to = "2026-11-14T00:00:00.000Z";
export const user = "alice@example.test";
export const taskId = "claude:0123456789abcdef0123456789abcdef";
const tokens = (input, cache_read, cache_write, output) => ({ input, cache_read, cache_write, output });
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

// Illustrative USD per million tokens, NOT a vendor price table or invoice.
export const syntheticPrices = {
  "claude-sonnet-5-5": { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 },
  "claude-haiku-5-5": { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 },
};
const computed = (model, parts) => Object.entries(parts).reduce((n, [k, v]) => n + v * syntheticPrices[model][k] / 1e6, 0);
const calls = detail.spans.filter((s) => s.kind === "llm");
for (const s of calls) {
  s.tokens = Object.fromEntries(Object.entries(s.tokens).map(([k, v]) => [k, v * 100]));
}
calls[0].cost_usd = 0.7;
calls[0].attrs.effort = "high";
calls[1].cost_usd = computed(calls[1].attrs.model, calls[1].tokens);
calls[1].attrs.effort = "medium";
// attempt intentionally absent: not a measured zero or zero retries.
calls[2].cost_usd = 0.14;
calls[2].attrs.effort = "low";
task.cost_usd = calls.reduce((n, s) => n + s.cost_usd, 0);
task.tokens = { ...tokens(30000, 900000, 60000, 90000), observed_tokens: 1080000, tokens_partial: false };
task.workflows = [{ run_id: "synthetic-guide-run", name: "synthetic-docs-refresh" }];
detail.lanes.forEach((lane) => { lane.cost_usd = calls.find((s) => s.lane === lane.id).cost_usd; });
detail.context.points.forEach((point) => { point.tokens *= 100; });
detail.span_total = detail.spans.length;
detail.environment.mcp = { connected: 2, failed: 0, other: 0, servers: [
  { name: "example-docs", status: "connected" }, { name: "example-repo", status: "connected" },
] };
detail.environment.plugins = { count: 2, skills: 3, agents: 2, commands: 3, with_mcp: 2, counts_partial: false };
detail.why = [
  { rule: "cache_read_share", value: 900000 / 1080000 },
  { rule: "top_lane_share", value: { lane: "agent-a", share: calls[1].cost_usd / task.cost_usd } },
  { rule: "most_expensive_call", value: { span: "llm-2", cost_usd: calls[1].cost_usd } },
  { rule: "permission_wait", value: 400 },
];

const identities = [user, "bruno@example.test", "carol@example.test"];
const tokenKeys = ["input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"];
const additive = [...tokenKeys, "tokens", "observed_tokens", "cost_usd", "computed_cost", "requests", "api_errors", "tool_calls", "tool_errors"];
const common = { client: "claude", backend: "bedrock-runtime", channel: "bedrock", group: "bedrock",
  reasoning_tokens: null, cost_basis: "mixed", cost_partial: false, tokens_partial: false, unpriced: 0 };
// One row per session/model; sessions never cross buckets. Aggregations deduplicate IDs.
// Each session uses the same three-call interaction scaled by a deterministic integer.
const ledger = [];
for (let period = 0; period < 2; period++) {
  const start = Date.parse(from) - period * 48 * 3600000;
  const slots = period ? 6 : 8;
  for (let day = 0; day < 2; day++) for (let u = 0; u < 3; u++) for (let i = 0; i < slots; i++) {
    const t = new Date(start + (day * 24 + 3 + i * 2) * 3600000).toISOString();
    const scale = !period && u === 0 && i === 0 ? 1 : 1 + ((i * 2 + day) % 3) + (u === 2 ? 1 : 0);
    const session = `synthetic-${period}-${day}-${u}-${i}`;
    for (const model of task.models) {
      const subset = calls.filter((c) => c.attrs.model === model);
      const row = { ...common, user: identities[u], model, session, t,
        cost_basis: model === task.models[0] ? "mixed" : "client_reported",
        turns: model === task.models[0] ? (period ? 3 : 2) : 0,
        cost_usd: subset.reduce((n, c) => n + c.cost_usd, 0) * scale * (period ? 1.1 : 1),
        computed_cost: subset.reduce((n, c) => n + computed(model, c.tokens), 0) * scale,
        requests: subset.length, api_errors: i === 3 && model === task.models[0] ? 1 : 0,
        tool_calls: model === task.models[0] ? 6 : 0, tool_errors: 0,
        request_duration_ms: model === task.models[0] ? 3500 : 2000, ttft_ms: model === task.models[0] ? 900 : 450 };
      tokenKeys.forEach((key, j) => { row[key] = subset.reduce((n, c) => n + c.tokens[["input", "cache_read", "cache_write", "output"][j]], 0) * scale; });
      row.tokens = row.observed_tokens = tokenKeys.reduce((n, key) => n + row[key], 0);
      ledger.push(row);
    }
  }
}
function aggregate(rows, extra = {}) {
  const r = { ...common, ...extra };
  const bases = new Set(rows.map((row) => row.cost_basis));
  r.cost_basis = bases.size === 1 ? [...bases][0] : "mixed";
  additive.forEach((k) => { r[k] = rows.reduce((n, row) => n + row[k], 0); });
  r.sessions = new Set(rows.map((row) => row.session)).size;
  r.users = new Set(rows.map((row) => row.user)).size;
  for (const k of ["request_duration_ms", "ttft_ms"])
    r[k] = rows.length ? rows.reduce((n, row) => n + row[k] * row.requests, 0) / r.requests : null;
  return r;
}
function group(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(keys.map((k) => row[k]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((values) => aggregate(values, Object.fromEntries(keys.map((k) => [k, values[0][k]]))));
}
const bounds = (url) => ({ from: url.searchParams.get("from") || from, to: url.searchParams.get("to") || to });
function rowsFor(url) {
  const range = bounds(url);
  return ledger.filter((r) => r.t >= range.from && r.t < range.to
    && (!url.searchParams.get("userExact") || r.user === url.searchParams.get("userExact"))
    && (!url.searchParams.get("email") || r.user === url.searchParams.get("email"))
    && (!url.searchParams.get("model") || r.model === url.searchParams.get("model")));
}
function overview(url) {
  const rows = rowsFor(url), range = bounds(url), hours = Number(url.searchParams.get("intervalHours")) || 1;
  const timeRows = rows.map((r) => ({ ...r, t: new Date(Math.floor(Date.parse(r.t) / (hours * 3600000)) * hours * 3600000).toISOString() }));
  const total = aggregate(rows);
  return { clients: ["claude"], totals: total, by_client: [{ ...total }], by_model: group(rows, ["model", "backend"]),
    by_user: group(rows, ["user"]), by_user_model: group(rows, ["user", "model", "group"]),
    by_project: [{ ...total, project: "synthetic-guide" }],
    timeseries: group(timeRows, ["t"]), by_model_time: group(timeRows, ["t", "model", "backend"]),
    by_user_time: group(timeRows, ["t", "user"]), observed_records: total.requests,
    tools: toolRows(total.sessions), quality: { invalid: 0, unpriced: 0, missing_usage: 0 },
    bucket_hours: hours, effective_range: { ...range, requested_to: range.to },
    applied_filters: { userExact: url.searchParams.get("userExact") || "", model: url.searchParams.get("model") || "" } };
}
function toolRows(sessions) {
  return [
    { tool: "Read", calls: sessions * 2, duration_ms: 35 },
    { tool: "Agent", calls: sessions * 2, duration_ms: 36000 },
    { tool: "mcp__example-docs__search", calls: sessions, duration_ms: 180 },
    { tool: "mcp__example-repo__list_files", calls: sessions, duration_ms: 120 },
  ].map((r) => ({ ...r, duration_ms: r.duration_ms * r.calls, client: "claude", errors: 0 }));
}
const currentRows = ledger.filter((r) => r.t >= from), previousRows = ledger.filter((r) => r.t < from);
function chain(rows) {
  const r = aggregate(rows), turns = rows.reduce((n, row) => n + row.turns, 0);
  const factors = { users: r.users, sessions_per_user: r.sessions / r.users, turns_per_session: turns / r.sessions,
    requests_per_turn: r.requests / turns, tokens_per_request: r.tokens / r.requests, cost_per_token: r.cost_usd / r.tokens };
  return { users: r.users, sessions: r.sessions, turns, requests: r.requests, tokens: r.tokens, cost: r.cost_usd,
    factors, cost_per_million_tokens: r.cost_usd / r.tokens * 1e6, unavailable: null };
}
const current = chain(currentRows), previous = chain(previousRows);
const logMean = (current.cost - previous.cost) / Math.log(current.cost / previous.cost);
const contributions = Object.fromEntries(Object.keys(current.factors).map((k) =>
  [k, logMean * Math.log(current.factors[k] / previous.factors[k])]));
const decomposition = { contributions, bundles: {
  growth: contributions.users + contributions.sessions_per_user,
  waste: contributions.turns_per_session + contributions.requests_per_turn + contributions.tokens_per_request,
  price: contributions.cost_per_token,
}, total_change: current.cost - previous.cost, unavailable: null };
function economics(url) {
  const o = overview(url);
  return { effective_range: o.effective_range, previous_range: { from: "2026-11-10T00:00:00.000Z", to: from },
    bucket_hours: o.bucket_hours, by_client: [{
      client: "claude", cost_basis: "mixed", current, previous, decomposition,
      unavailable: { chain: null, decomposition: null, outcome: "not_collected" },
      coverage: { sessions: current.sessions, matched_sessions: current.sessions, cost_known: current.cost,
        cost_matched: current.cost, cost_unattributed: 0,
        excluded: { no_turns: 0, no_requests: 0, cost_incomplete: 0, tokens_invalid: 0 } },
      trend: o.timeseries.map((r) => ({ t: r.t, cost_per_user: r.cost_usd / r.users,
        cost_per_session: r.cost_usd / r.sessions, cost_per_1k_requests: r.cost_usd / r.requests * 1000,
        tokens_per_request: r.tokens / r.requests, cache_hit_rate: r.cache_read_tokens / (r.input_tokens + r.cache_read_tokens + r.cache_write_tokens) })),
      models: o.by_model.map((r) => ({ model: r.model, cost: r.cost_usd, requests: r.requests,
        request_share: r.requests / current.requests, tokens: r.tokens, cost_per_million_tokens: r.cost_usd / r.tokens * 1e6,
        small: r.model.includes("haiku") })),
      outcome: null, previous_outcome: null, exemplars: { eligible_users: 3, levers: [] },
    }] };
}
const sessions = current.sessions, tools = toolRows(sessions);
const channel = (rows) => rows.map((r) => ({ group: "bedrock", ...r }));
const usageResponses = {
  "tool-mcp": channel(tools.map((r) => ({ tool: r.tool, mcp_server: r.tool.includes("__") ? r.tool.split("__")[1] : "",
    ok: r.calls, fail: r.errors, total: r.calls }))),
  "tool-decisions": channel(tools.map((r) => ({ tool: r.tool, source: "config", accepts: r.calls, rejects: 0, accept_rate: 1, n: r.calls }))),
  "tool-latency": channel(tools.map((r) => ({ tool: r.tool, uses: r.calls, errors: r.errors,
    p50_ms: r.duration_ms / r.calls, p95_ms: r.duration_ms / r.calls * 1.5 }))),
  "connectors": channel([{ connector: "example-docs", users: 3, calls: sessions, ok: sessions },
    { connector: "example-repo", users: 3, calls: sessions, ok: sessions }]),
  "mcp-health": channel([{ server: "example-docs", attempts: sessions, connected: sessions, failed: 0, p95_ms: 240 },
    { server: "example-repo", attempts: sessions, connected: sessions, failed: 0, p95_ms: 180 }]),
  "skills": channel([{ skill: "synthetic:docs-check", invocations: 24, est_cost_usd: 12 },
    { skill: "synthetic:trace-review", invocations: 16, est_cost_usd: 8 },
    { skill: "synthetic:release-notes", invocations: 8, est_cost_usd: 4 }]),
  "skill-activations": channel([{ skill: "synthetic:docs-check", trigger: "user-slash", invocations: 24 },
    { skill: "synthetic:trace-review", trigger: "claude-proactive", invocations: 16 },
    { skill: "synthetic:release-notes", trigger: "nested-skill", invocations: 8 }]),
  "plugins": [{ plugin: "synthetic-docs", marketplace: "example.test", session_loads: sessions, sessions },
    { plugin: "synthetic-review", marketplace: "example.test", session_loads: sessions, sessions }],
  "subagent-fanout": channel([{ subagent_completions: sessions * 2, interactions: sessions, avg_subagents_per_interaction: 2 }]),
  "compaction": channel([{ trigger: "auto", compactions: 12, sessions: 12, compactions_per_session: 1, avg_compression_ratio: 0.6 }]),
  "commands": { commands: channel([{ command: "/synthetic:docs-check", uses: 24, users: 3 }]),
    prompts: channel([{ prompts: 96, p50_len: 160, p95_len: 420 }]) },
  "hook-overhead": channel([{ executions: 96, total_seconds: 4.8, p95_ms: 80, blocked: 0 }]),
  "entrypoints": channel([{ entrypoint: "terminal", requests: current.requests, sessions, users: 3,
    cost_usd: currentRows.filter((r) => r.model === task.models[1]).reduce((n, r) => n + r.tokens / 140000 * 0.84, 0) }]),
  "permission-modes": channel([{ from_mode: "plan", to_mode: "auto", changes: 12, sessions: 12 }]),
  "decision-sources": channel([{ decision_source: "config", decision_type: "accept", tool_results: sessions * 6, share: 1 }]),
  "projects": [],
};
export function apiResponse(url) {
  if (url.pathname.startsWith("/api/usage/")) {
    const key = url.pathname.split("/").at(-1);
    if (key in usageResponses) return usageResponses[key];
  }
  switch (url.pathname) {
    case "/api/config": return { enabledClients: ["claude", "codex"], piiMask: true, groupMode: "single",
      defaultRangeDays: 2, rangeCapDays: 90, schema: {}, pricing: { cacheWriteTtl: "1h", overriddenModels: [] },
      session: { mode: "oidc", role: "admin", expiresAt: "2026-11-15T12:00:00.000Z",
        permissions: ["telemetry:read", "collector:manage", "installation:read"] } };
    case "/api/health/data": return { status: "ok", latest: "2026-11-14T11:58:00.000Z", ageMinutes: 2, staleAfterMinutes: 360 };
    case "/api/teams": return { teams: ["Synthetic Docs"] };
    case "/api/users/teams": return { users: identities.map((user) => ({ user, teams: ["Synthetic Docs"] })) };
    case "/api/clients/overview":
    case "/api/clients/activity": return overview(url);
    case "/api/clients/productivity": return { by_client: [] };
    case "/api/clients/token-economics": return economics(url);
    case "/api/clients/claude-effort": {
      // The computed fallback call is excluded by the real endpoint's contract.
      const rows = rowsFor(url), scale = rows.filter((r) => r.model === task.models[1]).reduce((n, r) => n + r.tokens / 140000, 0);
      return { effort: [{ backend: "bedrock-runtime", effort: "high", cost_usd: scale * 0.7, cost_basis: "client_reported" },
        { backend: "bedrock-runtime", effort: "low", cost_usd: scale * 0.14, cost_basis: "client_reported" }] };
    }
    case "/api/users/tasks": {
      if (url.searchParams.get("userExact") !== user) return { tasks: [], coverage: { claude: "observed" }, partial: true };
      const tasks = [task, { ...task, id: `${taskId}-2`, started_at: "2026-11-12T03:00:00.000Z", workflows: [] }];
      const range = bounds(url);
      return { tasks: tasks.filter((r) => r.started_at >= range.from && r.started_at < range.to),
        coverage: { claude: "observed" }, partial: true };
    }
    case "/api/users/tasks/detail": {
      if (url.searchParams.get("userExact") !== user) throw new Error("Task identity must be Alice");
      const selected = url.searchParams.get("id") === taskId ? task : { ...task, id: `${taskId}-2`, started_at: "2026-11-12T03:00:00.000Z", workflows: [] };
      return { ...detail, task: selected };
    }
    case "/api/users/daily": return [];
    case "/api/users/decisions-by-tool": return [];
    case "/api/collector": return { enabled: true, endpoint: "https://dashboard.example.test/api/ingest",
      installScriptUrl: "https://dashboard.example.test/api/ingest/install.sh",
      tokenLifetimeDays: 30, collectorVersion: "0.163.1", platforms: ["linux", "darwin"] };
    case "/api/collector/devices": return { devices: [
      { id: "synthetic-mac", name: "Synthetic · 문서용 Mac", platform: "darwin",
        createdAt: "2026-11-12T02:00:00Z", expiresAt: "2026-12-12T02:00:00Z",
        lastSeenAt: "2026-11-14T11:58:00Z", revokedAt: null, renewedAt: null, reuseDetectedAt: null },
    ], nextCursor: null };
    case "/api/installation": return { state: "attention", checkedAt: "2026-11-14T12:00:00Z",
      release: { version: "1.8.0-synthetic", revision: "synthetic-guide" },
      authentication: { state: "oidc_configured" }, database: { state: "reachable", readonly: "confirmed",
        readonlyCheckedAt: "2026-11-14T11:58:00Z" },
      clients: [{ client: "claude", state: "receiving", latest: "2026-11-14T11:58:00Z" },
        { client: "codex", state: "empty", latest: null }],
      staleAfterMinutes: 360, schema: { counterIdentity: "confirmed", projectFields: "unconfirmed", migrations: ["001", "010"] } };
    default: throw new Error(`Unimplemented synthetic API: ${url.pathname}`);
  }
}

export function validateFixtures() {
  const near = (a, b, label) => { if (Math.abs(a - b) > 1e-7) throw new Error(`${label}: ${a} != ${b}`); };
  const o = overview(new URL(`http://127.0.0.1/api/clients/overview?from=${from}&to=${to}`));
  for (const key of additive) for (const axis of ["by_model", "by_user", "timeseries", "by_user_model"])
    near(o[axis].reduce((n, r) => n + r[key], 0), o.totals[key], `${axis}.${key}`);
  for (const r of ledger) near(r.tokens, tokenKeys.reduce((n, k) => n + r[k], 0), "token components");
  near(task.cost_usd, calls.reduce((n, s) => n + s.cost_usd, 0), "task call costs");
  near(task.tokens.observed_tokens, calls.reduce((n, s) => n + Object.values(s.tokens).reduce((a, b) => a + b, 0), 0), "task tokens");
  for (const listedAt of [task.started_at, "2026-11-12T03:00:00.000Z"]) {
    const matching = currentRows.filter((r) => r.user === user && r.t === listedAt);
    near(aggregate(matching).cost_usd, task.cost_usd, "listed task ledger match");
    near(aggregate(matching).tokens, task.tokens.observed_tokens, "listed task tokens match");
  }
  near(calls[1].cost_usd, computed(calls[1].attrs.model, calls[1].tokens), "computed call price");
  if (task.cost_basis !== "mixed" || "attempt" in calls[1].attrs) throw new Error("Trace basis/attempt contract");
  for (const c of [current, previous]) near(Object.values(c.factors).reduce((a, b) => a * b, 1), c.cost, "cost equation");
  near(Object.values(contributions).reduce((a, b) => a + b, 0), current.cost - previous.cost, "LMDI contributions");
  near(Object.values(decomposition.bundles).reduce((a, b) => a + b, 0), decomposition.total_change, "LMDI bundles");
  near(tools.reduce((n, r) => n + r.calls, 0), o.totals.tool_calls, "tool calls");
  near(tools.find((r) => r.tool === "Agent").duration_ms / (sessions * 2), 36000, "tool mean latency");
  for (const identity of identities) {
    const single = overview(new URL(`http://127.0.0.1/api/clients/overview?from=${from}&to=${to}&userExact=${identity}`));
    if (single.by_user.length !== 1 || single.by_user[0].user !== identity) throw new Error("User filter leaked");
    near(single.totals.cost_usd, o.by_user.find((r) => r.user === identity).cost_usd, "selected user cost");
  }
  return { passed: true, totals: o.totals, current, previous, decomposition,
    task_cost: task.cost_usd, trace_span_count: detail.span_total, missing_attempt_preserved: true,
    scope: "Costs, token components, models, users, time buckets, exact user filters, trace costs and LMDI equation/decomposition.",
    synthetic_prices_usd_per_million: syntheticPrices,
    limitations: ["Skill costs are independent reported attribution and must not be added to total spend.",
      "Trace list is a partially observed subset of usage.", "Code outcomes and SQL chat are not supplied."] };
}
