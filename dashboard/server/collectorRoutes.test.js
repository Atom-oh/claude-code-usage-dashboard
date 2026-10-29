import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createCollectorFeature } from "./collectorRoutes.js";

const origin = "https://dashboard.example.invalid";
const issuer = "https://identity.example.invalid/";

function storeFixture() {
  const records = new Map();
  return {
    records,
    async put(record) { records.set(`${record.owner}:${record.id}`, structuredClone(record)); },
    async get(owner, id) { return structuredClone(records.get(`${owner}:${id}`)); },
    async list(owner) { return { items: [...records.values()].filter(r => r.owner === owner) }; },
    async revoke(owner, id, at) {
      const record = records.get(`${owner}:${id}`);
      if (!record) return false;
      record.revokedAt ??= at;
      return true;
    },
    async touch(owner, id, at) {
      const record = records.get(`${owner}:${id}`);
      if (!record || record.revokedAt !== undefined || record.expiresAt <= at) return false;
      record.lastSeenAt = at;
      return true;
    },
    async stage(owner, id, current, pending) {
      const record = records.get(`${owner}:${id}`);
      if (!record || record.secretHash !== current || record.revokedAt !== undefined
        || record.expiresAt <= pending.issuedAt) return false;
      Object.assign(record, { pendingHash: pending.hash, pendingIssuedAt: pending.issuedAt,
        pendingExpiresAt: pending.expiresAt, purgeAt: pending.purgeAt });
      return true;
    },
    async promote(owner, id, pending, at) {
      const record = records.get(`${owner}:${id}`);
      if (!record || record.pendingHash !== pending.hash || record.pendingExpiresAt !== pending.expiresAt
        || pending.expiresAt <= at || record.revokedAt !== undefined) return false;
      Object.assign(record, { secretHash: pending.hash, expiresAt: pending.expiresAt, purgeAt: pending.purgeAt,
        renewedAt: at });
      delete record.pendingHash;
      delete record.pendingIssuedAt;
      delete record.pendingExpiresAt;
      return true;
    },
  };
}

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "collector-routes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "upstream-token"), "i".repeat(64));
  writeFileSync(join(directory, "ccdash-collector-linux.tar.gz"), "archive-fixture");
  const authentication = {
    mode: "oidc",
    requirePermission(permission) {
      assert.equal(permission, "collector:manage");
      return (req, res, next) => ["analyst", "admin"].includes(req.principal?.role)
        ? next() : res.status(403).json({ error: "permission_denied" });
    },
  };
  const store = overrides.store || storeFixture();
  const deliveries = [];
  const env = { INGEST_ENABLED: "1", INGEST_TOKEN_TABLE: "devices",
    INGEST_UPSTREAM_URL: "http://collector.internal:4318",
    INGEST_UPSTREAM_TOKEN_FILE: join(directory, "upstream-token"),
    APP_PUBLIC_URL: origin, OIDC_ISSUER: issuer, ...overrides.env };
  const feature = createCollectorFeature({ env, authentication, packageDir: directory, store,
    fetchImpl: overrides.fetchImpl || (async (url, options) => {
      deliveries.push({ url, options });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    }), now: overrides.now });
  const app = express();
  feature.installIngest(app);
  app.use((req, res, next) => {
    const role = req.get("x-fixture-role");
    if (!role) return res.status(401).json({ error: "authentication_required" });
    req.principal = { role, subject: req.get("x-fixture-subject") || "alice" };
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("origin") !== origin)
      return res.status(403).json({ error: "origin_not_allowed" });
    next();
  });
  feature.installManagement(app);
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, init);
  const management = (path, init = {}, role = "analyst") => request(path, {
    ...init, headers: { "x-fixture-role": role, origin, ...init.headers },
  });
  const issue = async () => {
    const result = await management("/api/collector/devices", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "EC2", platform: "linux" }),
    });
    assert.equal(result.status, 201);
    return result.json();
  };
  const ingest = (token, init = {}) => request("/api/ingest/v1/logs", {
    method: "POST", body: "{}", ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  const renew = (token, init = {}) => request("/api/ingest/renew", { method: "POST", ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  return { request, management, issue, ingest, renew, deliveries, directory, feature, store, base, env, authentication };
}

async function uploadAfterAdmission(t, f, token, beforeBody) {
  let observedRead;
  const admitted = new Promise(resolve => { observedRead = resolve; });
  const get = f.store.get;
  f.store.get = async (...args) => {
    const record = await get(...args);
    observedRead();
    return record;
  };
  let request;
  const response = new Promise((resolveResponse, reject) => {
    request = httpRequest(f.base + "/api/ingest/v1/logs", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": "2",
    } }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolveResponse({ status: res.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.flushHeaders();
  });
  t.after(() => request.destroy());
  await admitted;
  // Let initial authentication complete and begin waiting for upload bytes.
  await new Promise(resolve => setImmediate(resolve));
  await beforeBody();
  request.end("{}");
  return response;
}

test("disabled feature is explicit and opt-in fails closed on invalid configuration", async t => {
  const f = await fixture(t, { env: { INGEST_ENABLED: "0" } });
  const metadata = await f.management("/api/collector");
  assert.deepEqual(await metadata.json(), { enabled: false, tokenLifetimeDays: 30,
    collectorVersion: "0.163.1", platforms: ["linux", "darwin"] });
  assert.equal(metadata.headers.get("cache-control"), "no-store");
  assert.equal((await f.ingest("bad")).status, 404);
  assert.equal((await f.request("/api/ingest/renew", { method: "POST" })).status, 404);
  for (const bad of [{ INGEST_ENABLED: "true" }, { INGEST_TOKEN_TABLE: "" }, { OIDC_ISSUER: "" },
    { INGEST_UPSTREAM_TOKEN_FILE: "/missing" }, { APP_PUBLIC_URL: "https://a.invalid/path" },
    { INGEST_UPSTREAM_URL: "http://user:secret@internal/" }])
    assert.throws(() => createCollectorFeature({ env: { ...f.env, INGEST_ENABLED: "1", ...bad },
      authentication: f.authentication, store: f.store }));
  assert.throws(() => createCollectorFeature({ env: { ...f.env, INGEST_ENABLED: "1" },
    authentication: { ...f.authentication, mode: "basic" }, store: f.store }));
});

test("viewer and anonymous requests cannot reach management or direct package downloads", async t => {
  const f = await fixture(t);
  for (const path of ["/api/collector", "/api/collector/devices", "/api/collector/package/linux",
    "/api/collector/package/darwin", "/api/collector/package/windows"]) {
    assert.equal((await f.management(path, {}, "viewer")).status, 403, path);
    assert.equal((await f.request(path)).status, 401, path);
  }
  assert.equal((await f.management("/api/collector/devices", { method: "POST", body: "{}",
    headers: { "content-type": "application/json" } }, "viewer")).status, 403);
  const download = await f.management("/api/collector/package/linux");
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment; filename="ccdash-collector-linux.tar.gz"/);
  assert.equal(download.headers.get("content-type"), "application/gzip");
  assert.equal(await download.text(), "archive-fixture");
  assert.equal((await f.management("/api/collector/package/darwin")).status, 503);
  assert.equal((await f.management("/api/collector/package/windows")).status, 404);
});

test("management requires same origin and serializes no secret after issuing", async t => {
  const f = await fixture(t);
  const forbidden = await f.management("/api/collector/devices", { method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.invalid" }, body: "{}" });
  assert.equal(forbidden.status, 403);
  const issued = await f.issue();
  const list = await f.management("/api/collector/devices");
  assert.deepEqual((await list.json()).devices, [issued.device]);
  assert.equal((await f.management("/api/collector/devices/" + issued.device.id,
    { method: "DELETE", headers: { "x-fixture-subject": "bob" } })).status, 404);
  assert.equal((await f.management("/api/collector/devices/" + issued.device.id, { method: "DELETE" })).status, 204);
  assert.equal((await f.ingest(issued.token)).status, 401);
});

test("device ownership uses the same canonical issuer URL as human authentication", async t => {
  const store = storeFixture();
  const original = await fixture(t, { store, env: { OIDC_ISSUER: "https://IDENTITY.EXAMPLE.INVALID" } });
  const canonical = await fixture(t, { store });
  const { device } = await original.issue();
  const list = await canonical.management("/api/collector/devices");
  assert.deepEqual((await list.json()).devices, [device]);
});

test("machine gateway requires a device bearer and exact path, method and media type", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  assert.equal((await f.request("/api/ingest/v1/logs", { method: "POST", body: "{}",
    headers: { cookie: "__Host-session=browser", "x-fixture-role": "admin", "content-type": "application/json" } })).status, 401);
  for (const path of ["/api/ingest/v1/logs/", "/api/ingest/v1/other", "/api/ingest/v1/%6cogs"])
    assert.equal((await f.request(path, { method: "POST" })).status, 404);
  assert.equal((await f.request("/api/ingest/v1/logs")).status, 405);
  assert.equal((await f.request("/api/ingest/v1/logs?secret=no", { method: "POST" })).status, 400);
  assert.equal((await f.ingest(token, { headers: { "content-encoding": "gzip" } })).status, 415);
  assert.equal((await f.ingest(token, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await f.ingest(token, { body: "invalid json" })).status, 400);
  assert.equal(f.deliveries.length, 0);
});

test("all three OTLP signals forward only bounded bytes and trusted headers", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  for (const signal of ["metrics", "logs", "traces"]) {
    const result = await f.request(`/api/ingest/v1/${signal}`, {
      method: "POST", body: Buffer.from([10, 0]),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf",
        cookie: "sensitive=ignored", "x-arbitrary-header": "do-not-forward" },
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "{}");
  }
  assert.deepEqual(f.deliveries.map(d => d.url), ["http://collector.internal:4318/v1/metrics",
    "http://collector.internal:4318/v1/logs", "http://collector.internal:4318/v1/traces"]);
  assert.deepEqual(f.deliveries[0].options.headers,
    { authorization: `Bearer ${"i".repeat(64)}`, "content-type": "application/x-protobuf" });
  assert.deepEqual(f.deliveries[0].options.body, Buffer.from([10, 0]));
  assert.equal(f.deliveries[0].options.redirect, "manual");
  assert.ok((await (await f.management("/api/collector/devices")).json()).devices[0].lastSeenAt);
});

test("oversize bodies and upstream errors are bounded and sanitized", async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response("private internal password", { status: 500 }) });
  const { token } = await f.issue();
  const large = await f.ingest(token, { body: "x".repeat(2 * 1024 * 1024 + 1) });
  assert.equal(large.status, 413);
  const rejected = await f.ingest(token);
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: "upstream_unavailable" });
  const huge = await fixture(t, { fetchImpl: async () => new Response("x".repeat(65537),
    { headers: { "content-type": "application/json" } }) });
  const second = await huge.issue();
  assert.equal((await huge.ingest(second.token)).status, 502);
});

