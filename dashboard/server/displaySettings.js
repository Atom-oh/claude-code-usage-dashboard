import express from "express";
import { userKey } from "./teamDirectory.js";

// Team-name display masking. The deployment chooses the default (TEAM_MASK_ENABLED, else the
// email masking setting); an administrator may override it on the settings page when the
// settings store exists. Like email masking this is presentation only: API payloads keep raw
// team values (ADR-006).
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

class DisplayError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function deploymentTeamMask(env, piiMask) {
  const raw = String(env.TEAM_MASK_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") return piiMask;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error("TEAM_MASK_ENABLED must be 1, true, 0 or false");
}

export function createDisplaySettings({ authentication, store, deployment, issuer, reason, now = Date.now,
  ttlMs = 30_000 }) {
  const available = !reason && Boolean(store);
  // Each replica caches the stored override; another replica's change applies within ttlMs.
  let cache = { at: -Infinity, override: null, version: null, known: false };

  const overrideOf = record => (typeof record?.teamMask === "boolean" ? record.teamMask : null);
  async function load(signal) {
    const record = await store.getDisplaySettings({ signal });
    cache = { at: now(), override: overrideOf(record), version: record?.version ?? null, known: true };
    return cache;
  }

  async function teamMask() {
    if (!available) return deployment;
    if (now() - cache.at >= ttlMs) {
      // An outage keeps the last known value (else the deployment default) and retries after ttlMs.
      try { await load(); } catch { cache = { ...cache, at: now() }; }
    }
    return cache.override ?? deployment;
  }

  const view = state => ({ available, reason: available ? null : reason ?? "ingest_disabled",
    teamMask: { deployment, override: state.override, effective: state.override ?? deployment },
    version: state.version });

  const handle = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

  return {
    teamMask,
    install(app) {
      const router = express.Router({ strict: true, caseSensitive: true });
      router.use(noStore, authentication.requirePermission("settings:manage"));
      router.get("/", handle(async (_req, res) => {
        if (!available) return res.json(view({ override: null, version: null }));
        res.json(view(await load()));
      }));
      router.put("/", express.json({ limit: "4kb" }), handle(async (req, res) => {
        if (!available) throw new DisplayError("settings_unavailable", 409);
        const { teamMask: value, version } = req.body ?? {};
        if (!(value === true || value === false || value === null) || !Object.hasOwn(req.body ?? {}, "teamMask"))
          throw new DisplayError("invalid_team_mask", 400);
        if (version !== null && !(Number.isSafeInteger(version) && version >= 0))
          throw new DisplayError("invalid_version", 400);
        const current = await load();
        if (version !== current.version) throw new DisplayError("version_conflict", 409);
        const record = { teamMask: value, updatedAt: now(), updatedBy: userKey(issuer, req.principal.subject) };
        if (!await store.putDisplaySettings(record, current.version)) throw new DisplayError("version_conflict", 409);
        cache = { at: now(), override: value, version: current.version === null ? 1 : current.version + 1, known: true };
        res.json(view(cache));
      }));
      router.use((error, _req, res, _next) => {
        if (error?.type === "entity.too.large") return res.status(413).json({ error: "body_too_large" });
        if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
        if (error instanceof DisplayError || error?.code === "store_unavailable")
          return res.status(error.status).json({ error: error.code });
        res.status(500).json({ error: "internal_error" });
      });
      app.use("/api/settings/display", router);
    },
  };
}
