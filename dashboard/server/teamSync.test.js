import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTeamSync } from "./teamSync.js";
import { setDirectorySnapshot, directoryParams, directoryMeta, directoryVersion } from "./teamDirectoryParams.js";
import { emailKey } from "./teamDirectory.js";

const ISSUER = "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_Example1";
const DEPT = "custom:department";
const user = (department, email = "A@x") => ({ sub: "s", email, attributes: department ? { [DEPT]: department } : {} });

function fakeStore(settings, { failFirstPut = false, afterFailedPut } = {}) {
  const histories = new Map();
  const state = { settings, puts: [], settingsPuts: [], failFirstPut };
  return {
    state, histories,
    async getTeamSettings() { return state.settings; },
    async putTeamSettings(record, expected) {
      state.settingsPuts.push({ record, expected });
      state.settings = { ...record, version: expected + 1 };
      return true;
    },
    async listTeamHistory(attribute) {
      return [...histories.entries()].filter(([k]) => k.startsWith(attribute + "|"))
        .map(([k, v]) => ({ id: k.split("|")[1], entries: v.entries, version: v.version }));
    },
    async putTeamHistory(attribute, { id, entries }, expected) {
      state.puts.push({ attribute, id, entries, expected });
      if (state.failFirstPut) {
        state.failFirstPut = false;
        afterFailedPut?.(histories, attribute, id);
        return false;
      }
      histories.set(`${attribute}|${id}`, { entries, version: (expected ?? 0) + 1 });
      return true;
    },
    async getTeamHistory(attribute, id) {
      state.historyGets = (state.historyGets ?? 0) + 1;
      const record = histories.get(`${attribute}|${id}`);
      return record ? { id, entries: record.entries, version: record.version } : null;
    },
  };
}
const directory = (users) => ({ async listUsers() { if (users instanceof Error) throw users; return users; } });
const settings = () => ({ attributes: [{ attribute: DEPT, from: 0 }], labels: { hana: "Hana" }, version: 1 });

beforeEach(() => setDirectorySnapshot(null, "none"));

test("first sync records the department from epoch and publishes intervals", async () => {
  const store = fakeStore(settings());
  const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => 1000 });
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 1);
  assert.deepEqual(store.state.puts[0].entries, [{ team: "hana", from: 0, emailKey: emailKey(ISSUER, "a@x") }]);
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.deepEqual(params.dirTeam, ["hana"]);
  assert.deepEqual(params.dirKey, [emailKey(ISSUER, "a@x")]);
  assert.equal(params.dirIssuer, ISSUER);
  assert.deepEqual(params.dirFrom, ["1970-01-01 00:00:00"]);
  assert.deepEqual(params.dirTo, ["2100-01-01 00:00:00"]);
  assert.deepEqual(directoryMeta(), { labels: { hana: "Hana" }, historyStart: 1000, directory: true });
  assert.equal(store.state.settingsPuts[0].expected, 1);
  assert.equal(store.state.settingsPuts[0].record.historyStart, 1000);
  const status = sync.status();
  assert.deepEqual({ ...status }, { available: true, lastSync: 1000, lastError: null, stale: false, users: 1, historyStart: 1000, reason: null });
  assert.notEqual(directoryVersion(), "none");
});

test("a department change appends from the sync time", async () => {
  const store = fakeStore(settings());
  let clock = 1000;
  let users = [user("hana")];
  const sync = createTeamSync({ store, directory: { listUsers: async () => users }, issuer: ISSUER, now: () => clock });
  await sync.syncOnce();
  const firstVersion = directoryVersion();
  clock = 5000;
  users = [user("cs")];
  await sync.syncOnce();
  const entries = store.state.puts.at(-1).entries;
  assert.deepEqual(entries.at(-1), { team: "cs", from: 5000, emailKey: emailKey(ISSUER, "a@x") });
  assert.equal(entries.length, 2);
  assert.deepEqual(directoryParams("{dirKey:Array(String)}", {}).dirTeam, ["hana", "cs"]);
  assert.notEqual(directoryVersion(), firstVersion);
  assert.equal(store.state.settingsPuts.length, 1, "historyStart is set once");
  assert.equal(sync.status().historyStart, 1000);
});

