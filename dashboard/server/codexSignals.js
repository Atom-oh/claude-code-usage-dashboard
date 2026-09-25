import { ValidationError } from "./http.js";
import { toChDateTime } from "./clickhouse.js";
import { resolveBackend, backendSql } from "./backend.js";

const LIMIT = 50000;
const TYPES = ["sum", "gauge", "histogram", "exponential_histogram"];
const ordered = (o = {}) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const number = (v) => v !== null && v !== undefined && v !== "" && typeof v !== "boolean"
  && Number.isFinite(Number(v)) ? Number(v) : null;
const time = (v) => Date.parse(String(v).replace(" ", "T").replace(/(?<!Z)$/, "Z"));
const iso = (v) => Number.isFinite(v) ? new Date(v).toISOString() : null;
const positive = (v) => number(v) !== null && number(v) >= 0;
const quantile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function bounded(rows) {
  if (rows.length > LIMIT) throw new ValidationError("too much signal data", "narrow the requested date range");
}
const coverage = (rows) => ({ status: rows.length ? "observed" : "empty",
  records: rows.reduce((n, row) => n + Number(row.points ?? 1), 0),
  last_seen: rows.length ? iso(Math.max(...rows.map((r) => time(r.timestamp)))) : null });
function params(from, to, filters) {
  return { signalFrom: toChDateTime(from), signalTo: toChDateTime(to),
    signalUser: filters.user || "", signalModel: filters.model || "", signalBackend: filters.backend || "" };
}
const filter = (attributes, model = `${attributes}['model']`) => `
  AND ({signalUser:String} = '' OR positionCaseInsensitive(coalesce(
    nullIf(ResourceAttributes['user.email'], ''), ResourceAttributes['enduser.id']), {signalUser:String}) > 0)
  AND ({signalModel:String} = '' OR positionCaseInsensitive(${model}, {signalModel:String}) > 0)
  AND ({signalBackend:String} = '' OR ${backendSql(model, "ResourceAttributes['backend']")} = {signalBackend:String})`;

