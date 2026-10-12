import { readFileSync } from "node:fs";
import { classifyFreshness } from "./freshness.js";

const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version;

export function describeInstallation({ auth, enabledClients, databaseReady, readonly, schema,
  readonlyCheckedAt, latestByClient, staleAfterMinutes, revision, now = Date.now() }) {
  const clients = enabledClients.map(client => {
    const latest = latestByClient[client];
    if (latest === 0) return { client, state: "empty", latest: null, ageMinutes: null };
    if (latest === null || latest === undefined || !Number.isFinite(latest) || latest < 0)
      return { client, state: "unavailable", latest: null, ageMinutes: null };
    const freshness = classifyFreshness({ latestMs: latest, nowMs: now, staleAfterMinutes });
    return { client, state: freshness.status === "ok" ? "receiving" : "stale",
      latest: freshness.latest, ageMinutes: freshness.ageMinutes };
  });
  const authState = auth.mode === "oidc" ? "oidc_configured" : auth.enabled ? "shared_credential" : "development_bypass";
  const schemaState = {
    checkedAt: schema.checkedAt || null,
    migrations: Array.isArray(schema.migrations) ? schema.migrations : null,
    counterIdentity: !enabledClients.includes("claude") ? "not_applicable"
      : schema.segmentAwareSeriesKey === true ? "confirmed"
        : schema.segmentAwareSeriesKey === false ? "legacy" : "unavailable",
    projectFields: schema.projectColumns === true ? "confirmed"
      : schema.projectColumns === false ? "unconfirmed" : "unavailable",
  };
  return {
    checkedAt: new Date(now).toISOString(),
    state: !databaseReady || readonly !== true || authState !== "oidc_configured"
      || clients.some(client => client.state !== "receiving")
      || !schemaState.migrations?.length || schemaState.counterIdentity === "legacy"
      || schemaState.counterIdentity === "unavailable" ? "needs_attention" : "operational",
    release: { version: packageVersion, revision: /^[a-f0-9]{40,64}$/.test(revision || "") ? revision : null },
    authentication: { state: authState, mode: auth.mode },
    database: { state: databaseReady ? "reachable" : "unavailable",
      readonly: readonly === true ? "confirmed" : readonly === false ? "not_readonly" : "unavailable",
      readonlyCheckedAt: readonlyCheckedAt || null },
    schema: schemaState,
    clients,
    staleAfterMinutes,
    limits: { receiptIsNotCompleteCoverage: true, migrationLedgerIsNotDdlVerification: true,
      identityIsNotMfaVerification: true, checksDoNotVerifyBackups: true },
  };
}

export function createInstallationProbe({ auth, enabledClients, ping, probeLatest, getSchema,
  getReadonly, getReadonlyCheckedAt = () => null, staleAfterMinutes, revision, now = Date.now, ttlMs = 30_000 }) {
  let memo;
  return () => {
    // One key per installation, no usage filters or per-viewer data; concurrent reads share work.
    if (!memo || memo.expires <= now()) {
      const promise = Promise.all([
        Promise.resolve().then(ping).catch(() => false),
        Promise.all(enabledClients.map(async client => {
          try { return [client, await probeLatest([client])]; } catch { return [client, null]; }
        })),
      ]).then(([databaseReady, observations]) => describeInstallation({
        auth, enabledClients, databaseReady, latestByClient: Object.fromEntries(observations),
        readonly: getReadonly(), readonlyCheckedAt: getReadonlyCheckedAt(),
        schema: getSchema(), staleAfterMinutes, revision, now: now(),
      }));
      memo = { expires: Infinity, promise };
      promise.then(() => {
        if (memo?.promise === promise) memo.expires = now() + ttlMs;
      }, () => {
        if (memo?.promise === promise) memo = null;
      });
    }
    return memo.promise;
  };
}
