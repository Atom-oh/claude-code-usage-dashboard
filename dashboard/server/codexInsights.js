import { query } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { validateClientFilters } from "./clientMetrics.js";
import { codexPrices } from "./priceCatalog.js";
import { buildCodexLogAggregateQuery, foldCodexLogAggregates } from "./codexLogAggregates.js";
import { buildMetricQuery, buildTraceQuery, foldCodexMetrics, foldCodexTraces } from "./codexSignals.js";

const TYPES = ["sum", "gauge", "histogram", "exponential_histogram"];
const PERFORMANCE_METRICS = ["codex.turn.e2e_duration_ms", "codex.turn.ttft.duration_ms",
  "codex.turn.tool.call", "codex.turn.token_usage"];
export function validateInsightsProfile(raw) {
  if (raw.profile !== undefined && !["effort", "tools", "performance"].includes(raw.profile))
    throw new ValidationError("invalid profile", "profile accepts only effort, tools, or performance");
  return raw.profile;
}
function foldSignal(rows, fold, limitMessage, emptyResult = () => fold([])) {
  try { return fold(rows); }
  catch (error) {
    if (!(error instanceof ValidationError) || error.message !== limitMessage) throw error;
    const empty = emptyResult();
    return { ...empty,
      ...(empty.summary ? { summary: Object.fromEntries(Object.keys(empty.summary).map((key) => [key, null])) } : {}),
      coverage: { status: "limited", records: null, last_seen: null } };
  }
}
async function optionalQuery(request, run) {
  try { return { rows: await run(request.sql, request.params), unavailable: false }; }
  catch (error) {
    if (String(error.code) === "60") return { rows: [], unavailable: true };
    throw error;
  }
}

export async function codexInsights(from, to, raw = {}, run = query) {
  const filters = validateClientFilters(raw, ["codex"]);
  const profile = validateInsightsProfile(raw);
  const effortOnly = profile === "effort";
  const diagnosticOnly = profile === "tools" || profile === "performance";
  const requestMetrics = !profile || profile === "performance";
  const requestTraces = !profile;
  const logQuery = buildCodexLogAggregateQuery(from, to, filters, codexPrices(), { profile });
  const [logRows, metricResults, traceResult] = await Promise.all([
    run(logQuery.sql, logQuery.params),
    requestMetrics ? Promise.all(TYPES.map((type) => optionalQuery(buildMetricQuery(type, from, to, filters,
      { metricNames: profile === "performance" ? PERFORMANCE_METRICS : undefined }), run))) : [],
    requestTraces ? optionalQuery(buildTraceQuery(from, to, filters), run) : { rows: [], unavailable: false },
  ]);
  const { coverage: logCoverage, ...logs } = foldCodexLogAggregates(logRows);
  const { coverage: metricCoverage, metrics } = foldSignal(metricResults.flatMap((r) => r.rows),
    (rows) => foldCodexMetrics(rows, from, to), "too much signal data");
  const { coverage: traceCoverage, spans, traces } = foldCodexTraces(traceResult.rows);
  const unavailable = requestMetrics ? TYPES.filter((_, i) => metricResults[i].unavailable) : [];
  if (effortOnly) {
    delete logs.summary.tool_success_rate;
    for (const name of ["tools", "approvals", "latency", "runtime"]) delete logs[name];
  }
  if (diagnosticOnly) {
    const summaryFields = profile === "tools" ? ["tool_success_rate", "approval_rate"] : ["retry_rate", "api_error_rate"];
    logs.summary = Object.fromEntries(summaryFields.map(key => [key, logs.summary[key]]));
    for (const name of ["completion_usage", "completeness", "effort", "runtime",
      ...(profile === "tools" ? ["latency"] : ["tools", "approvals"])]) delete logs[name];
  }
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    ...logs, metrics, spans, traces,
    ...(profile ? { profile } : {}),
    coverage: {
      logs: { ...logCoverage,
        ...(logQuery.omittedSections.length ? { omitted_sections: logQuery.omittedSections } : {}) },
      metrics: !requestMetrics ? { status: "not_requested", records: null, last_seen: null }
        : { ...metricCoverage, ...(unavailable.length === TYPES.length ? { status: "unavailable" } : {}),
        unavailable_types: unavailable, partial: unavailable.length > 0 || metrics.some((m) => m.partial) },
      traces: !requestTraces ? { status: "not_requested", records: null, last_seen: null }
        : { ...traceCoverage, selection: "latest_50_traces", span_limit_per_trace: 200,
        ...(traceResult.unavailable ? { status: "unavailable" } : {}) },
    },
    limitations: diagnosticOnly ? [
      "This profile supplies log diagnostics; completion-log usage and cost totals are omitted.",
      "Event coverage retains all deduplicated log events in the filtered window; omitted aggregate sections were not requested.",
      "Log limits apply independently to aggregate dimensions, not event volume. Limited sections do not hide unrelated summaries.",
      ...(requestMetrics ? [
        "Metrics use export timestamps; boundary exports may span the requested start.",
        "Model filters on metrics require a model attribute; model-less records are excluded.",
      ] : []),
      "Git output, retained code quality and saved work time are not collected by this integration.",
    ] : [
      "Logs supply token and AWS list-price estimates; metrics and traces are independent diagnostic signals.",
      "Metrics use export timestamps; boundary exports may span the requested start.",
      "Logs are deduplicated and aggregated in one ClickHouse query across the filtered window; usage retains per-request pricing tiers and scope completeness.",
      "Log limits apply independently to aggregate dimensions, not event volume. Limited sections do not hide unrelated summaries.",
      "Model filters on metrics/spans require a model attribute; model-less records are excluded.",
      "Trace statistics cover at most the latest 200 span records per trace from the latest 50 traces, not the entire range or guaranteed complete turns. Truncated traces withhold wall time and total errors.",
      "Git output, retained code quality and saved work time are not collected by this integration.",
    ],
  };
}
