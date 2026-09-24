import { query } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { codexPrices, validateClientFilters } from "./clientMetrics.js";
import { buildCodexLogAggregateQuery, foldCodexLogAggregates } from "./codexLogAggregates.js";
import { buildMetricQuery, buildTraceQuery, foldCodexMetrics, foldCodexTraces } from "./codexSignals.js";

const TYPES = ["sum", "gauge", "histogram", "exponential_histogram"];
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
  const logQuery = buildCodexLogAggregateQuery(from, to, filters, codexPrices);
  const [logRows, metricResults, traceResult] = await Promise.all([
    run(logQuery.sql, logQuery.params),
    Promise.all(TYPES.map((type) => optionalQuery(buildMetricQuery(type, from, to, filters), run))),
    optionalQuery(buildTraceQuery(from, to, filters), run),
  ]);
  const { coverage: logCoverage, ...logs } = foldCodexLogAggregates(logRows);
  const { coverage: metricCoverage, metrics } = foldSignal(metricResults.flatMap((r) => r.rows),
    (rows) => foldCodexMetrics(rows, from, to), "too much signal data");
  const { coverage: traceCoverage, spans, traces } = foldCodexTraces(traceResult.rows);
  const unavailable = TYPES.filter((_, i) => metricResults[i].unavailable);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    ...logs, metrics, spans, traces,
    coverage: {
      logs: logCoverage,
      metrics: { ...metricCoverage, ...(unavailable.length === TYPES.length ? { status: "unavailable" } : {}),
        unavailable_types: unavailable, partial: unavailable.length > 0 || metrics.some((m) => m.partial) },
      traces: { ...traceCoverage, selection: "latest_50_traces", span_limit_per_trace: 200,
        ...(traceResult.unavailable ? { status: "unavailable" } : {}) },
    },
    limitations: [
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