test("store errors fail closed with stable errors", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  f.store.get = async () => { throw new Error("sensitive SDK credentials"); };
  assert.deepEqual(await (await f.ingest(token)).json(), { error: "store_unavailable" });
  assert.equal(f.deliveries.length, 0);
  f.store.put = async () => { throw new Error("sensitive SDK credentials"); };
  const mint = await f.management("/api/collector/devices", { method: "POST",
    headers: { "content-type": "application/json" }, body: '{"name":"X","platform":"linux"}' });
  assert.equal(mint.status, 503);
  assert.deepEqual(await mint.json(), { error: "store_unavailable" });
});

test("tokens expiring during an upload are rejected before any upstream delivery", async t => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time });
  const { token, device } = await f.issue();
  time = Date.parse(device.expiresAt) - 1000;
  const result = await uploadAfterAdmission(t, f, token, () => { time += 1000; });
  assert.equal(result.status, 401);
  assert.equal(f.deliveries.length, 0);
});

test("revocation cache expiry during an upload prevents any upstream delivery", async t => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time });
  const { token } = await f.issue();
  const [, owner, id] = token.split(".");
  const result = await uploadAfterAdmission(t, f, token, async () => {
    await f.store.revoke(owner, id, time);
    time += 10000;
  });
  assert.equal(result.status, 401);
  assert.equal(f.deliveries.length, 0);
});