test("an unchanged department writes nothing and keeps the version", async () => {
  const store = fakeStore(settings());
  const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => 1000 });
  await sync.syncOnce();
  const version = directoryVersion();
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 1);
  assert.equal(directoryVersion(), version);
});

test("concurrent sync appends a change once", async () => {
  const key = emailKey(ISSUER, "a@x");
  const existing = [{ team: "hana", from: 0, emailKey: key }];
  const store = fakeStore(settings(), {
    failFirstPut: true,
    afterFailedPut: (histories, attribute, id) => {
      histories.set(`${attribute}|${id}`, { entries: [...existing, { team: "cs", from: 4000, emailKey: key }], version: 3 });
    },
  });
  const id = (await import("./teamDirectory.js")).userKey(ISSUER, "s");
  store.histories.set(`${DEPT}|${id}`, { entries: existing, version: 2 });
  const sync = createTeamSync({ store, directory: directory([user("cs")]), issuer: ISSUER, now: () => 5000 });
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 1, "no second write after the re-read already holds the change");
  assert.deepEqual(directoryParams("{dirKey:Array(String)}", {}).dirTeam, ["hana", "cs"]);
});

test("a lost write is retried once against the re-read record", async () => {
  const store = fakeStore(settings(), { failFirstPut: true });
  const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => 1000 });
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 2);
  assert.equal(store.state.historyGets, 1, "the re-read fetches the one record, not the partition");
  assert.deepEqual(directoryParams("{dirKey:Array(String)}", {}).dirTeam, ["hana"]);
});

test("first sync failure keeps device teams and reports stale", async () => {
  const store = fakeStore(settings());
  const sync = createTeamSync({ store, directory: directory(new Error("AccessDenied: arn:aws:secret")), issuer: ISSUER });
  await sync.syncOnce();
  const status = sync.status();
  assert.equal(status.stale, true);
  assert.equal(status.lastError, "directory_unavailable");
  assert.equal(status.lastSync, null);
  // Nothing is stored yet, so the published snapshot holds no intervals: every session keeps its device team.
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.deepEqual(params.dirKey, []);
});

test("a later failure keeps the previous snapshot", async () => {
  const store = fakeStore(settings());
  let fail = false;
  const sync = createTeamSync({ store, directory: { listUsers: async () => { if (fail) throw new Error("x"); return [user("hana")]; } }, issuer: ISSUER, now: () => 1000 });
  await sync.syncOnce();
  fail = true;
  await sync.syncOnce();
  assert.deepEqual(directoryParams("{dirKey:Array(String)}", {}).dirTeam, ["hana"]);
  assert.deepEqual({ stale: sync.status().stale, lastError: sync.status().lastError, lastSync: sync.status().lastSync },
    { stale: true, lastError: "directory_unavailable", lastSync: 1000 });
});

test("a store failure reports store_unavailable", async () => {
  const store = fakeStore(settings());
  store.getTeamSettings = async () => { throw new Error("boom"); };
  const sync = createTeamSync({ store, directory: directory([]), issuer: ISSUER });
  await sync.syncOnce();
  assert.equal(sync.status().lastError, "store_unavailable");
});

test("missing settings publish an empty snapshot", async () => {
  const store = fakeStore(null);
  const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => 7 });
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 0);
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.deepEqual(params.dirKey, []);
  assert.equal(params.dirIssuer, ISSUER);
  assert.equal(sync.status().stale, false);
  assert.equal(sync.status().lastSync, 7);
  assert.equal(directoryMeta().directory, false);
});

test("users without a usable email are skipped", async () => {
  const store = fakeStore(settings());
  const users = [{ sub: "a", attributes: { [DEPT]: "hana" } }, user("hana", "\u00e9mile@x"), user("hana", "no-at")];
  const sync = createTeamSync({ store, directory: directory(users), issuer: ISSUER });
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 0);
  assert.equal(sync.status().users, 0);
});

