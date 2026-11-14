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
  assert.deepEqual(directoryMeta(), { labels: { hana: "Hana" }, historyStart: 1000 });
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
  const params = directoryParams("{dirKey:Array(String)}", {});
  assert.deepEqual(params.dirKey, []);
  assert.equal(params.dirIssuer, "");
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

test("historyStart is set only by a sync that wrote history", async () => {
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