export function buildMetricQuery(type, from, to, filters = {}) {
  if (!TYPES.includes(type)) throw new Error("unsupported metric table");
  const histogram = type.endsWith("histogram");
  const identity = `name, unit, scope, scope_version, scope_attributes, resource, attributes,
    service_name, resource_schema_url, scope_schema_url, temporality, monotonic`;
  const source = `SELECT DISTINCT TimeUnix AS t, StartTimeUnix AS started,
    MetricName AS name, MetricUnit AS unit, ScopeName AS scope, ScopeVersion AS scope_version,
    mapSort(ScopeAttributes) AS scope_attributes, mapSort(ResourceAttributes) AS resource,
    mapSort(Attributes) AS attributes, ServiceName AS service_name,
    ResourceSchemaUrl AS resource_schema_url, ScopeSchemaUrl AS scope_schema_url, Flags AS sample_flags,
    ${histogram ? `Count AS sample_count, Sum AS sample_sum, Min AS sample_min, Max AS sample_max,
      toJSONString(tuple(${type === "histogram" ? "BucketCounts, ExplicitBounds"
        : "Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts"})) AS distribution`
      : "Value AS sample_value"},
    ${type === "gauge" ? "0" : "AggregationTemporality"} AS temporality,
    ${type === "sum" ? "IsMonotonic" : "true"} AS monotonic
    FROM claude_code.codex_metrics_${type}
    WHERE startsWith(MetricName, 'codex.') ${filter("Attributes")}`;
  const raw = `SELECT toString(toTimeZone(t, 'UTC')) AS timestamp,
    toString(toTimeZone(started, 'UTC')) AS start, '${type}' AS type, ${identity},
    sample_flags AS flags, ${histogram
      ? "toFloat64(sample_count) AS count, sample_sum AS sum, sample_min AS min, sample_max AS max, distribution"
      : "sample_value AS value"},
    toUInt64(1) AS points, toUInt64(0) AS invalid_samples, toUInt64(0) AS extremes_missing,
    ${histogram ? "toUInt64(sample_count > 0 AND sample_sum = 0)" : "toUInt64(0)"} AS sum_ambiguous`;
  const window = `${source}
    AND TimeUnix >= {signalFrom:DateTime} AND TimeUnix < {signalTo:DateTime}`;
  if (type === "gauge") return { sql: `WITH window_points AS (${window})
    ${raw} FROM window_points ORDER BY timestamp LIMIT 50001`, params: params(from, to, filters) };
  const valid = `bitAnd(sample_flags, 1) = 0 AND ${histogram
    ? "sample_count <= 9007199254740991 AND isFinite(sample_sum) AND sample_sum >= 0"
    : "isFinite(sample_value) AND (NOT monotonic OR sample_value >= 0)"}`;
  // Exporter 0.119 collapses absent optional Sum/Min/Max to zero. A positive
  // source value proves presence; zero does not (except the sum of zero samples).
  const extremes = "isFinite(sample_min) AND isFinite(sample_max) AND sample_min > 0 AND sample_max >= sample_min";
  // DELTA starts advance each export. Deduplicate full points before combining
  // their intervals; retain every resource/scope/label identity, but not each start.
  // Cumulative baselines retain the start boundary and ALL ties at the latest
  // timestamp so a conflicting retry cannot become an arbitrary prior value.
  return { sql: `WITH window_points AS (${window}),
    baseline_candidates AS (
      ${source}
      AND AggregationTemporality = 2
      AND TimeUnix >= {signalFrom:DateTime} - INTERVAL 3 DAY AND TimeUnix < {signalFrom:DateTime}
      AND (${identity}, started) IN (
        SELECT ${identity}, started FROM window_points WHERE temporality = 2)
    ),
    baselines AS (
      SELECT *, max(t) OVER (PARTITION BY ${identity}, started) AS latest FROM baseline_candidates
    ),
    delta_points AS (
      SELECT *, (${valid}) AND variants = 1 AS valid FROM (
        SELECT *, count() OVER (PARTITION BY ${identity}, started, t) AS variants
        FROM window_points WHERE temporality = 1)
    )
    SELECT * FROM (
      ${raw} FROM window_points WHERE temporality != 1
      UNION ALL ${raw} FROM baselines WHERE t = latest
      UNION ALL
      SELECT toString(toTimeZone(max(t), 'UTC')) AS timestamp,
        toString(toTimeZone(min(started), 'UTC')) AS start, '${type}' AS type, ${identity},
        toUInt32(0) AS flags, ${histogram
          ? `sumIf(toFloat64(sample_count), valid) AS count, sumIf(sample_sum, valid) AS sum,
            minOrNullIf(sample_min, valid AND sample_count > 0 AND (${extremes})) AS min,
            maxOrNullIf(sample_max, valid AND sample_count > 0 AND (${extremes})) AS max, '' AS distribution`
          : "sumIf(sample_value, valid) AS value"},
        count() AS points, countIf(NOT valid) AS invalid_samples,
        ${histogram ? `countIf(sample_count > 0 AND NOT (${extremes}))` : "toUInt64(0)"} AS extremes_missing,
        ${histogram ? "countIf(valid AND sample_count > 0 AND sample_sum = 0)" : "toUInt64(0)"} AS sum_ambiguous
      FROM delta_points GROUP BY ${identity}
    ) ORDER BY timestamp LIMIT 50001`, params: params(from, to, filters) };
}

const monotonic = (row) => ![false, 0, "0", "false"].includes(row.monotonic);
function validMetric(row) {
  if ((Number(row.flags || 0) & 1) || Number(row.invalid_samples || 0) > 0 || row.conflict) return false;
  return row.type.endsWith("histogram")
    ? positive(row.count) && Number.isSafeInteger(Number(row.count)) && positive(row.sum)
    : number(row.value) !== null && (row.type !== "sum" || !monotonic(row) || Number(row.value) >= 0);
}

