// Process-wide snapshot of the Cognito directory, injected into queries as bound array parameters.
// Kept free of clickhouse.js imports because clickhouse.js imports this module.
// The client's own formatter, as used for param_* query-string values. A default import of the CommonJS
// file works in Node and is inlined by esbuild; createRequire would need node_modules at runtime.
import formatQueryParamsModule from "@clickhouse/client/dist/common/data_formatter/format_query_params.js";

const { formatQueryParams } = formatQueryParamsModule;

let snapshot = null;
let version = "none";

// Same output as clickhouse.js toChDateTime, for millisecond inputs (second precision).
const chDateTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

export function setDirectorySnapshot(next, nextVersion) {
  snapshot = next || null;
  version = snapshot ? String(nextVersion) : "none";
}

export const directoryVersion = () => version;

export function directoryMeta() {
  return snapshot
    ? { labels: snapshot.labels || {}, historyStart: snapshot.historyStart ?? null, directory: snapshot.directory === true }
    : { labels: {}, historyStart: null, directory: false };
}

const dirParams = (s) => ({
  dirIssuer: s?.issuer ?? "",
  dirKey: s?.keys ?? [],
  dirTeam: s?.teams ?? [],
  dirFrom: (s?.froms ?? []).map(chDateTime),
  dirTo: (s?.tos ?? []).map(chDateTime),
});

/** URL-encoded size of the `param_dir*` query-string values a snapshot adds, using the client's own formatter. */
export function encodedParamBytes(next) {
  const query = new URLSearchParams(Object.entries(dirParams(next))
    .map(([key, value]) => [`param_${key}`, formatQueryParams({ value })]));
  return query.toString().length;
}

export function directoryParams(sql, params) {
  if (typeof sql !== "string" || !sql.includes("{dirKey:")) return params;
  return { ...params, ...dirParams(snapshot) };
}
