import { COST_TOKEN_FIELDS } from "./codexCostSchema.js";

export function parseCostReadFrom(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
    throw new Error("CODEX_COST_READ_FROM must be a verified UTC timestamp (YYYY-MM-DDTHH:mm:ssZ)");
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString().replace(".000Z", "Z") !== value)
    throw new Error("CODEX_COST_READ_FROM is not a valid UTC timestamp");
  return date;
}
const readFrom = parseCostReadFrom(process.env.CODEX_COST_READ_FROM);

export function costSourceForRange(from, boundary = readFrom) {
  return boundary !== null && +from >= +boundary ? "facts" : "raw";
}

// Bound values only. Model-less rows must survive here: the caller performs its
// existing model-session matching after assembling both event and scope sources.
export function costSourceSql({ diagnostics = false } = {}) {
  const user = `({clientUser:String} = '' OR positionCaseInsensitive(UserEmail, {clientUser:String}) > 0)
    AND ({clientUserExact:String} = '' OR UserEmail = {clientUserExact:String})`;
  // An explicit GROUP BY identity remains semantically significant when the
  // outer aggregation prunes unused columns (including through UNION ALL).
  return `SELECT Timestamp, Identity, ConversationId AS session, UserEmail AS user,
    Model AS model, Backend AS backend, ProjectName AS project, EventName AS event_name,
    Kind AS kind, Rejected AS rejected,
    ${COST_TOKEN_FIELDS.map(([, column, alias]) => `${column}Value AS ${alias}, ${column}Valid AS ${alias}_valid`).join(",\n    ")}
    ${diagnostics ? ", JSONExtract(Identity, 2, 'Map(String,String)') AS a" : ""}
  FROM claude_code.codex_cost_events_v1
  PREWHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime} AND ${user}
  GROUP BY Timestamp, Identity, ConversationId, UserEmail, Model, Backend, ProjectName, EventName, Kind, Rejected,
    ${COST_TOKEN_FIELDS.flatMap(([, column]) => [`${column}Value`, `${column}Valid`]).join(", ")}
  UNION ALL
  SELECT toDateTime64(min(toUnixTimestamp(Minute) + arrayMin(in_range)),9) AS Timestamp,
    '' AS Identity, ConversationId, UserEmail, Model, Backend, ProjectName, EventName,
    'scope_evidence', toUInt8(0),
    ${COST_TOKEN_FIELDS.map(() => "toFloat64(0), toUInt8(0)").join(", ")}
    ${diagnostics ? ", CAST(map(), 'Map(String,String)')" : ""}
  FROM (
    SELECT Minute, UserEmail, ConversationId, Model, Backend, ProjectName, EventName,
      arrayFilter(second -> toUnixTimestamp(Minute) + second >= toUnixTimestamp({from:DateTime})
        AND toUnixTimestamp(Minute) + second < toUnixTimestamp({to:DateTime}),
        groupUniqArrayMerge(Seconds)) AS in_range
    FROM claude_code.codex_cost_scope_v1
    PREWHERE Minute >= toStartOfMinute({from:DateTime}) AND Minute < {to:DateTime} AND ${user}
    GROUP BY Minute, UserEmail, ConversationId, Model, Backend, ProjectName, EventName
    HAVING notEmpty(in_range)
  )
  GROUP BY ConversationId, UserEmail, Model, Backend, ProjectName, EventName`;
}
