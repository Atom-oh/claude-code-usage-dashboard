// Process-wide snapshot of the Cognito directory, injected into queries as bound array parameters.
// Kept free of clickhouse.js imports because clickhouse.js imports this module.
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

export function directoryParams(sql, params) {
  if (typeof sql !== "string" || !sql.includes("{dirKey:")) return params;
  return {
    ...params,
    dirIssuer: snapshot?.issuer ?? "",
    dirKey: snapshot?.keys ?? [],
    dirTeam: snapshot?.teams ?? [],
    dirFrom: (snapshot?.froms ?? []).map(chDateTime),
    dirTo: (snapshot?.tos ?? []).map(chDateTime),
  };
}
