import { query } from "./clickhouse.js";
import { codexPrices, validateClientFilters } from "./clientMetrics.js";
import { buildCodexInsightsLogQuery, foldCodexInsightsLogs } from "./codexInsightsLogs.js";
import { buildMetricQuery, buildTraceQuery, foldCodexMetrics, foldCodexTraces } from "./codexSignals.js";

const TYPES = ["sum", "gauge", "histogram", "exponential_histogram"];
async function optionalQuery(request, run) {
  try { return { rows: await run(request.sql, request.params), unavailable: false }; }
  catch (error) {
    if (String(error.code) === "60") return { rows: [], unavailable: true };
    throw error;
  }
}

export async function codexInsights(from, to, raw = {}, run = query) {
  const filters = validateClientFilters(raw, ["codex"]);
  const logQuery = buildCodexInsightsLogQuery(from, to, filters);
  const [logRows, metricResults, traceResult] = await Promise.all([
    run(logQuery.sql, logQuery.params),
    Promise.all(TYPES.map((type) => optionalQuery(buildMetricQuery(type, from, to, filters), run))),
    optionalQuery(buildTraceQuery(from, to, filters), run),
  ]);
  const { coverage: logCoverage, ...logs } = foldCodexInsightsLogs(logRows, codexPrices);
  const { coverage: metricCoverage, metrics } = foldCodexMetrics(metricResults.flatMap((r) => r.rows), from, to);
  const { coverage: traceCoverage, spans, traces } = foldCodexTraces(traceResult.rows);
  const unavailable = TYPES.filter((_, i) => metricResults[i].unavailable);
  return {
    range: { from: from.toISOString(), to: to.toISOString() },
    ...logs, metrics, spans, traces,
    coverage: {
      logs: logCoverage,
      metrics: { ...metricCoverage, ...(unavailable.length === TYPES.length ? { status: "unavailable" } : {}),
        unavailable_types: unavailable, partial: unavailable.length > 0 || metrics.some((m) => m.partial) },
      traces: { ...traceCoverage, ...(traceResult.unavailable ? { status: "unavailable" } : {}) },
    },
    limitations: [
      "Logs supply token and AWS list-price estimates; metrics and traces are independent diagnostic signals.",
      "Metrics use export timestamps; boundary exports may span the requested start.",
      "Model filters on metrics/spans require a model attribute; model-less records are excluded.",
      "Trace windows cover observed spans, not guaranteed complete turns; at most 50 traces are shown.",
      "Git output, retained code quality and saved work time are not collected by this integration.",
    ],
  };
}
