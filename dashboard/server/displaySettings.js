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
  ttlMs = 30_000, firstWaitMs = 500 }) {
  const available = !reason && Boolean(store);
  // Each replica caches the stored override; another replica's change applies within ttlMs.
  let cache = { at: -Infinity, override: null, version: null, known: false };
  // A save bumps the generation, so a slower read that started earlier cannot overwrite it.
  let generation = 0;
  let inflight = null;

  const overrideOf = record => (typeof record?.teamMask === "boolean" ? record.teamMask : null);
  const remember = (record, started) => {
    if (generation !== started) return cache;
    cache = { at: now(), override: overrideOf(record), version: record?.version ?? null, known: true };
    return cache;
  };
  async function load(signal) {
    const started = generation;
    return remember(await store.getDisplaySettings({ signal }), started);
  }
  // One background read at a time; an outage keeps the last known value and retries after ttlMs.
  function refresh() {
    if (!inflight) {
      const started = generation;
      inflight = store.getDisplaySettings({})
        .then(record => { remember(record, started); }, () => { cache = { ...cache, at: now() }; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }
  const pause = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); });

  // /api/config gates every page, so it never waits on the store beyond firstWaitMs: an expired
  // cache waits that long for its refresh (so another replica's save shows on the next load), then
  // answers from the cache while the read finishes in the background. Until the first read
  // succeeds the answer is masked, matching the SPA's fail-closed default.
  async function teamMask() {
    if (!available) return deployment;
    if (now() - cache.at >= ttlMs) await Promise.race([refresh(), pause(firstWaitMs)]);
    return cache.known ? cache.override ?? deployment : true;
  }

  const view = state => ({ available, reason: available ? null : reason ?? "ingest_disabled",
    teamMask: { deployment, override: state.override, effective: state.override ?? deployment },
    version: state.version });

  const handle = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

  return {
    teamMask,
    install(app) {
      if (available) refresh();  // warm the cache at startup without delaying it
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
        generation++;
        const saved = { at: now(), override: value, version: current.version === null ? 1 : current.version + 1, known: true };
        // Two saves answered out of order must not leave the older one cached.
        if (!cache.known || (cache.version ?? 0) < saved.version) cache = saved;
        res.json(view(saved));
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
