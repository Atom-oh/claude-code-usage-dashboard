import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeviceTokenService } from "./deviceTokens.js";

const issuer = "https://identity.example.invalid/";
const start = Date.parse("2026-10-21T12:00:00Z");
const due = Date.parse("2026-11-13T12:00:00Z"); // expiresAt (2026-11-20T12:00Z) minus 7 days
const sha = value => createHash("sha256").update(value).digest("hex");
const NEXT = "2026-12-13T12:00:00.000Z"; // pending expiry: due plus 30 days
const PURGE = Date.parse("2026-12-20T12:00:00Z") / 1000;

// The remote store is replaced; token generation, validation, caching and ownership are real.
export function memoryStore() {
  const records = new Map();
  return {
    records,
    async put(record) { records.set(`${record.owner}:${record.id}`, structuredClone(record)); },
    async get(owner, id) { return structuredClone(records.get(`${owner}:${id}`)); },
    async list(owner, cursor) {
      const items = [...records.values()].filter(item => item.owner === owner)
        .sort((a, b) => a.id.localeCompare(b.id)).filter(item => !cursor || item.id > cursor.id);
      return { items: structuredClone(items.slice(0, 50)),
        lastKey: items.length > 50 ? { owner, id: items[49].id } : undefined };
    },
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

test("issued secret is returned once, stored only as a hash, and owner includes issuer and subject", async () => {
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => start });
  const { device, token } = await service.issue("subject-a", { name: "  Laptop  ", platform: "darwin" });
  assert.match(token, /^ccd1\.[a-f0-9]{64}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  const [, owner, id, secret] = token.split(".");
  assert.equal(owner, createHash("sha256").update(issuer + "\0subject-a").digest("hex"));
  assert.equal(device.id, id);
  assert.deepEqual(device, { id, name: "Laptop", platform: "darwin",
    createdAt: "2026-10-21T12:00:00.000Z", expiresAt: "2026-11-20T12:00:00.000Z",
    revokedAt: null, lastSeenAt: null, renewedAt: null });
  const stored = await store.get(owner, id);
  assert.equal(stored.secretHash, createHash("sha256").update(secret).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.equal(stored.purgeAt, Date.parse("2026-11-27T12:00:00Z") / 1000);
  const listed = await service.list("subject-a");
  assert.deepEqual(listed, { devices: [device], nextCursor: null });
  assert.equal(JSON.stringify(listed).includes(stored.secretHash), false);
});

test("tokens reject forgery, malformed encoding and expiry even while cached", async () => {
  let time = start;
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => time });
  const { token } = await service.issue("subject", { name: "EC2", platform: "linux" });
  assert.ok(await service.verify(token));
  const parts = token.split(".");
  parts[3] = "a".repeat(42) + "A";
  assert.equal(await service.verify(parts.join(".")), null);
  for (const malformed of ["", token + "=", token + ".extra", token.toUpperCase(), "Basic " + token])
    assert.equal(await service.verify(malformed), null);
  time += 30 * 86400000 - 1000;
  assert.ok(await service.verify(token));
  time += 1000;
  assert.equal(await service.verify(token), null);
});

test("owner-specific revoke is idempotent and reaches another service within ten seconds", async () => {
  let time = start;
  const store = memoryStore();
  const a = createDeviceTokenService({ store, issuer, now: () => time });
  const b = createDeviceTokenService({ store, issuer, now: () => time });
  const { device, token } = await a.issue("alice", { name: "PC", platform: "linux" });
  assert.ok(await b.verify(token));
  await assert.rejects(a.revoke("bob", device.id), { code: "device_not_found" });
  await a.revoke("alice", device.id);
  await a.revoke("alice", device.id);
  assert.equal(await a.verify(token), null);
  assert.ok(await b.verify(token));
  time += 10000;
  assert.equal(await b.verify(token), null);
  assert.equal((await a.list("alice")).devices[0].revokedAt, "2026-10-21T12:00:00.000Z");
  assert.equal(store.records.size, 1);
});

test("owner-bound pagination rejects cross-owner and malformed cursors", async () => {
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => start });
  for (let i = 0; i < 51; i++)
    await service.issue("alice", { name: `Device ${i}`, platform: "linux" });
  const first = await service.list("alice");
  assert.equal(first.devices.length, 50);
  assert.ok(first.nextCursor);
  const second = await service.list("alice", first.nextCursor);
  assert.equal(second.devices.length, 1);
  assert.equal(second.nextCursor, null);
  await assert.rejects(service.list("bob", first.nextCursor), { code: "invalid_cursor" });
  for (const bad of ["bad", "x".repeat(513), {}, ["a"]])
    await assert.rejects(service.list("alice", bad), { code: "invalid_cursor" });
});