test("authentication store failure after a slow upload fails closed before forwarding", async t => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time });
  const { token } = await f.issue();
  const result = await uploadAfterAdmission(t, f, token, () => {
    time += 10000;
    f.store.get = async () => { throw new Error("private SDK details"); };
  });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: "store_unavailable" });
  assert.equal(f.deliveries.length, 0);
});

test("metadata write failures preserve accepted responses and do not trigger client retries", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  f.store.touch = async () => { throw new Error("private DynamoDB details"); };
  // A retrying exporter sends the same batch again only if the acknowledgement fails.
  let result = await f.ingest(token);
  if (!result.ok) result = await f.ingest(token);
  assert.equal(result.status, 200);
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual(await result.json(), {});
});

test("revocation after forwarding does not replace an accepted response", async t => {
  let time = Date.now();
  const store = storeFixture();
  let deliveries = 0;
  const f = await fixture(t, { store, now: () => time, fetchImpl: async () => {
    deliveries++;
    const record = [...store.records.values()][0];
    await store.revoke(record.owner, record.id, time);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  } });
  const { token } = await f.issue();
  assert.equal((await f.ingest(token)).status, 200);
  time += 10000;
  assert.equal((await f.ingest(token)).status, 401);
  assert.equal(deliveries, 1);
});