test("a directory above the interval limit publishes empty with a reason", async () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ sub: `s${i}`, email: `u${i}@x`, attributes: { [DEPT]: "hana" } }));
  const store = fakeStore(settings());
  const sync = createTeamSync({ store, directory: directory(many), issuer: ISSUER, now: () => 10, intervalLimit: 2 });
  await sync.syncOnce();
  const status = sync.status();
  assert.equal(status.reason, "directory_too_large");
  assert.equal(status.stale, false);
  assert.deepEqual(directoryParams("{dirKey:Array(String)}", {}).dirKey, []);
  assert.equal(directoryMeta().directory, false, "a disabled directory renders teams as before");
});

test("calls during a run coalesce into one follow-up that reads the newer settings", async () => {
  // historyStart is already set, so the first run does not rewrite the settings record.
  const store = fakeStore({ ...settings(), historyStart: 500 });
  const reads = [];
  const get = store.getTeamSettings.bind(store);
  store.getTeamSettings = async () => { const value = await get(); reads.push(value); return value; };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let listed = 0;
  const users = { async listUsers() { listed++; if (listed === 1) await gate; return [user("hana")]; } };
  const sync = createTeamSync({ store, directory: users, issuer: ISSUER, now: () => 1000 });
  const first = sync.syncOnce();
  await new Promise((resolve) => setImmediate(resolve));
  // A save lands while the first run is in flight (it already read the old settings).
  store.state.settings = { ...store.state.settings, attributes: [...store.state.settings.attributes,
    { attribute: "name", from: 900 }], version: 2 };
  const second = sync.syncOnce();
  const third = sync.syncOnce();
  assert.equal(second, third, "further calls share one follow-up");
  assert.notEqual(second, first);
  release();
  await first;
  await second;
  assert.equal(reads.length, 2, "exactly two runs");
  assert.deepEqual(reads[1].attributes.map((a) => a.attribute), [DEPT, "name"]);
  assert.equal(listed, 2);
  await sync.syncOnce();
  assert.equal(reads.length, 3, "an idle call starts a fresh run");
});

test("start runs immediately, never throws, and stop clears the timer", async () => {
  const store = fakeStore(settings());
  const sync = createTeamSync({ store, directory: directory(new Error("x")), issuer: ISSUER, intervalMs: 50 });
  sync.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sync.status().lastError, "directory_unavailable");
  sync.stop();
});

test("directoryParams leaves unrelated SQL untouched", () => {
  assert.deepEqual(directoryParams("SELECT 1", { a: 1 }), { a: 1 });
});

test("users sharing an email digest are skipped, unique users are written", async () => {
  const store = fakeStore(settings());
  const users = [{ sub: "d1", email: "A@x", attributes: { [DEPT]: "hana" } },
    { sub: "d2", email: "a@x", attributes: { [DEPT]: "cs" } },
    { sub: "u", email: "b@x", attributes: { [DEPT]: "dev" } }];
  const sync = createTeamSync({ store, directory: directory(users), issuer: ISSUER, now: () => 1000 });
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 1);
  assert.deepEqual(store.state.puts[0].entries.map((e) => e.team), ["dev"]);
  assert.equal(sync.status().users, 1);
});

test("historyStart waits until the latest attribute has stored history", async () => {
  const store = fakeStore(settings());
  let users = [];
  let clock = 1000;
  const sync = createTeamSync({ store, directory: { listUsers: async () => users }, issuer: ISSUER, now: () => clock });
  await sync.syncOnce();
  assert.equal(store.state.settingsPuts.length, 0);
  assert.equal(sync.status().historyStart, null);
  clock = 2000;
  users = [user("hana")];
  await sync.syncOnce();
  assert.equal(store.state.settingsPuts.length, 1);
  assert.equal(sync.status().historyStart, 2000);
});

test("settings without attributes behave like no settings", async () => {
  for (const record of [{ labels: {}, version: 1 }, { attributes: [], labels: {}, version: 1 }]) {
    setDirectorySnapshot(null, "none");
    const store = fakeStore(record);
    const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => 9 });
    await sync.syncOnce();
    assert.equal(sync.status().stale, false);
    assert.equal(sync.status().lastError, null);
    assert.equal(store.state.puts.length, 0);
    assert.equal(directoryParams("{dirKey:Array(String)}", {}).dirIssuer, ISSUER);
  }
});