test("validation rejects bad names and platforms before storing credentials", async () => {
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => start });
  for (const body of [null, {}, { name: "", platform: "linux" }, { name: "\nX", platform: "linux" },
    { name: "x".repeat(65), platform: "linux" }, { name: "X\u007f", platform: "linux" },
    { name: "X", platform: "windows" }, { name: 2, platform: "linux" }])
    await assert.rejects(service.issue("alice", body), { code: "invalid_device" });
  assert.equal(store.records.size, 0);
});

test("store outages fail closed after cache expiry; touch never recreates a missing device", async () => {
  let time = start;
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => time });
  const { token } = await service.issue("alice", { name: "X", platform: "linux" });
  const identity = await service.verify(token);
  assert.equal(await service.touch(identity), true);
  assert.equal((await service.list("alice")).devices[0].lastSeenAt, "2026-10-21T12:00:00.000Z");
  store.get = async () => { throw new Error("sensitive credential details"); };
  time += 10000;
  await assert.rejects(service.verify(token));
  store.records.clear();
  assert.equal(await service.touch(identity), false);
  assert.equal(store.records.size, 0);
});

test("verification cache holds at most 2048 successful devices", async () => {
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => start });
  const first = await service.issue("alice", { name: "first", platform: "linux" });
  await service.verify(first.token);
  for (let i = 0; i < 2048; i++) {
    const { token } = await service.issue("alice", { name: "next", platform: "linux" });
    await service.verify(token);
  }
  // Eviction forces a fresh store read and discovers this out-of-band revocation.
  const [, owner, id] = first.token.split(".");
  await store.revoke(owner, id, start);
  assert.equal(await service.verify(first.token), null);
});

test("a delayed consistent read does not extend the ten-second revocation window", async () => {
  let time = start;
  const store = memoryStore();
  const service = createDeviceTokenService({ store, issuer, now: () => time });
  const { token } = await service.issue("alice", { name: "first", platform: "linux" });
  const get = store.get;
  store.get = async (...args) => {
    const snapshot = await get(...args);
    time += 2500;
    return snapshot;
  };
  assert.ok(await service.verify(token));
  const [, owner, id] = token.split(".");
  await store.revoke(owner, id, start);
  time = start + 10000;
  assert.equal(await service.verify(token), null);
});

async function renewalFixture(services = 1) {
  const clock = { time: start };
  const store = memoryStore();
  const list = Array.from({ length: services }, () =>
    createDeviceTokenService({ store, issuer, now: () => clock.time }));
  const issued = await list[0].issue("alice", { name: "X", platform: "linux" });
  const [, owner, id, secret] = issued.token.split(".");
  return { clock, store, services: list, service: list[0], ...issued, owner, id, secret,
    record: () => store.records.get(`${owner}:${id}`) };
}

test("renewal is a no-op until seven days before expiry and admits only verified devices", async () => {
  const f = await renewalFixture();
  let stages = 0;
  const stage = f.store.stage;
  f.store.stage = async (...args) => { stages++; return stage(...args); };
  f.clock.time = due - 1;
  assert.deepEqual(await f.service.renew(f.token), { renewed: false, expiresAt: "2026-11-20T12:00:00.000Z" });
  assert.equal(stages, 0);
  assert.equal("pendingHash" in f.record(), false);
  const seen = [];
  const admit = identity => { seen.push(identity); return false; };
  await assert.rejects(f.service.renew(f.token, { admit }), { code: "renew_rate_limited", status: 429 });
  assert.deepEqual(seen, [{ owner: f.owner, id: f.id }]);
  await assert.rejects(f.service.renew("ccd1.bad", { admit }), { code: "invalid_token", status: 401 });
  assert.equal(seen.length, 1);
});

