import { createHash } from "node:crypto";
import { INTERVAL_LIMIT, appendHistory, attributableUsers, attributeValue, emailKey, flattenIntervals, userKey } from "./teamDirectory.js";
import { encodedParamBytes, setDirectorySnapshot } from "./teamDirectoryParams.js";

const PARAM_BYTE_LIMIT = 900_000;
const STAGE_ERROR = { directory: "directory_unavailable", store: "store_unavailable" };
const EMPTY = { keys: [], teams: [], froms: [], tos: [] };

/** Runs one stage and tags any failure with a short code; AWS message text never leaves this module. */
async function stage(name, work) {
  try {
    return await work();
  } catch {
    throw Object.assign(new Error(STAGE_ERROR[name]), { code: STAGE_ERROR[name] });
  }
}

/**
 * settingsPollMs: how often each replica re-reads the settings record. A version other than the one it
 * last synced (a save on another replica) triggers a sync, so labels and attribute switches propagate
 * without waiting for the hourly directory sync.
 */
export function createTeamSync({ store, directory, issuer, now = Date.now, intervalMs = 3600000,
  settingsPollMs = 60000, intervalLimit = INTERVAL_LIMIT }) {
  let timer = null;
  let pollTimer = null;
  let running = null;
  let followUp = null;
  let syncedVersion;
  let state = { lastSync: null, lastError: null, stale: false, users: 0, historyStart: null, reason: null };

  // `directory` marks a snapshot that resolves directory teams: settings with an attribute and history
  // within the bound. Empty and too-large snapshots keep labels but resolve device teams only.
  const publish = (intervals, settings, version, directoryTeams) => {
    setDirectorySnapshot({ issuer, ...intervals, labels: settings?.labels || {},
      historyStart: settings?.historyStart ?? null, directory: directoryTeams }, version);
    syncedVersion = settings?.version ?? null;
  };

  // readAt is the time of the directory read this observation came from, used as the append time.
  async function writeUserHistory(attribute, user, histories, signal, readAt, firstFrom) {
    const key = emailKey(issuer, user.email);
    const id = userKey(issuer, user.sub);
    const team = attributeValue(user, attribute);
    let current = histories.get(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const entries = current?.entries ?? [];
      if (!entries.length && team === null) return;
      // Stored history already reflects an observation at or after this read (another replica): a stale
      // read must not append a reversal.
      const latest = entries.at(-1);
      if (latest && latest.from >= readAt) return;
      const next = appendHistory(entries, { team, emailKey: key }, readAt, { firstFrom });
      if (!next) return;
      if (await store.putTeamHistory(attribute, { id, entries: next }, current?.version ?? null, { signal })) return;
      current = await store.getTeamHistory(attribute, id, { signal });
    }
  }

  async function run(signal) {
    let settings = await stage("store", () => store.getTeamSettings({ signal }));
    if (!settings?.attributes?.length) {
      // No attribute selected: no labels either (pre-directory behavior).
      publish(EMPTY, null, `empty:${settings?.version ?? 0}`, false);
      syncedVersion = settings?.version ?? null;
      state = { lastSync: now(), lastError: null, stale: false, users: 0, historyStart: null, reason: null };
      return;
    }
    const latest = settings.attributes.at(-1).attribute;
    // A directory outage skips only the append step: stored history is still read and published (stale).
    let users = null;
    let readAt;
    try {
      readAt = now();
      // Users without a usable email and users sharing an email digest fall back to device teams.
      ({ users } = attributableUsers(issuer, await stage("directory", () => directory.listUsers(signal))));
    } catch (error) {
      state = { ...state, stale: true, lastError: error.code };
    }
    if (users) {
      // Epoch only before history began (the first sync); afterwards a user's first entry starts at the read.
      const firstFrom = settings.historyStart == null ? 0 : readAt;
      await stage("store", async () => {
        const existing = new Map((await store.listTeamHistory(latest, { signal })).map((record) => [record.id, record]));
        for (const user of users) await writeUserHistory(latest, user, existing, signal, readAt, firstFrom);
      });
    }
    const histories = {};
    await stage("store", async () => {
      for (const { attribute } of settings.attributes) histories[attribute] = await store.listTeamHistory(attribute, { signal });
    });
    // History begins once the latest attribute has any stored history, whichever run (or replica) wrote it;
    // a write lost to a concurrent save is retried by a later run.
    if (settings.historyStart == null && histories[latest].some((record) => record.entries?.length)) {
      const historyStart = now();
      if (await stage("store", () => store.putTeamSettings({ ...settings, historyStart }, settings.version, { signal }))) {
        settings = { ...settings, historyStart, version: settings.version + 1 };
      }
    }
    let intervals = flattenIntervals({ attributes: settings.attributes, histories, limit: intervalLimit });
    // The interval count does not bound the encoded size (team values can be up to 256 characters).
    if (!intervals.error && encodedParamBytes({ issuer, ...intervals }) > PARAM_BYTE_LIMIT) intervals = { error: "directory_too_large" };
    const base = users
      ? { lastSync: now(), lastError: null, stale: false, users: users.length }
      : { lastSync: state.lastSync, lastError: state.lastError, stale: true, users: state.users };
    if (intervals.error) {
      publish(EMPTY, settings, `too-large:${settings.version}`, false);
      state = { ...base, historyStart: settings.historyStart ?? null, reason: intervals.error };
      return;
    }
    publish(intervals, settings, createHash("sha256").update(JSON.stringify(intervals) + settings.version).digest("hex"), true);
    state = { ...base, historyStart: settings.historyStart ?? null, reason: null };
  }

  function launch(signal) {
    running = run(signal).catch((error) => {
      state = { ...state, stale: true, lastError: error?.code || "sync_failed" };
    }).finally(() => {
      running = null;
      if (!followUp) return;
      const next = followUp;
      followUp = null;
      launch(next.signal).then(next.resolve);
    });
    return running;
  }

  // A call during a run (for example after a settings save) cannot rely on that run, which may have
  // read the old settings: it gets one follow-up run after the current one. Further calls share it,
  // and the first such caller's signal governs it.
  function syncOnce(signal) {
    if (!running) return launch(signal);
    if (!followUp) {
      const { promise, resolve } = Promise.withResolvers();
      followUp = { promise, resolve, signal };
    }
    return followUp.promise;
  }

  async function pollSettings() {
    // A run in flight publishes (and records) its version; the next poll compares again.
    if (running) return;
    try {
      const settings = await store.getTeamSettings();
      if ((settings?.version ?? null) !== syncedVersion) await syncOnce();
    } catch {
      // The next poll or the hourly sync retries; a sync's own failure is reported through status().
    }
  }

  return {
    start() {
      if (timer) return;
      syncOnce();
      timer = setInterval(() => { syncOnce(); }, intervalMs);
      timer.unref();
      pollTimer = setInterval(pollSettings, settingsPollMs);
      pollTimer.unref();
    },
    stop() {
      clearInterval(timer);
      clearInterval(pollTimer);
      timer = null;
      pollTimer = null;
    },
    syncOnce,
    status: () => ({ available: true, ...state }),
  };
}
