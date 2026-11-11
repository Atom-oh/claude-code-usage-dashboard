import { TURNS_TABLE } from "./sessionTurnsSchema.js";

export function parseTurnsReadFrom(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))
    throw new Error("SESSION_TURNS_READ_FROM must be a verified UTC timestamp (YYYY-MM-DDTHH:mm:ssZ)");
  const date = new Date(value);
  if (!Number.isFinite(+date) || date.toISOString().replace(".000Z", "Z") !== value)
    throw new Error("SESSION_TURNS_READ_FROM is not a valid UTC timestamp");
  return date;
}
export const turnsReadFrom = parseTurnsReadFrom(process.env.SESSION_TURNS_READ_FROM);

const HOUR_MS = 3600 * 1000;
const RETENTION_MS = 90 * 24 * HOUR_MS;

// There is no raw-log fallback: a window the backfill does not cover, or one
// older than log retention (the transform's source), is unavailable, not zero.
export function turnsReadiness(from, now, boundary = turnsReadFrom) {
  if (boundary === null || +from < +boundary) return "not_backfilled";
  if (+from < +now - RETENTION_MS + HOUR_MS) return "retention";
  return null;
}

// Bound values only. The clients array filters before grouping, so both
// grouping sets see the same rows; an empty array matches nothing.
// Window rows (second grouping set) carry bucket = ''.
export function turnsSql() {
  return `SELECT Client AS client, SessionId AS session, UserIdentity AS user,
    formatDateTime({from:DateTime} + intDiv(dateDiff('second', {from:DateTime}, hour), {bucketSeconds:UInt32}) * {bucketSeconds:UInt32},
      '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS bucket,
    Kind AS kind, Model AS model, uniqExactMerge(Keys) AS n
  FROM ${TURNS_TABLE}
  PREWHERE hour >= {from:DateTime} AND hour < {to:DateTime}
    AND Client IN {clients:Array(String)}
    AND ({clientUser:String} = '' OR positionCaseInsensitive(UserIdentity, {clientUser:String}) > 0)
    AND ({clientUserExact:String} = '' OR UserIdentity = {clientUserExact:String})
  GROUP BY GROUPING SETS (
    (Client, SessionId, UserIdentity, bucket, Kind, Model),
    (Client, SessionId, UserIdentity, Kind, Model))`;
}
