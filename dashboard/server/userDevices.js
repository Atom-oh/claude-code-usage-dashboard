// Per-user device list. The device receiver sets the `ccdash.device` resource attribute
// (`<owner>.<id>`) on logs and traces from the ingest proxy's verified device token (see
// collectorRoutes.js and scripts/sync-collector-package.py), replacing any client-sent value;
// the other collector configurations delete it. A writer with ClickHouse insert credentials
// is not constrained by it. Data from before the
// stamp, or from paths outside device ingestion, has no device: those sessions are counted as
// unattributed, never assigned a guessed device.
import { query as defaultQuery, toChDateTime } from "./clickhouse.js";
import { ValidationError } from "./http.js";
import { selectClients } from "./clients.js";
import { LOG_USER, TEAM_SESSIONS } from "./queries.js";

const DEVICE = /^([a-f0-9]{64})\.([a-f0-9]{32})$/;
export const DEVICE_LIMIT = 20;
export const SESSION_LIMIT = 500;
const NAME_TTL_MS = 5 * 60 * 1000;
const NAME_CACHE_LIMIT = 1000;

export function validateDeviceQuery(raw, enabledClients) {
  const clients = selectClients(raw.client, enabledClients);
  const userExact = raw.userExact;
  if (typeof userExact !== "string" || userExact === "" || userExact.length > 256)
    throw new ValidationError("invalid filter", "userExact is required: a string of at most 256 characters");
  return { clients, userExact };
}

export function deviceCacheKey(query, enabledClients) {
  const { clients, userExact } = validateDeviceQuery(query, enabledClients);
  return new URLSearchParams([["client", clients.join(",")], ["from", query.from ?? ""], ["to", query.to ?? ""],
    ["userExact", userExact]].filter(([, value]) => value !== "")).toString();
}

// One row per (client, session, device); device '' marks rows without the stamp. Codex skips
// streaming rows (codex.sse_event) for the same reason as team evidence: they are ~97% of Codex
// logs and carry the same resource attributes as the conversation's other events.
export function userDevicesSql(clients) {
  return clients.map((client) => {
    const [session, where] = TEAM_SESSIONS[client];
    return `SELECT '${client}' AS client, ${session} AS session, ResourceAttributes['ccdash.device'] AS device,
        any(ResourceAttributes['os.type']) AS os_type, toString(min(Timestamp)) AS first_seen,
        toString(max(Timestamp)) AS last_seen
      FROM claude_code.otel_logs
      WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime} AND ${where} AND session != ''
        AND ${LOG_USER} = {userExact:String}
      GROUP BY session, device`;
  }).join("\nUNION ALL\n");
}

/** In-process name cache in front of the registry lookup (GetItem per device). */
export function createDeviceNames({ lookup, now = Date.now, ttlMs = NAME_TTL_MS } = {}) {
  const cache = new Map();
  return async function names(keys, signal) {
    if (!lookup) return null;
    const at = now();
    const result = new Map();
    try {
      await Promise.all(keys.map(async (key) => {
        const hit = cache.get(key);
        if (hit && hit.until > at) return void result.set(key, hit.value);
        const [, owner, id] = DEVICE.exec(key);
        const record = await lookup(owner, id, { signal });
        const value = record ? { name: record.name, platform: record.platform, revoked: record.revoked === true }
          : { deleted: true };
        if (cache.size >= NAME_CACHE_LIMIT) cache.delete(cache.keys().next().value);
        cache.set(key, { value, until: at + ttlMs });
        result.set(key, value);
      }));
    } catch {
      // Registry outage: names are unavailable, the device list itself is still answered.
      return null;
    }
    return result;
  };
}

const later = (a, b) => (a > b ? a : b);
const earlier = (a, b) => (a < b ? a : b);

/** Folds session rows into devices; invalid device values count as unattributed. */
export function foldDevices(rows) {
  const devices = new Map();
  const sessions = new Map();
  for (const row of rows) {
    const key = `${row.client}\0${row.session}`;
    const entry = sessions.get(key) || { session: row.session, device: null, last_seen: "" };
    entry.last_seen = later(entry.last_seen, row.last_seen);
    if (DEVICE.test(row.device)) {
      if (!entry.device || row.last_seen > entry.deviceSeen) { entry.device = row.device; entry.deviceSeen = row.last_seen; }
      const device = devices.get(row.device) || { device: row.device, clients: new Set(), os_types: new Set(),
        sessions: new Set(), first_seen: row.first_seen, last_seen: row.last_seen };
      device.clients.add(row.client);
      if (row.os_type) device.os_types.add(row.os_type);
      device.sessions.add(key);
      device.first_seen = earlier(device.first_seen, row.first_seen);
      device.last_seen = later(device.last_seen, row.last_seen);
      devices.set(row.device, device);
    }
    sessions.set(key, entry);
  }
  const list = [...devices.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1
    : a.device < b.device ? -1 : 1));
  const attributed = [...sessions.values()].filter((s) => s.device)
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  return {
    devices: list.slice(0, DEVICE_LIMIT).map((d) => ({ device: d.device, clients: [...d.clients].sort(),
      os_types: [...d.os_types].sort(), sessions: d.sessions.size, first_seen: d.first_seen, last_seen: d.last_seen })),
    devices_truncated: list.length > DEVICE_LIMIT,
    sessions: Object.fromEntries(attributed.slice(0, SESSION_LIMIT).map((s) => [s.session, s.device])),
    sessions_truncated: attributed.length > SESSION_LIMIT,
    unattributed_sessions: [...sessions.values()].filter((s) => !s.device).length,
  };
}

// maskNames (the deployment PII mask): registry names are user-entered and often personal, so they
// are not sent at all; clients show the short device ID instead.
export async function userDevices(from, to, raw, enabledClients, { names, maskNames = false, run = defaultQuery, signal } = {}) {
  const { clients, userExact } = validateDeviceQuery(raw, enabledClients);
  const rows = await run(userDevicesSql(clients),
    { from: toChDateTime(from), to: toChDateTime(to), userExact }, signal);
  const folded = foldDevices(rows);
  const resolved = names && !maskNames ? await names(folded.devices.map((d) => d.device), signal) : null;
  return {
    ...folded,
    names_masked: maskNames,
    names_available: resolved !== null,
    devices: folded.devices.map((d) => ({ ...d, ...(resolved?.get(d.device) ?? {}) })),
  };
}
