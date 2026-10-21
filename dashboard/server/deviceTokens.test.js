import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDeviceTokenService } from "./deviceTokens.js";

const issuer = "https://identity.example.invalid/";
const start = Date.parse("2026-10-21T12:00:00Z");

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
    revokedAt: null, lastSeenAt: null });
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