test("stalled metadata writes are bounded without delaying responses or occupying ingest slots", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  const metadataSignals = [];
  let stalled = true;
  f.store.touch = (_owner, _id, _at, { signal }) => {
    metadataSignals.push(signal);
    return stalled ? new Promise(() => {}) : Promise.resolve(true);
  };
  // Serial deliveries still fill the separate metadata capacity when writes never settle.
  const responses = (async () => {
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await f.ingest(token));
    return results;
  })();
  let result;
  let deadline;
  try {
    result = await Promise.race([responses, new Promise((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("metadata delayed ingest acknowledgement")), 2000);
    })]);
  } finally { clearTimeout(deadline); }
  assert.equal(result.every(response => response.status === 200), true);
  assert.equal(metadataSignals.length, 8);
  for (let i = 0; i < 5; i++) assert.equal((await f.ingest(token)).status, 200);
  assert.equal(metadataSignals.length, 8);
  await new Promise(resolve => setTimeout(resolve, 3100));
  assert.equal(metadataSignals.every(signal => signal.aborted), true);
  stalled = false;
  assert.equal((await f.ingest(token)).status, 200);
  assert.equal(metadataSignals.length, 9);
});

test("chunked bodies cannot bypass the size bound and malformed requests release capacity", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  const response = await new Promise((resolveResponse, reject) => {
    const request = httpRequest(f.base + "/api/ingest/v1/logs", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/x-protobuf",
    } }, res => {
      res.resume();
      res.on("end", () => resolveResponse(res));
    });
    request.on("error", reject);
    request.write(Buffer.alloc(1024 * 1024));
    request.write(Buffer.alloc(1024 * 1024));
    request.end(Buffer.from([0]));
  });
  assert.equal(response.statusCode, 413);
  for (let i = 0; i < 10; i++) assert.equal((await f.ingest(token, { body: "{" })).status, 400);
  assert.equal((await f.ingest(token)).status, 200);
  assert.equal(f.deliveries.length, 1);
});

test("a rejected token is answered without waiting for the upload or forwarding it", async t => {
  const f = await fixture(t);
  const response = await new Promise((resolveResponse, reject) => {
    const request = httpRequest(f.base + "/api/ingest/v1/logs", { method: "POST", headers: {
      authorization: "Bearer invalid", "content-type": "application/json", "content-length": "10000",
    } }, res => {
      res.resume();
      res.on("end", () => resolveResponse(res));
    });
    request.on("error", reject);
    request.flushHeaders();
    t.after(() => request.destroy());
  });
  assert.equal(response.statusCode, 401);
  assert.equal(f.deliveries.length, 0);
});

