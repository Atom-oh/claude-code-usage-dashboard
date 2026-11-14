import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes } from "node:crypto";
import { createAuthentication, createSessionCodec, parseAuthConfig } from "./auth.js";
import { DeviceTokenError } from "./deviceTokens.js";
import { createDisplaySettings, deploymentTeamMask } from "./displaySettings.js";

const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Example1";
const origin = "https://dashboard.example.invalid";
const oidcEnv = { AUTH_MODE: "oidc", OIDC_ISSUER: issuer, APP_PUBLIC_URL: origin, INGEST_TOKEN_TABLE: "device_tokens",
  OIDC_CLIENT_ID: "fixture-client", OIDC_CLIENT_SECRET: "test-only-client-secret",
  SESSION_SECRET: randomBytes(32).toString("base64url"), OIDC_ROLE_GROUPS: JSON.stringify({
    viewer: ["dashboard-viewers"], analyst: ["dashboard-analysts"], admin: ["dashboard-admins"],
  }) };

function storeFixture(record = null) {
  return {
    record: structuredClone(record),
    reads: 0,
    writes: 0,
    fail: false,
    async getDisplaySettings() {
      this.reads++;
      if (this.fail) throw new DeviceTokenError("store_unavailable", 503);
      return structuredClone(this.record);
    },
    async putDisplaySettings(next, expectedVersion) {
      if ((this.record?.version ?? null) !== expectedVersion) return false;
      this.writes++;
      this.record = structuredClone({ ...next, version: expectedVersion === null ? 1 : expectedVersion + 1 });
      return true;
    },
  };
}

async function serve(t, { store = storeFixture(), deployment = true, reason = null, clock } = {}) {
  const authentication = createAuthentication({ env: oidcEnv, audit: () => {},
    discoverClient: async () => { throw new Error("discovery is not expected"); } });
  const time = clock ?? { now: 10_000 };
  const display = createDisplaySettings({ authentication, store: reason ? null : store, deployment, issuer, reason,
    now: () => time.now, ttlMs: 1000 });
  const app = express();
  app.use(authentication.middleware);
  display.install(app);
  app.get("/config", async (_req, res) => res.json({ teamMask: await display.teamMask() }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  return { store, time, display, request: (path, init = {}) => fetch(base + path, init) };
}

function session(role) {
  const codec = createSessionCodec(parseAuthConfig(oidcEnv));
  return "__Host-ccdash-session=" + codec.seal({ subject: "admin-subject", role, name: "Fixture",
    exp: Math.floor(Date.now() / 1000) + 600 }, "session");
}

const put = (body, role = "admin") => ({ method: "PUT",
  headers: { cookie: session(role), origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const config = async f => (await (await f.request("/config", { headers: { cookie: session("viewer") } })).json()).teamMask;

test("the deployment default follows TEAM_MASK_ENABLED, else the email masking setting", () => {
  assert.equal(deploymentTeamMask({}, true), true);
  assert.equal(deploymentTeamMask({}, false), false);
  assert.equal(deploymentTeamMask({ TEAM_MASK_ENABLED: "0" }, true), false);
  assert.equal(deploymentTeamMask({ TEAM_MASK_ENABLED: "true" }, false), true);
  assert.equal(deploymentTeamMask({ TEAM_MASK_ENABLED: " FALSE " }, true), false);
  assert.throws(() => deploymentTeamMask({ TEAM_MASK_ENABLED: "yes" }, true), /TEAM_MASK_ENABLED/);
});

test("viewers and analysts can neither read nor change display settings", async t => {
  const f = await serve(t);
  for (const role of ["viewer", "analyst"]) {
    assert.equal((await f.request("/api/settings/display", { headers: { cookie: session(role) } })).status, 403);
    assert.equal((await f.request("/api/settings/display", put({ teamMask: false, version: null }, role))).status, 403);
  }
  assert.equal(f.store.writes, 0);
});

test("an administrator override replaces the deployment default and can be reset", async t => {
  const f = await serve(t);
  assert.equal(await config(f), true);
  let response = await f.request("/api/settings/display", { headers: { cookie: session("admin") } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { available: true, reason: null,
    teamMask: { deployment: true, override: null, effective: true }, version: null });
  response = await f.request("/api/settings/display", put({ teamMask: false, version: null }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).teamMask, { deployment: true, override: false, effective: false });
  assert.equal(await config(f), false, "the saving replica applies it at once");
  assert.equal(f.store.record.updatedAt, 10_000);
  assert.match(f.store.record.updatedBy, /^[a-f0-9]{64}$/, "a digest, never the subject");
  response = await f.request("/api/settings/display", put({ teamMask: null, version: 1 }));
  assert.deepEqual((await response.json()).teamMask, { deployment: true, override: null, effective: true });
  assert.equal(await config(f), true);
});

test("another replica's change is picked up after the cache interval", async t => {
  const store = storeFixture();
  const f = await serve(t, { store });
  assert.equal(await config(f), true);
  store.record = { teamMask: false, version: 1 };  // written by the other replica
  assert.equal(await config(f), true, "cached");
  f.time.now += 1000;
  assert.equal(await config(f), false);
});

test("a store outage keeps the last known value, else the deployment default", async t => {
  const store = storeFixture({ teamMask: false, version: 1 });
  const f = await serve(t, { store });
  assert.equal(await config(f), false);
  store.fail = true;
  f.time.now += 1000;
  assert.equal(await config(f), false, "last known override");
  const fresh = await serve(t, { store: Object.assign(storeFixture(), { fail: true }) });
  assert.equal(await config(fresh), true, "deployment default");
  const response = await f.request("/api/settings/display", { headers: { cookie: session("admin") } });
  assert.equal(response.status, 503);
});

test("invalid values and stale versions are rejected", async t => {
  const f = await serve(t, { store: storeFixture({ teamMask: true, version: 2 }) });
  for (const body of [{ teamMask: "off", version: 2 }, { version: 2 }, { teamMask: false, version: -1 }]) {
    const response = await f.request("/api/settings/display", put(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const response = await f.request("/api/settings/display", put({ teamMask: false, version: 1 }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "version_conflict" });
  assert.equal(f.store.writes, 0);
});

test("without the settings store only the deployment default applies", async t => {
  const f = await serve(t, { deployment: false, reason: "ingest_disabled" });
  assert.equal(await config(f), false);
  const view = await (await f.request("/api/settings/display", { headers: { cookie: session("admin") } })).json();
  assert.deepEqual(view, { available: false, reason: "ingest_disabled",
    teamMask: { deployment: false, override: null, effective: false }, version: null });
  assert.equal((await f.request("/api/settings/display", put({ teamMask: true, version: null }))).status, 409);
});
