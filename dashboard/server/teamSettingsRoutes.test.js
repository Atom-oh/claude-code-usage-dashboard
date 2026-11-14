import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes } from "node:crypto";
import { createAuthentication, createSessionCodec, parseAuthConfig } from "./auth.js";
import { DeviceTokenError } from "./deviceTokens.js";
import { userKey } from "./teamDirectory.js";
import { createTeamSettings, teamDirectoryConfig } from "./teamSettingsRoutes.js";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Example1";
const origin = "https://dashboard.example.invalid";
const oidcEnv = { AUTH_MODE: "oidc", OIDC_ISSUER: issuer, APP_PUBLIC_URL: origin, INGEST_TOKEN_TABLE: "device_tokens",
  OIDC_CLIENT_ID: "fixture-client", OIDC_CLIENT_SECRET: "test-only-client-secret",
  SESSION_SECRET: randomBytes(32).toString("base64url"), OIDC_ROLE_GROUPS: JSON.stringify({
    viewer: ["dashboard-viewers"], analyst: ["dashboard-analysts"], admin: ["dashboard-admins"],
  }) };
const OPTIONS = ["custom:department", "name", "email_domain"];
const USERS = [
  { sub: "sub-1", email: "one@example.com", attributes: { "custom:department": "Platform", name: "One" } },
  { sub: "sub-2", email: "two@example.com", attributes: { "custom:department": "Platform", name: "Two" } },
  { sub: "sub-3", email: "three@example.org", attributes: { "custom:department": "Data", name: "Three" } },
  { sub: "sub-4", email: "four@example.org", attributes: { "custom:department": "Billing", name: "Four" } },
  { sub: "sub-5", email: "five@example.org", attributes: { "custom:department": "  ", name: "Five" } },
  { sub: "sub-6", email: "six@example.org", attributes: { name: "Six" } },
  // Excluded like the sync does: a shared email digest (case-insensitive), no email, non-ASCII email, no sub.
  { sub: "sub-7", email: "Shared@example.net", attributes: { "custom:department": "Platform" } },
  { sub: "sub-8", email: "shared@example.net", attributes: { "custom:department": "Platform" } },
  { sub: "sub-9", attributes: { "custom:department": "Platform" } },
  { sub: "sub-10", email: "\u00e9mile@example.net", attributes: { "custom:department": "Platform" } },
  { email: "nosub@example.net", attributes: { "custom:department": "Platform" } },
];
const STATUS = { available: true, lastSync: 5000, lastError: null, stale: false, users: 6, historyStart: 4000, reason: null };

function storeFixture(settings = null) {
  return {
    settings: structuredClone(settings),
    writes: 0,
    async getTeamSettings() { return structuredClone(this.settings); },
    async putTeamSettings(record, expectedVersion) {
      if ((this.settings?.version ?? null) !== expectedVersion) return false;
      this.writes++;
      this.settings = structuredClone({ ...record, version: expectedVersion === null ? 1 : expectedVersion + 1 });
      return true;
    },
  };
}

const directoryFixture = () => ({
  async attributeNames() { return [...OPTIONS]; },
  async listUsers() { return structuredClone(USERS); },
});

function syncFixture(failure) {
  return {
    calls: 0,
    syncOnce() { this.calls++; return failure ? Promise.reject(failure) : Promise.resolve(); },
    status: () => ({ ...STATUS }),
  };
}

async function serve(t, { env = oidcEnv, store = storeFixture(), directory = directoryFixture(), sync = syncFixture(),
  now = () => 7000, reason, poolId = "us-east-1_Example1" } = {}) {
  const authentication = createAuthentication({ env, audit: () => {},
    discoverClient: async () => { throw new Error("discovery is not expected"); } });
  const config = teamDirectoryConfig({ mode: authentication.mode, env });
  const app = express();
  app.use(authentication.middleware);
  createTeamSettings({ authentication, store, directory, sync, now,
    issuer: config.issuer ?? null, poolId: reason ? null : poolId, reason: reason ?? config.reason }).install(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  return { store, sync, request: (path, init = {}) => fetch(base + path, init) };
}

function session(role, subject = "admin-subject") {
  const codec = createSessionCodec(parseAuthConfig(oidcEnv));
  const token = codec.seal({ subject, role, name: "Fixture", exp: Math.floor(Date.now() / 1000) + 600 }, "session");
  return "__Host-ccdash-session=" + token;
}

const put = (body, headers = {}) => ({ method: "PUT",
  headers: { cookie: session("admin"), origin, "content-type": "application/json", ...headers },
  body: JSON.stringify(body) });

test("viewers and analysts cannot read team settings", async t => {
  const f = await serve(t);
  for (const role of ["viewer", "analyst"]) {
    for (const path of ["/api/settings/teams", "/api/settings/teams/preview?attribute=name"]) {
      const response = await f.request(path, { headers: { cookie: session(role) } });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "permission_denied" });
    }
    const response = await f.request("/api/settings/teams", put({ attribute: "name", labels: {}, version: null },
      { cookie: session(role) }));
    assert.equal(response.status, 403);
  }
  assert.equal(f.store.writes, 0);
});