test("admission rejects ninth concurrent request before reading its body and releases aborted slots", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  const sockets = [];
  for (let i = 0; i < 8; i++) {
    const request = httpRequest(f.base + "/api/ingest/v1/logs", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": "100",
    } });
    request.on("error", () => {});
    request.flushHeaders();
    sockets.push(request);
  }
  t.after(() => sockets.forEach(request => request.destroy()));
  await new Promise(resolve => setTimeout(resolve, 50));
  const blocked = await f.ingest(token);
  assert.equal(blocked.status, 429);
  sockets.forEach(request => request.destroy());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.ingest(token)).status, 200);
});

test("minting and per-device delivery are rate limited and recover after the window", async t => {
  let time = Date.now();
  const f = await fixture(t, { now: () => time });
  const { token } = await f.issue();
  for (let i = 0; i < 9; i++) await f.issue();
  const mint = await f.management("/api/collector/devices", { method: "POST",
    headers: { "content-type": "application/json" }, body: '{"name":"X","platform":"linux"}' });
  assert.equal(mint.status, 429);
  for (let i = 0; i < 120; i++) assert.equal((await f.ingest(token)).status, 200);
  assert.equal((await f.ingest(token)).status, 429);
  time += 60000;
  assert.equal((await f.ingest(token)).status, 200);
  time += 3600000;
  await f.issue();
});

test("total deadlines bound body receipt and upstream response, release slots and abort forwarding", async t => {
  let hanging = true;
  const signals = [];
  const f = await fixture(t, { fetchImpl: async (_url, { signal }) => {
    signals.push(signal);
    return hanging ? new Promise(() => {}) : new Response("{}", { headers: { "content-type": "application/json" } });
  } });
  const { token } = await f.issue();
  const slowUpload = await fixture(t);
  const uploadToken = (await slowUpload.issue()).token;
  const bodyTimeout = new Promise((resolveResponse, reject) => {
    const request = httpRequest(slowUpload.base + "/api/ingest/v1/logs", { method: "POST", headers: {
      authorization: `Bearer ${uploadToken}`, "content-type": "application/json", "content-length": "100",
    } }, res => {
      res.resume();
      res.on("end", () => resolveResponse(res.statusCode));
    });
    request.on("error", reject);
    request.flushHeaders();
    t.after(() => request.destroy());
  });
  const slowResponse = await fixture(t, { fetchImpl: async () => new Response(
    new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }),
    { headers: { "content-type": "application/json" } }) });
  const responseToken = (await slowResponse.issue()).token;
  const responseTimeout = slowResponse.ingest(responseToken);
  const began = Date.now();
  const timedOut = await Promise.all(Array.from({ length: 8 }, () => f.ingest(token)));
  for (const result of timedOut) {
    assert.equal(result.status, 504);
    assert.deepEqual(await result.json(), { error: "ingest_timeout" });
  }
  assert.equal(await bodyTimeout, 504);
  assert.equal((await responseTimeout).status, 504);
  assert.equal(slowUpload.deliveries.length, 0);
  assert.equal(signals.every(signal => signal.aborted), true);
  assert.ok(Date.now() - began < 17000);
  hanging = false;
  assert.equal((await f.ingest(token)).status, 200);
});

const DAY = 86400000;
const DEVICE_KEYS = ["id", "name", "platform", "createdAt", "expiresAt", "revokedAt", "lastSeenAt", "renewedAt", "reuseDetectedAt"];
const dueFixture = async t => {
  const clock = { time: Date.now() };
  const f = await fixture(t, { now: () => clock.time });
  const issued = await f.issue();
  return { f, clock, ...issued, makeDue: () => { clock.time = Date.parse(issued.device.expiresAt) - 7 * DAY; } };
};