// Metrics are diagnostic observations. They never enter the completion-log cost total.
export function foldCodexMetrics(rows, from, to) {
  bounded(rows);
  const seen = new Set(), points = new Map(), series = new Map(), groups = new Map(), inRange = [], unique = [];
  for (const row of rows) {
    const seriesId = JSON.stringify([row.name, row.type, row.unit, row.scope, row.scope_version || "",
      ordered(row.scope_attributes), ordered(row.resource), ordered(row.attributes), row.start,
      row.service_name || "", row.resource_schema_url || "", row.scope_schema_url || "",
      Number(row.temporality), monotonic(row)]);
    const pointId = JSON.stringify([seriesId, row.timestamp]);
    const fingerprint = JSON.stringify([pointId, row.value, row.count, row.sum, row.min, row.max,
      row.flags, row.distribution, row.points, row.invalid_samples, row.extremes_missing, row.sum_ambiguous]);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const sample = { ...row, seriesId };
    if (points.has(pointId)) { points.get(pointId).conflict = true; sample.conflict = true; }
    else points.set(pointId, sample);
    unique.push(sample);
  }
  for (const row of unique.sort((a, b) => time(a.timestamp) - time(b.timestamp)
    || String(a.timestamp).localeCompare(String(b.timestamp)))) {
    const stamp = time(row.timestamp);
    if (!Number.isFinite(stamp) || stamp >= +to) continue;
    const resource = ordered(row.resource), attributes = ordered(row.attributes);
    const seriesId = row.seriesId;
    const previous = series.get(seriesId);
    series.set(seriesId, row);
    if (stamp < +from) continue;
    inRange.push(row);
    const dimensions = { ...attributes, backend: resolveBackend(attributes.model, resource.backend) };
    const groupId = JSON.stringify([row.name, row.type, row.unit, dimensions]);
    if (!groups.has(groupId)) groups.set(groupId, { name: row.name, type: row.type, unit: row.unit || "",
      dimensions, points: 0, value: 0, count: 0, sum: 0, mean: null, min: null, max: null, partial: false,
      _gauge: [], _series: new Set(), _extremes: true, _sumKnown: true });
    const group = groups.get(groupId);
    group.points += Number(row.points ?? 1);
    group._series.add(seriesId);
    const isHistogram = row.type.endsWith("histogram");
    if (!validMetric(row)) { group.partial = true; continue; }
    if (row.type === "gauge") {
      group._gauge.push(Number(row.value)); group.value = Number(row.value);
      continue;
    }
    let value = isHistogram ? Number(row.count) : Number(row.value);
    let sum = isHistogram ? Number(row.sum) : 0;
    if (isHistogram && (Number(row.sum_ambiguous || 0) > 0 || value > 0 && sum === 0)) group._sumKnown = false;
    if (Number(row.temporality) === 2) {
      if (previous) {
        const prior = isHistogram ? number(previous.count) : number(previous.value);
        const priorSum = isHistogram ? number(previous.sum) : 0;
        if (!validMetric(previous)) { group.partial = true; continue; }
        if (isHistogram && (Number(previous.sum_ambiguous || 0) > 0 || prior > 0 && priorSum === 0)) group._sumKnown = false;
        value -= prior; sum -= priorSum;
        if (isHistogram || monotonic(row)) {
          if (value < 0 || sum < 0) { group.partial = true; continue; }
        }
        group._extremes = false;
      } else if (!(time(row.start) >= +from && time(row.start) <= stamp)) {
        group.partial = true; continue;
      }
    } else if (Number(row.temporality) !== 1) { group.partial = true; continue; }
    if (isHistogram) {
      group.count += value; group.sum += sum;
      if (Number(row.extremes_missing || 0) > 0) group._extremes = false;
      if (value && number(row.min) > 0 && positive(row.max) && Number(row.max) >= Number(row.min)) {
        group.min = group.min === null ? Number(row.min) : Math.min(group.min, Number(row.min));
        group.max = group.max === null ? Number(row.max) : Math.max(group.max, Number(row.max));
      } else if (value) group._extremes = false;
    } else group.value += value;
  }
  const metrics = [...groups.values()].map(({ _gauge, _series, _extremes, _sumKnown, ...row }) => {
    if (row.type === "gauge") {
      row.value = _series.size === 1 ? row.value : null;
      row.mean = average(_gauge); row.min = _gauge.length ? Math.min(..._gauge) : null;
      row.max = _gauge.length ? Math.max(..._gauge) : null; row.count = row.sum = null;
    } else if (row.type === "sum") row.count = row.sum = null;
    else {
      row.value = null; row.mean = row.count ? row.sum / row.count : null;
      if (!_extremes) row.min = row.max = null;
    }
    if (row.partial || row.count !== null && !Number.isSafeInteger(row.count)
      || ["value", "count", "sum", "mean"].some((key) => row[key] !== null && !Number.isFinite(row[key]))) {
      row.partial = true; row.value = row.count = row.sum = row.mean = row.min = row.max = null;
    } else if (row.type.endsWith("histogram")) {
      if (!_sumKnown) row.sum = row.mean = null;
      if (!_sumKnown || !_extremes && row.count > 0) row.partial = true;
    }
    return row;
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { metrics, coverage: coverage(inRange) };
}

export function buildTraceQuery(from, to, filters = {}) {
  const model = "coalesce(nullIf(SpanAttributes['model'], ''), SpanAttributes['gen_ai.request.model'])";
  const where = `Timestamp >= {signalFrom:DateTime} AND Timestamp < {signalTo:DateTime}
      AND ResourceAttributes['client'] = 'codex' ${filter("SpanAttributes", model)}`;
  return { sql: `WITH recent_traces AS (
      SELECT TraceId FROM claude_code.otel_traces WHERE ${where}
      GROUP BY TraceId ORDER BY max(Timestamp) DESC, TraceId DESC LIMIT 50
    ), selected_spans AS (
    SELECT DISTINCT toString(toTimeZone(Timestamp, 'UTC')) AS timestamp, TraceId AS trace_id, SpanId AS span_id,
    ParentSpanId AS parent_span_id, SpanName AS name, Duration AS duration_ns, StatusCode AS status,
    ${model} AS model, SpanAttributes['tool_name'] AS tool_name,
    coalesce(nullIf(SpanAttributes['codex.turn.reasoning_effort'], ''),
      SpanAttributes['codex.request.reasoning_effort']) AS effort,
    coalesce(nullIf(SpanAttributes['turn_id'], ''), SpanAttributes['turn.id']) AS turn_id
    FROM claude_code.otel_traces
    WHERE ${where} AND TraceId IN (SELECT TraceId FROM recent_traces)
    ), span_variants AS (
      SELECT *, count() OVER (PARTITION BY trace_id, span_id) AS variants FROM selected_spans
    )
    SELECT *, count() OVER (PARTITION BY trace_id) AS trace_records,
      uniqExactIf(span_id, variants > 1) OVER (PARTITION BY trace_id) AS trace_conflicting_spans
    FROM span_variants
    ORDER BY timestamp DESC, trace_id, span_id, duration_ns, status
    LIMIT 200 BY trace_id
    LIMIT 10000`, params: params(from, to, filters) };
}

const identifier = (value) => typeof value === "string" && /^[a-z0-9_][a-z0-9_.+-]{0,127}$/i.test(value)
  ? value : null;
const operation = (value) => typeof value === "string"
  && (/^[a-z_][a-z0-9_.:-]{0,127}$/i.test(value) || ["thread/start", "thread/unsubscribe"].includes(value))
  ? value : "unknown";
export function foldCodexTraces(rows) {
  bounded(rows);
  const seen = new Map(), groups = new Map(), traces = new Map(), valid = [];
  const conflicts = new Map(), sourceConflicts = new Map(), partial = new Set(), truncated = new Set();
  let lastSeen = -Infinity;
  for (const row of rows) {
    if (!row.trace_id || !row.span_id || !Number.isFinite(time(row.timestamp))) continue;
    const stamp = time(row.timestamp);
    if (Number(row.trace_records) > 200) truncated.add(row.trace_id);
    if (Number(row.trace_conflicting_spans) > 0) {
      sourceConflicts.set(row.trace_id, Number(row.trace_conflicting_spans));
      partial.add(row.trace_id);
    }
    lastSeen = Math.max(lastSeen, stamp);
    if (!traces.has(row.trace_id)) traces.set(row.trace_id,
      { trace_id: row.trace_id, spans: [], errors: 0, start_time: iso(stamp) });
    const trace = traces.get(row.trace_id);
    trace.start_time = iso(Math.min(time(trace.start_time), stamp));
    const key = `${row.trace_id}:${row.span_id}`;
    const fingerprint = JSON.stringify([row.timestamp, row.parent_span_id || "", row.name,
      number(row.duration_ns), row.status || "Unset", row.model || "", row.tool_name || "",
      row.effort || "", row.turn_id || ""]);
    if (seen.has(key)) {
      if (seen.get(key) !== fingerprint) {
        if (!conflicts.has(row.trace_id)) conflicts.set(row.trace_id, new Set());
        conflicts.get(row.trace_id).add(row.span_id);
        partial.add(row.trace_id);
      }
      continue;
    }
    seen.set(key, fingerprint); valid.push(row);
  }
  // Detect all conflicts before folding: no span of an affected trace is trustworthy.
  for (const row of valid) {
    if (partial.has(row.trace_id)) continue;
    const duration = positive(row.duration_ns) ? Number(row.duration_ns) / 1e6 : null;
    const name = operation(row.name);
    const span = { span_id: row.span_id, parent_span_id: row.parent_span_id || "", name,
      start_time: iso(time(row.timestamp)), duration_ms: duration, status: row.status || "Unset",
      model: identifier(row.model), tool_name: identifier(row.tool_name),
      effort: identifier(row.effort), turn_id: identifier(row.turn_id) };
    const error = row.status === "Error" || Number(row.status) === 2;
    if (!groups.has(name)) groups.set(name, { name, count: 0, errors: 0, durations: [] });
    const group = groups.get(name); group.count++; group.errors += error ? 1 : 0;
    if (duration !== null) group.durations.push(duration);
    const trace = traces.get(row.trace_id); trace.spans.push(span); trace.errors += error ? 1 : 0;
  }
  return { coverage: { ...coverage(valid), last_seen: iso(lastSeen), partial: partial.size > 0,
    partial_traces: partial.size, conflicting_spans: [...partial].reduce((total, id) =>
      total + Math.max(sourceConflicts.get(id) || 0, conflicts.get(id)?.size || 0), 0),
    ...(truncated.size ? { truncated_traces: truncated.size } : {}) },
    spans: [...groups.values()].map(({ durations, ...row }) => ({ ...row, average_ms: average(durations),
      p95_ms: quantile(durations, 0.95) })).sort((a, b) => b.count - a.count),
    traces: [...traces.values()].sort((a, b) => time(b.start_time) - time(a.start_time)).slice(0, 50).map((trace) => {
      if (partial.has(trace.trace_id)) return { trace_id: trace.trace_id,
        span_count: null, wall_ms: null, errors: null, spans: [], partial: true };
      trace.spans.sort((a, b) => time(a.start_time) - time(b.start_time));
      const start = time(trace.spans[0].start_time);
      return { ...trace, start_time: iso(start), span_count: trace.spans.length,
        ...(truncated.has(trace.trace_id) ? { truncated: true, errors: null } : {}),
        wall_ms: truncated.has(trace.trace_id) || trace.spans.some((s) => s.duration_ms === null) ? null
          : Math.max(...trace.spans.map((s) => time(s.start_time) + s.duration_ms)) - start };
    }) };
}