test("a due renewal stages a replaceable pending token while the current token stays valid", async () => {
  const f = await renewalFixture();
  f.clock.time = due;
  const next = await f.service.renew(f.token);
  assert.equal(next.renewed, true);
  assert.equal(next.expiresAt, NEXT);
  assert.match(next.token, /^ccd1\.[a-f0-9]{64}\.[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(next.token.split(".").slice(0, 3).join("."), f.token.split(".").slice(0, 3).join("."));
  const newSecret = next.token.split(".")[3];
  const record = f.record();
  assert.equal(record.pendingHash, sha(newSecret));
  assert.equal(record.pendingIssuedAt, due);
  assert.equal(record.pendingExpiresAt, Date.parse(NEXT));
  assert.equal(record.purgeAt, PURGE);
  assert.equal(record.secretHash, sha(f.secret));
  assert.equal(record.expiresAt, Date.parse("2026-11-20T12:00:00Z"));
  assert.equal(JSON.stringify(record).includes(newSecret), false);
  assert.ok(await f.service.verify(f.token));
  const listed = await f.service.list("alice");
  assert.deepEqual(Object.keys(listed.devices[0]),
    ["id", "name", "platform", "createdAt", "expiresAt", "revokedAt", "lastSeenAt", "renewedAt"]);
  assert.equal(listed.devices[0].renewedAt, null);
  // A repeated renewal replaces the earlier pending token.
  const second = await f.service.renew(f.token);
  assert.equal(await f.service.verify(next.token), null);
  assert.deepEqual(await f.service.verify(second.token), { owner: f.owner, id: f.id });
});

test("first pending use promotes once, even via a stale cache, and rejects the old token", async () => {
  const f = await renewalFixture(2);
  const [a, b] = f.services;
  f.clock.time = due;
  assert.ok(await b.verify(f.token));
  const { token: next } = await a.renew(f.token);
  let promotes = 0;
  const promote = f.store.promote;
  f.store.promote = async (...args) => { promotes++; return promote(...args); };
  // b cached the record before the renewal on a, so it must read again and promote.
  assert.deepEqual(await b.verify(next), { owner: f.owner, id: f.id });
  assert.equal(await b.verify(f.token), null);
  const record = f.record();
  assert.equal(record.secretHash, sha(next.split(".")[3]));
  assert.equal(record.expiresAt, Date.parse(NEXT));
  assert.equal(record.purgeAt, PURGE);
  assert.equal(record.renewedAt, due);
  for (const field of ["pendingHash", "pendingIssuedAt", "pendingExpiresAt"]) assert.equal(field in record, false);
  assert.ok(await b.verify(next));
  assert.equal(promotes, 1);
  assert.ok(await a.verify(f.token));
  f.clock.time += 10000;
  assert.equal(await a.verify(f.token), null);
  assert.ok(await a.verify(next));
  const device = (await a.list("alice")).devices[0];
  assert.equal(device.renewedAt, "2026-11-13T12:00:00.000Z");
  assert.equal(device.expiresAt, NEXT);
});

test("a lost promotion race re-reads the record instead of failing", async () => {
  const f = await renewalFixture();
  f.clock.time = due;
  const next = (await f.service.renew(f.token)).token;
  const original = f.store.promote;
  f.store.promote = async (...args) => { await original(...args); return false; };
  assert.deepEqual(await f.service.verify(next), { owner: f.owner, id: f.id });
  assert.deepEqual(await f.service.renew(next), { renewed: false, expiresAt: NEXT });
  const g = await renewalFixture();
  const store2 = g.store;
  g.clock.time = due;
  const next2 = (await g.service.renew(g.token)).token;
  store2.promote = async (o, i) => { store2.records.get(`${o}:${i}`).revokedAt = due; return false; };
  assert.equal(await g.service.verify(next2), null);
});

test("revoked, expired and pending tokens cannot mint a replacement", async () => {
  const f = await renewalFixture();
  const { service, store } = f;
  const devices = [{ token: f.token, device: f.device }];
  for (let i = 0; i < 4; i++) devices.push(await service.issue("alice", { name: "X", platform: "linux" }));
  let stages = 0;
  const stage = store.stage;
  store.stage = async (...args) => { stages++; return stage(...args); };
  f.clock.time = due;
  const next = (await service.renew(devices[0].token)).token;
  assert.deepEqual(await service.renew(next), { renewed: false, expiresAt: NEXT });
  assert.equal("pendingHash" in f.record(), false);
  assert.equal(stages, 1);
  const late = (await service.renew(devices[4].token)).token;
  f.clock.time = Date.parse("2026-12-07T12:00:00Z");
  assert.deepEqual(await service.renew(late), { renewed: false, expiresAt: NEXT });
  assert.equal(stages, 2);
  f.clock.time = due;
  await service.revoke("alice", devices[1].device.id);
  await assert.rejects(service.renew(devices[1].token), { code: "invalid_token", status: 401 });
  const counted = store.stage;
  store.stage = async () => false;
  await assert.rejects(service.renew(devices[2].token), { code: "invalid_token", status: 401 });
  store.stage = counted;
  f.clock.time = Date.parse("2026-11-20T12:00:00Z");
  await assert.rejects(service.renew(devices[3].token), { code: "invalid_token", status: 401 });
});

test("a pending token outlives the previous token and then expires", async () => {
  const f = await renewalFixture();
  const d2 = await f.service.issue("alice", { name: "X", platform: "linux" });
  f.clock.time = due;
  const n1 = (await f.service.renew(f.token)).token;
  const n2 = (await f.service.renew(d2.token)).token;
  f.clock.time = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(await f.service.verify(f.token), null);
  assert.deepEqual(await f.service.verify(n1), { owner: f.owner, id: f.id });
  f.clock.time = Date.parse(NEXT);
  assert.equal(await f.service.verify(n2), null);
});
