import { createHash } from "node:crypto";
import { appendHistory, attributableUsers, attributeValue, emailKey, flattenIntervals, userKey } from "./teamDirectory.js";
import { setDirectorySnapshot } from "./teamDirectoryParams.js";

const STAGE_ERROR = { directory: "directory_unavailable", store: "store_unavailable" };

/** Runs one stage and tags any failure with a short code; AWS message text never leaves this module. */
async function stage(name, work) {
  try {
    return await work();
  } catch {
    throw Object.assign(new Error(STAGE_ERROR[name]), { code: STAGE_ERROR[name] });
  }
}

export function createTeamSync({ store, directory, issuer, now = Date.now, intervalMs = 3600000, intervalLimit }) {
  let timer = null;
  let running = null;
  let followUp = null;
  let state = { lastSync: null, lastError: null, stale: false, users: 0, historyStart: null, reason: null };

  const publish = (intervals, settings, version) => setDirectorySnapshot(
    { issuer, ...intervals, labels: settings?.labels || {}, historyStart: settings?.historyStart ?? null }, version);

  async function writeUserHistory(attribute, user, histories, signal) {
    const key = emailKey(issuer, user.email);
    const id = userKey(issuer, user.sub);
    const team = attributeValue(user, attribute);
    let current = histories.get(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const entries = current?.entries ?? [];
      if (!entries.length && team === null) return false;
      const next = appendHistory(entries, { team, emailKey: key }, now());
      if (!next) return false;
      if (await store.putTeamHistory(attribute, { id, entries: next }, current?.version ?? null, { signal })) return true;
      current = (await store.listTeamHistory(attribute, { signal })).find((record) => record.id === id);
    }
    return false;
  }

  async function run(signal) {
    let settings = await stage("store", () => store.getTeamSettings({ signal }));
    if (!settings?.attributes?.length) {
      publish({ keys: [], teams: [], froms: [], tos: [] }, null, "empty");
      state = { lastSync: now(), lastError: null, stale: false, users: 0, historyStart: null, reason: null };
      return;
    }
    const latest = settings.attributes.at(-1).attribute;
    // Users without a usable email and users sharing an email digest fall back to device teams.
    const { users } = attributableUsers(issuer, await stage("directory", () => directory.listUsers(signal)));
    await stage("store", async () => {
      const existing = new Map((await store.listTeamHistory(latest, { signal })).map((record) => [record.id, record]));
      let wrote = false;
      for (const user of users) wrote = (await writeUserHistory(latest, user, existing, signal)) || wrote;
      if (wrote && settings.historyStart == null) {
        const historyStart = now();
        if (await store.putTeamSettings({ ...settings, historyStart }, settings.version, { signal }))
          settings = { ...settings, historyStart, version: settings.version + 1 };
      }
    });
    const histories = {};
    await stage("store", async () => {
      for (const { attribute } of settings.attributes) histories[attribute] = await store.listTeamHistory(attribute, { signal });
    });
    const intervals = flattenIntervals({ attributes: settings.attributes, histories, ...(intervalLimit ? { limit: intervalLimit } : {}) });
    if (intervals.error) {
      publish({ keys: [], teams: [], froms: [], tos: [] }, settings, "too-large");
      state = { lastSync: now(), lastError: null, stale: false, users: users.length,
        historyStart: settings.historyStart ?? null, reason: intervals.error };
      return;
    }
    publish(intervals, settings, createHash("sha256").update(JSON.stringify(intervals) + settings.version).digest("hex"));
    state = { lastSync: now(), lastError: null, stale: false, users: users.length,
      historyStart: settings.historyStart ?? null, reason: null };
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

  return {
    start() {
      if (timer) return;
      syncOnce();
      timer = setInterval(() => { syncOnce(); }, intervalMs);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    syncOnce,
    status: () => ({ available: true, ...state }),
  };
}
