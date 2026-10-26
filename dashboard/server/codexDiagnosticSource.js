import { toChDateTime } from "./clickhouse.js";

export function parseDiagnosticReadFrom(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
    throw new Error("CODEX_DIAGNOSTIC_READ_FROM must be a verified UTC timestamp (YYYY-MM-DDTHH:mm:ssZ)");
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString().replace(".000Z", "Z") !== value)
    throw new Error("CODEX_DIAGNOSTIC_READ_FROM is not a valid UTC timestamp");
  return date;
}
const readFrom = parseDiagnosticReadFrom(process.env.CODEX_DIAGNOSTIC_READ_FROM);

export function diagnosticSourceForRange(from, to, boundary = readFrom) {
  // Existing log query parameters truncate to whole seconds. Check that actual
  // SQL interval, including the truncated start, against verified backfill.
  const start = Math.floor(+from / 1000) * 1000, end = Math.floor(+to / 1000) * 1000;
  return boundary !== null && Number.isFinite(start) && Number.isFinite(end)
    && start >= +boundary && end >= start ? "states" : "raw";
}

const OVERVIEW_EVENTS = ["sse_event", "websocket_event", "api_request", "api_error",
  "tool_result", "tool_decision", "turn_ttft"].map(name => `'codex.${name}'`).join(", ");

// FINAL merges repeated insertion blocks/backfill overlap before finalization.
// All model-session evidence is selected before applying the backend filter,
// matching logSelection's model-less event attribution.
export function diagnosticSelection(from, to, filters = {}) {
  const params = { from: toChDateTime(from), to: toChDateTime(to),
    clientUser: filters.user || "", clientModel: filters.model || "", clientBackend: filters.backend || "" };
  const modelMatch = "positionCaseInsensitive(Model, {clientModel:String}) > 0";
  return { params, sql: `WITH diagnostic_events AS (
    SELECT * FROM claude_code.codex_diagnostic_events_v1 FINAL
    PREWHERE Second >= {from:DateTime} AND Second < {to:DateTime}
  )${filters.model ? `, model_sessions AS (
    SELECT ConversationId, UserEmail, ProjectName FROM diagnostic_events
    WHERE ConversationId != '' AND ${modelMatch}
      AND JSONExtractString(AttributesJSON, 'event.name') IN (${OVERVIEW_EVENTS})
  )` : ""}
  SELECT toString(toTimeZone(MaxTimestamp, 'UTC')) AS timestamp,
    toString(toTimeZone(MinTimestamp, 'UTC')) AS first_timestamp,
    finalizeAggregation(Identities) AS weight,
    CAST(map(), 'Map(String, String)') AS resource,
    JSONExtract(AttributesJSON, 'Map(String,String)') AS attributes
  FROM diagnostic_events
  WHERE ({clientUser:String} = '' OR positionCaseInsensitive(UserEmail, {clientUser:String}) > 0)
    AND ({clientBackend:String} = '' OR Backend = {clientBackend:String})
    ${filters.model ? `AND (${modelMatch} OR (Model = '' AND
      (ConversationId, UserEmail, ProjectName) IN (SELECT * FROM model_sessions)))` : ""}` };
}