test("admins can read team settings", async t => {
  const settings = { attributes: [{ attribute: "custom:department", from: 0 }], labels: { Platform: "플랫폼" },
    historyStart: 4000, updatedAt: 6000, updatedBy: "f".repeat(64), version: 2 };
  const f = await serve(t, { store: storeFixture(settings) });
  const response = await f.request("/api/settings/teams", { headers: { cookie: session("admin") } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { available: true, reason: null, poolId: "us-east-1_Example1",
    status: STATUS, attributes: [{ attribute: "custom:department", from: 0 }], current: "custom:department",
    labels: { Platform: "플랫폼" }, options: OPTIONS, directoryError: null, version: 2 });
});

test("an empty store reads as no attribute yet", async t => {
  const f = await serve(t);
  const body = await (await f.request("/api/settings/teams", { headers: { cookie: session("admin") } })).json();
  assert.equal(body.available, true);
  assert.deepEqual([body.attributes, body.current, body.labels, body.version], [[], null, {}, null]);
});

test("Basic mode reads but cannot save", async t => {
  const env = { AUTH_MODE: "basic", BASIC_AUTH_USER: "fixture-user", BASIC_AUTH_PASSWORD: "fixture-password" };
  const f = await serve(t, { env, store: null, directory: null, sync: null });
  const authorization = "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64");
  const read = await f.request("/api/settings/teams", { headers: { authorization } });
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { available: false, reason: "basic_auth", poolId: null, status: null,
    attributes: [], current: null, labels: {}, options: [], directoryError: null, version: null });
  const save = await f.request("/api/settings/teams", { method: "PUT",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ attribute: "name", labels: {}, version: null }) });
  assert.equal(save.status, 409);
  assert.deepEqual(await save.json(), { error: "directory_unavailable" });
  const preview = await f.request("/api/settings/teams/preview?attribute=name", { headers: { authorization } });
  assert.equal(preview.status, 409);
});

test("OIDC without a Cognito directory reads its reason but cannot save", async t => {
  const f = await serve(t, { store: null, directory: null, sync: null, reason: "ingest_disabled" });
  const read = await (await f.request("/api/settings/teams", { headers: { cookie: session("admin") } })).json();
  assert.deepEqual([read.available, read.reason, read.poolId], [false, "ingest_disabled", null]);
  const save = await f.request("/api/settings/teams", put({ attribute: "name", labels: {}, version: null }));
  assert.equal(save.status, 409);
  assert.deepEqual(await save.json(), { error: "directory_unavailable" });
});

