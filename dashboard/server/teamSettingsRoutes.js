import express from "express";
import { attributableUsers, attributeValue, parseCognitoIssuer, userKey } from "./teamDirectory.js";

const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const MAX_LABEL_LENGTH = 80;
const MAX_LABEL_KEY_LENGTH = 256;
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

class SettingsError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Directory teams need OIDC, a Cognito issuer and the device-token table; the first missing one is the reason. */
export function teamDirectoryConfig({ mode, env }) {
  if (mode !== "oidc") return { reason: "basic_auth" };
  let issuer;
  try { issuer = new URL(env.OIDC_ISSUER).href; } catch { return { reason: "not_cognito" }; }
  const pool = parseCognitoIssuer(issuer);
  if (!pool) return { reason: "not_cognito" };
  if (typeof env.INGEST_TOKEN_TABLE !== "string" || !TABLE_NAME.test(env.INGEST_TOKEN_TABLE))
    return { reason: "ingest_disabled" };
  return { reason: null, issuer, ...pool, tableName: env.INGEST_TOKEN_TABLE };
}

// Labels map raw directory values to display names; two values may not share one.
function parseLabels(labels) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) throw new SettingsError("invalid_labels", 400);
  const entries = [];
  const seen = new Set();
  for (const [key, raw] of Object.entries(labels)) {
    const label = typeof raw === "string" ? raw.trim() : "";
    if (!key || key.length > MAX_LABEL_KEY_LENGTH || !label || label.length > MAX_LABEL_LENGTH)
      throw new SettingsError("invalid_labels", 400);
    if (seen.has(label)) throw new SettingsError("duplicate_label", 400);
    seen.add(label);
    entries.push([key, label]);
  }
  // fromEntries defines own properties, so a "__proto__" key stays an ordinary label.
  return Object.fromEntries(entries);
}

export function createTeamSettings({ authentication, store, directory, sync, now = Date.now, issuer, poolId, reason }) {
  const available = !reason;

  // Aborts directory/store calls when the client goes away before the response.
  function requestSignal(res) {
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    return controller.signal;
  }

  async function attributeOptions(signal) {
    try {
      return await directory.attributeNames(signal);
    } catch {
      throw new SettingsError("directory_unavailable", 503);
    }
  }

  // options null means the directory schema could not be read; the stored settings stay visible.
  function view(settings, options) {
    if (!available) return { available: false, reason, poolId: null, status: null, attributes: [], current: null,
      labels: {}, options: [], directoryError: null, version: null };
    const attributes = settings?.attributes ?? [];
    return { available: true, reason: null, poolId, status: sync.status(), attributes,
      current: attributes.at(-1)?.attribute ?? null, labels: settings?.labels ?? {}, options,
      directoryError: options ? null : "directory_unavailable", version: settings?.version ?? null };
  }

  const requireDirectory = (_req, _res, next) =>
    next(available ? undefined : new SettingsError("directory_unavailable", 409));
  const handle = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

  return {
    install(app) {
      const router = express.Router({ strict: true, caseSensitive: true });
      router.use(noStore, authentication.requirePermission("settings:manage"));
      router.get("/", handle(async (_req, res) => {
        if (!available) return res.json(view(null, []));
        const signal = requestSignal(res);
        // A directory outage keeps the stored settings and sync status readable; a store outage does not.
        const [settings, options] = await Promise.all([store.getTeamSettings({ signal }),
          attributeOptions(signal).catch(() => null)]);
        res.json(view(settings, options));
      }));
      router.get("/preview", requireDirectory, handle(async (req, res) => {
        const signal = requestSignal(res);
        const { attribute } = req.query;
        if (typeof attribute !== "string" || !(await attributeOptions(signal)).includes(attribute))
          throw new SettingsError("invalid_attribute", 400);
        let users;
        try { users = await directory.listUsers(signal); } catch { throw new SettingsError("directory_unavailable", 503); }
        // Count only users the sync can attribute; the others keep device teams and are reported apart.
        const { users: attributable, excluded } = attributableUsers(issuer, users);
        const counts = new Map();
        let missing = 0;
        for (const user of attributable) {
          const value = attributeValue(user, attribute);
          if (value === null) missing++;
          else counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        const values = [...counts].map(([value, count]) => ({ value, users: count }))
          .sort((a, b) => b.users - a.users || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
        res.json({ attribute, values, missing, excluded });
      }));
      router.put("/", requireDirectory, express.json({ limit: "16kb" }), handle(async (req, res) => {
        const signal = requestSignal(res);
        const { attribute, labels, version } = req.body ?? {};
        const options = await attributeOptions(signal);
        if (typeof attribute !== "string" || !options.includes(attribute)) throw new SettingsError("invalid_attribute", 400);
        const parsedLabels = parseLabels(labels);
        if (version !== null && !(Number.isSafeInteger(version) && version >= 0))
          throw new SettingsError("invalid_version", 400);
        const settings = await store.getTeamSettings({ signal });
        const expected = settings?.version ?? null;
        if (version !== expected) throw new SettingsError("version_conflict", 409);
        const timeline = settings?.attributes ?? [];
        const at = now();
        // The first attribute applies from epoch; a switch applies only from its save time.
        const attributes = timeline.at(-1)?.attribute === attribute
          ? timeline : [...timeline, { attribute, from: timeline.length ? at : 0 }];
        // Keep every stored field (such as historyStart written by sync); updatedBy is a digest, not the subject.
        const record = { ...settings, attributes, labels: parsedLabels, updatedAt: at,
          updatedBy: userKey(issuer, req.principal.subject) };
        delete record.version;
        if (!await store.putTeamSettings(record, expected, { signal })) throw new SettingsError("version_conflict", 409);
        // The new settings take effect on the next sync; a failed sync is reported through status().
        Promise.resolve().then(() => sync.syncOnce()).catch(() => {});
        res.json(view({ ...record, version: expected === null ? 1 : expected + 1 }, options));
      }));
      router.use((error, _req, res, _next) => {
        if (error?.type === "entity.too.large") return res.status(413).json({ error: "body_too_large" });
        if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
        if (error instanceof SettingsError || error?.code === "store_unavailable")
          return res.status(error.status).json({ error: error.code });
        res.status(500).json({ error: "internal_error" });
      });
      app.use("/api/settings/teams", router);
    },
  };
}