test("a directory failure on a fresh sync still publishes stored history and reports stale", async () => {
  const store = fakeStore({ ...settings(), historyStart: 500 });
  const id = (await import("./teamDirectory.js")).userKey(ISSUER, "s");
  store.histories.set(`${DEPT}|${id}`, { entries: [{ team: "hana", from: 0, emailKey: emailKey(ISSUER, "a@x") }], version: 1 });
  const sync = createTeamSync({ store, directory: directory(new Error("throttled")), issuer: ISSUER, now: () => 1000 });
  await sync.syncOnce();
  assert.deepEqual(directoryParams("{dirKey:Array(String)}", {}).dirTeam, ["hana"]);
  assert.deepEqual(directoryMeta(), { labels: { hana: "Hana" }, historyStart: 500, directory: true });
  const status = sync.status();
  assert.equal(status.stale, true);
  assert.equal(status.lastError, "directory_unavailable");
  assert.equal(status.historyStart, 500);
  assert.equal(store.state.puts.length, 0, "nothing is appended without a directory read");
});

test("a settings version change seen by the poll triggers a sync; the same version does not", async () => {
  const store = fakeStore({ ...settings(), historyStart: 500 });
  let reads = 0;
  const get = store.getTeamSettings.bind(store);
  store.getTeamSettings = async () => { reads++; return get(); };
  let listed = 0;
  const sync = createTeamSync({ store, directory: { async listUsers() { listed++; return [user("hana")]; } },
    issuer: ISSUER, now: () => 1000, intervalMs: 3600000, settingsPollMs: 10 });
  sync.start();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(60);
  assert.equal(listed, 1, "unchanged version: only the startup sync ran");
  assert.ok(reads > 1, "the poll read the settings");
  // Another replica saves new settings.
  store.state.settings = { ...store.state.settings, labels: { hana: "하나" }, version: 2 };
  await wait(60);
  sync.stop();
  assert.equal(listed, 2, "one sync for the new version");
  assert.deepEqual(directoryMeta().labels, { hana: "하나" });
  const after = reads;
  await wait(40);
  assert.equal(reads, after, "stop clears the poll");
});

test("historyStart is still set after losing the settings write to a concurrent save", async () => {
  const store = fakeStore(settings());
  // The first settings write loses to an admin save that bumped the version in between.
  store.putTeamSettings = async (record, expected) => {
    store.state.settingsPuts.push({ record, expected });
    if (store.state.settingsPuts.length === 1) {
      store.state.settings = { ...store.state.settings, labels: { hana: "Hana 2" }, version: 2 };
      return false;
    }
    if (expected !== store.state.settings.version) return false;
    store.state.settings = { ...record, version: expected + 1 };
    return true;
  };
  let clock = 1000;
  const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => clock });
  await sync.syncOnce();
  assert.equal(store.state.settings.historyStart, undefined);
  clock = 2000;
  await sync.syncOnce();
  assert.equal(store.state.puts.length, 1, "the second sync writes no history");
  assert.equal(store.state.settings.historyStart, 2000);
  assert.deepEqual(store.state.settings.labels, { hana: "Hana 2" }, "the save is preserved");
  assert.equal(sync.status().historyStart, 2000);
});

test("empty and too-large snapshot versions follow the settings version", async () => {
  for (const [record, options] of [
    [(version) => ({ attributes: [], labels: { a: String(version) }, version }), {}],
    [(version) => ({ ...settings(), historyStart: 5, version }), { intervalLimit: 0 }],
  ]) {
    const store = fakeStore(record(1));
    const sync = createTeamSync({ store, directory: directory([user("hana")]), issuer: ISSUER, now: () => 9, ...options });
    await sync.syncOnce();
    const first = directoryVersion();
    store.state.settings = record(2);
    await sync.syncOnce();
    assert.notEqual(directoryVersion(), first);
  }
});