test("a due renewal returns a one-time replacement promoted by its first delivery", async t => {
  const { f, clock, token, device, makeDue } = await dueFixture(t);
  const idle = await f.renew(token);
  assert.equal(idle.status, 200);
  assert.deepEqual(await idle.json(), { renewed: false, expiresAt: device.expiresAt });
  makeDue();
  const result = await f.renew(token);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  const body = await result.json();
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "renewed", "token"]);
  assert.equal(body.renewed, true);
  assert.equal(body.expiresAt, new Date(clock.time + 30 * DAY).toISOString());
  assert.match(body.token, /^ccd1\.[a-f0-9]{64}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(body.token.split(".").slice(0, 3).join("."), token.split(".").slice(0, 3).join("."));
  assert.notEqual(body.token, token);
  assert.equal(f.deliveries.length, 0);
  assert.equal((await (await f.management("/api/collector/devices")).json()).devices[0].lastSeenAt, null);
  assert.equal((await f.ingest(token)).status, 200);
  assert.equal((await f.ingest(body.token)).status, 200);
  assert.equal((await f.ingest(token)).status, 401);
  const text = await (await f.management("/api/collector/devices")).text();
  assert.equal(text.includes("pending"), false);
  assert.equal(text.includes(body.token.split(".")[3]), false);
  const [listed] = JSON.parse(text).devices;
  assert.deepEqual(Object.keys(listed), DEVICE_KEYS);
  assert.equal(listed.renewedAt, new Date(clock.time).toISOString());
  assert.equal(listed.expiresAt, body.expiresAt);
});

test("renewal applies the ingest gateway request rules", async t => {
  const f = await fixture(t);
  const { token } = await f.issue();
  const get = await f.request("/api/ingest/renew");
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal(get.headers.get("connection"), "close");
  assert.equal((await f.request("/api/ingest/renew?token=x", { method: "POST" })).status, 400);
  for (const path of ["/api/ingest/renew/", "/api/ingest/Renew", "/api/ingest/renewal"])
    assert.equal((await f.request(path, { method: "POST" })).status, 404, path);
  assert.equal((await f.renew(token, { headers: { "content-encoding": "gzip" } })).status, 415);
  assert.equal((await f.renew(token, { headers: { "content-type": "text/plain" } })).status, 415);
  const withBody = await f.renew(token, { body: "{}" });
  assert.equal(withBody.status, 400);
  assert.deepEqual(await withBody.json(), { error: "invalid_request" });
  const chunked = await new Promise((resolveResponse, reject) => {
    const request = httpRequest(f.base + "/api/ingest/renew", { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked",
    } }, res => {
      res.resume();
      res.on("end", () => resolveResponse(res));
    });
    request.on("error", reject);
    request.end("{}");
  });
  assert.equal(chunked.statusCode, 400);
  assert.equal((await f.renew("invalid")).status, 401);
  assert.equal((await f.request("/api/ingest/renew", { method: "POST", headers: {
    cookie: "__Host-session=browser", "x-fixture-role": "admin", "content-type": "application/json" } })).status, 401);
  assert.equal(f.deliveries.length, 0);
  assert.equal([...f.store.records.values()].some(record => "pendingHash" in record), false);
});

test("renewal is rate limited per device and recovers after the window", async t => {
  const { f, clock, token } = await dueFixture(t);
  for (let i = 0; i < 6; i++) assert.equal((await f.renew(token)).status, 200);
  const limited = await f.renew(token);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "3600");
  assert.deepEqual(await limited.json(), { error: "renew_rate_limited" });
  assert.equal((await f.ingest(token)).status, 200);
  clock.time += 3600000;
  assert.equal((await f.renew(token)).status, 200);
});

test("pending and revoked tokens get no replacement", async t => {
  const { f, token, device, makeDue } = await dueFixture(t);
  makeDue();
  const { token: next, expiresAt } = await (await f.renew(token)).json();
  const pending = await f.renew(next);
  assert.equal(pending.status, 200);
  assert.deepEqual(await pending.json(), { renewed: false, expiresAt });
  assert.equal((await f.renew(token)).status, 401);
  assert.equal((await f.management("/api/collector/devices/" + device.id, { method: "DELETE" })).status, 204);
  const revoked = await f.renew(next);
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), { error: "invalid_token" });
});

test("renewal and promotion log nothing", async t => {
  const logs = ["log", "info", "warn", "error", "debug"].map(name => t.mock.method(console, name, () => {}));
  const { f, token, makeDue } = await dueFixture(t);
  makeDue();
  const renewed = await (await f.renew(token)).json();
  assert.equal(renewed.renewed, true);
  assert.equal((await f.ingest(renewed.token)).status, 200);
  assert.equal(logs.every(mock => mock.mock.callCount() === 0), true);
});