test("saving a new attribute appends it from the save time", async t => {
  const settings = { attributes: [{ attribute: "custom:department", from: 0 }], labels: { Platform: "플랫폼" },
    historyStart: 4000, updatedAt: 6000, updatedBy: "f".repeat(64), version: 3 };
  const f = await serve(t, { store: storeFixture(settings), now: () => 7000 });
  const response = await f.request("/api/settings/teams",
    put({ attribute: "email_domain", labels: { "example.com": "  예시  " }, version: 3 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(f.store.settings, {
    attributes: [{ attribute: "custom:department", from: 0 }, { attribute: "email_domain", from: 7000 }],
    labels: { "example.com": "예시" }, historyStart: 4000, updatedAt: 7000,
    updatedBy: userKey(issuer, "admin-subject"), version: 4 });
  assert.ok(!JSON.stringify(f.store.settings).includes("admin-subject"));
  assert.deepEqual(body, { available: true, reason: null, poolId: "us-east-1_Example1", status: STATUS,
    attributes: f.store.settings.attributes, current: "email_domain", labels: { "example.com": "예시" },
    options: OPTIONS, directoryError: null, version: 4 });
  assert.equal(f.sync.calls, 1);
});

test("the first saved attribute starts at epoch", async t => {
  const f = await serve(t, { now: () => 7000 });
  const response = await f.request("/api/settings/teams", put({ attribute: "custom:department", labels: {}, version: null }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.store.settings.attributes, [{ attribute: "custom:department", from: 0 }]);
  assert.equal(f.store.settings.version, 1);
});

test("label-only save keeps the attribute timeline", async t => {
  const attributes = [{ attribute: "name", from: 0 }, { attribute: "custom:department", from: 5000 }];
  const f = await serve(t, { store: storeFixture({ attributes, labels: {}, historyStart: 4000, version: 5 }) });
  const response = await f.request("/api/settings/teams",
    put({ attribute: "custom:department", labels: { Platform: "플랫폼", Data: "데이터" }, version: 5 }));
  assert.equal(response.status, 200);
  assert.deepEqual(f.store.settings.attributes, attributes);
  assert.deepEqual(f.store.settings.labels, { Platform: "플랫폼", Data: "데이터" });
  assert.equal(f.store.settings.historyStart, 4000);
  assert.equal(f.store.settings.version, 6);
});

test("switching back to an earlier attribute appends a new window", async t => {
  const attributes = [{ attribute: "name", from: 0 }, { attribute: "custom:department", from: 5000 }];
  const f = await serve(t, { store: storeFixture({ attributes, labels: {}, version: 2 }), now: () => 9000 });
  assert.equal((await f.request("/api/settings/teams", put({ attribute: "name", labels: {}, version: 2 }))).status, 200);
  assert.deepEqual(f.store.settings.attributes, [...attributes, { attribute: "name", from: 9000 }]);
});

test("duplicate labels and unknown attributes are rejected", async t => {
  const settings = { attributes: [{ attribute: "custom:department", from: 0 }], labels: {}, version: 1 };
  const f = await serve(t, { store: storeFixture(settings) });
  const cases = [
    [{ attribute: "custom:department", labels: { Platform: "팀", Data: " 팀 " }, version: 1 }, "duplicate_label"],
    [{ attribute: "email", labels: {}, version: 1 }, "invalid_attribute"],
    [{ attribute: ["name"], labels: {}, version: 1 }, "invalid_attribute"],
    [{ labels: {}, version: 1 }, "invalid_attribute"],
    [{ attribute: "name", labels: { Platform: "   " }, version: 1 }, "invalid_labels"],
    [{ attribute: "name", labels: { Platform: "가".repeat(81) }, version: 1 }, "invalid_labels"],
    [{ attribute: "name", labels: { ["k".repeat(257)]: "Label" }, version: 1 }, "invalid_labels"],
    [{ attribute: "name", labels: { "": "Label" }, version: 1 }, "invalid_labels"],
    [{ attribute: "name", labels: { Platform: 3 }, version: 1 }, "invalid_labels"],
    [{ attribute: "name", labels: ["Label"], version: 1 }, "invalid_labels"],
    [{ attribute: "name", labels: {}, version: "1" }, "invalid_version"],
    [{ attribute: "name", labels: {}, version: -1 }, "invalid_version"],
  ];
  for (const [body, error] of cases) {
    const response = await f.request("/api/settings/teams", put(body));
    assert.equal(response.status, 400, error);
    assert.deepEqual(await response.json(), { error });
  }
  const ok = await f.request("/api/settings/teams",
    put({ attribute: "name", labels: { Platform: "가".repeat(80), ["k".repeat(256)]: "Label" }, version: 1 }));
  assert.equal(ok.status, 200);
  assert.equal(f.store.writes, 1);
});

test("a stale version is a conflict and leaves the settings unchanged", async t => {
  const settings = { attributes: [{ attribute: "name", from: 0 }], labels: {}, historyStart: 4000, version: 4 };
  const f = await serve(t, { store: storeFixture(settings) });
  for (const version of [3, null]) {
    const response = await f.request("/api/settings/teams", put({ attribute: "email_domain", labels: {}, version }));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "version_conflict" });
  }
  // A lost condition (a concurrent sync wrote historyStart) is the same conflict.
  f.store.putTeamSettings = async () => false;
  const lost = await f.request("/api/settings/teams", put({ attribute: "email_domain", labels: {}, version: 4 }));
  assert.equal(lost.status, 409);
  assert.deepEqual(await lost.json(), { error: "version_conflict" });
  assert.deepEqual(f.store.settings, settings);
  assert.equal(f.sync.calls, 0);
});

test("a failing sync does not fail the save", async t => {
  const f = await serve(t, { sync: syncFixture(new Error("directory_unavailable")) });
  const response = await f.request("/api/settings/teams", put({ attribute: "name", labels: {}, version: null }));
  assert.equal(response.status, 200);
  assert.equal(f.sync.calls, 1);
});

test("an oversized or malformed body is refused", async t => {
  const f = await serve(t);
  const labels = Object.fromEntries(Array.from({ length: 400 }, (_, i) => ["team-" + i, "Label " + i + " ".repeat(30)]));
  const large = await f.request("/api/settings/teams", put({ attribute: "name", labels, version: null }));
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { error: "body_too_large" });
  const malformed = await f.request("/api/settings/teams", { ...put({}), body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_json" });
  assert.equal(f.store.writes, 0);
});

test("preview groups users without saving", async t => {
  const f = await serve(t);
  const response = await f.request("/api/settings/teams/preview?attribute=custom%3Adepartment",
    { headers: { cookie: session("admin") } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { attribute: "custom:department",
    values: [{ value: "Platform", users: 2 }, { value: "Billing", users: 1 }, { value: "Data", users: 1 }],
    missing: 2, excluded: 5 });
  const domains = await (await f.request("/api/settings/teams/preview?attribute=email_domain",
    { headers: { cookie: session("admin") } })).json();
  assert.deepEqual(domains.values, [{ value: "example.org", users: 4 }, { value: "example.com", users: 2 }]);
  assert.deepEqual([domains.missing, domains.excluded], [0, 5]);
  for (const query of ["?attribute=email", "?attribute=name&attribute=email_domain", ""]) {
    const invalid = await f.request("/api/settings/teams/preview" + query, { headers: { cookie: session("admin") } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_attribute" });
  }
  assert.equal(f.store.writes, 0);
  assert.equal(f.sync.calls, 0);
});

test("PUT without the configured Origin is refused", async t => {
  const f = await serve(t);
  const body = { attribute: "name", labels: {}, version: null };
  for (const headers of [{ origin: "" }, { origin: "https://untrusted.example.invalid" }]) {
    const init = put(body, headers);
    if (!headers.origin) delete init.headers.origin;
    const response = await f.request("/api/settings/teams", init);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
  }
  assert.equal(f.store.writes, 0);
});

test("a store failure makes settings unavailable, not empty", async t => {
  const store = storeFixture();
  store.getTeamSettings = async () => { throw new DeviceTokenError("store_unavailable", 503); };
  const f = await serve(t, { store });
  const read = await f.request("/api/settings/teams", { headers: { cookie: session("admin") } });
  assert.equal(read.status, 503);
  assert.deepEqual(await read.json(), { error: "store_unavailable" });
});

test("a directory outage keeps stored settings and status readable", async t => {
  const settings = { attributes: [{ attribute: "custom:department", from: 0 }], labels: { Platform: "플랫폼" },
    historyStart: 4000, version: 2 };
  const directory = { attributeNames: async () => { throw new Error("AWS detail must not leak"); },
    listUsers: async () => { throw new Error("AWS detail must not leak"); } };
  const sync = syncFixture();
  sync.status = () => ({ ...STATUS, stale: true, lastError: "directory_unavailable" });
  const f = await serve(t, { store: storeFixture(settings), directory, sync });
  const read = await f.request("/api/settings/teams", { headers: { cookie: session("admin") } });
  assert.equal(read.status, 200);
  const text = await read.text();
  assert.ok(!text.includes("AWS detail"));
  assert.deepEqual(JSON.parse(text), { available: true, reason: null, poolId: "us-east-1_Example1",
    status: { ...STATUS, stale: true, lastError: "directory_unavailable" },
    attributes: [{ attribute: "custom:department", from: 0 }], current: "custom:department",
    labels: { Platform: "플랫폼" }, options: null, directoryError: "directory_unavailable", version: 2 });
  // Preview and save need the directory, so they fail with the code only.
  for (const init of [{ headers: { cookie: session("admin") } },
    put({ attribute: "custom:department", labels: {}, version: 2 })]) {
    const path = init.method === "PUT" ? "/api/settings/teams" : "/api/settings/teams/preview?attribute=name";
    const response = await f.request(path, init);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "directory_unavailable" });
  }
  assert.equal(f.store.writes, 0);
});

test("team directory configuration reports the first missing condition", () => {
  const table = { INGEST_TOKEN_TABLE: "device_tokens" };
  assert.deepEqual(teamDirectoryConfig({ mode: "basic", env: { OIDC_ISSUER: issuer, ...table } }), { reason: "basic_auth" });
  assert.deepEqual(teamDirectoryConfig({ mode: "oidc", env: { OIDC_ISSUER: "https://identity.example.invalid/", ...table } }),
    { reason: "not_cognito" });
  assert.deepEqual(teamDirectoryConfig({ mode: "oidc", env: { OIDC_ISSUER: issuer } }), { reason: "ingest_disabled" });
  assert.deepEqual(teamDirectoryConfig({ mode: "oidc", env: { OIDC_ISSUER: issuer, INGEST_TOKEN_TABLE: "a b" } }),
    { reason: "ingest_disabled" });
  assert.deepEqual(teamDirectoryConfig({ mode: "oidc", env: { OIDC_ISSUER: issuer, ...table } }),
    { reason: null, issuer, region: "us-east-1", poolId: "us-east-1_Example1", tableName: "device_tokens" });
});
