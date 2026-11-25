import { test } from "node:test";
import assert from "node:assert/strict";
import { DEVICE_LIMIT, createDeviceNames, deviceCacheKey, foldDevices, userDevices, userDevicesSql,
  validateDeviceQuery } from "./userDevices.js";

const OWNER = "a".repeat(64);
const dev = (n) => `${OWNER}.${String(n).padStart(32, "0")}`;
const row = (client, session, device, seen, extra = {}) => ({ client, session, device, os_type: "darwin",
  first_seen: seen, last_seen: seen, ...extra });

test("validation requires userExact and an enabled client", () => {
  assert.deepEqual(validateDeviceQuery({ userExact: "u@example.invalid" }, ["claude", "codex"]),
    { clients: ["claude", "codex"], userExact: "u@example.invalid" });
  const rejects = (raw, detail) => assert.throws(() => validateDeviceQuery(raw, ["claude"]),
    (error) => error.status === 400 && detail.test(error.detail));
  rejects({}, /userExact is required/);
  rejects({ userExact: "x".repeat(257) }, /userExact is required/);
  rejects({ userExact: "u", client: "codex" }, /enabled coding client/);
  assert.equal(deviceCacheKey({ userExact: "u", from: "f", to: "t", ignored: "x" }, ["claude"]),
    "client=claude&from=f&to=t&userExact=u");
});

test("SQL reads the stamped attribute per client session and skips Codex streaming rows", () => {
  const sql = userDevicesSql(["claude", "codex"]);
  assert.ok(sql.includes("ResourceAttributes['ccdash.device'] AS device"));
  assert.ok(sql.includes("SessionId AS session"));
  assert.ok(sql.includes("LogAttributes['conversation.id'] AS session"));
  assert.ok(sql.includes("EventName != 'codex.sse_event'"));
  assert.equal(sql.match(/= \{userExact:String\}/g).length, 2);
  assert.ok(!userDevicesSql(["claude"]).includes("UNION ALL"));
});

test("folding groups sessions by device and counts sessions without a valid device", () => {
  const folded = foldDevices([
    row("claude", "s1", dev(1), "2026-11-20 01:00:00.000"),
    row("claude", "s1", "", "2026-11-19 23:00:00.000"),            // before the stamp: still attributed
    row("codex", "c1", dev(1), "2026-11-21 01:00:00.000", { os_type: "" }),
    row("claude", "s2", dev(2), "2026-11-22 01:00:00.000", { os_type: "linux" }),
    row("claude", "s3", "", "2026-11-22 02:00:00.000"),
    row("claude", "s4", "forged", "2026-11-22 03:00:00.000"),      // never a valid device
  ]);
  assert.deepEqual(folded.devices, [
    { device: dev(2), clients: ["claude"], os_types: ["linux"], sessions: 1,
      first_seen: "2026-11-22 01:00:00.000", last_seen: "2026-11-22 01:00:00.000" },
    { device: dev(1), clients: ["claude", "codex"], os_types: ["darwin"], sessions: 2,
      first_seen: "2026-11-20 01:00:00.000", last_seen: "2026-11-21 01:00:00.000" },
  ]);
  assert.deepEqual(folded.sessions, { s2: dev(2), c1: dev(1), s1: dev(1) });
  assert.equal(folded.unattributed_sessions, 2);
  assert.equal(folded.devices_truncated, false);
});

test("the device list is capped, most recent first", () => {
  const rows = Array.from({ length: DEVICE_LIMIT + 2 }, (_, i) =>
    row("claude", `s${i}`, dev(i), `2026-11-22 ${String(i).padStart(2, "0")}:00:00.000`));
  const folded = foldDevices(rows);
  assert.equal(folded.devices.length, DEVICE_LIMIT);
  assert.equal(folded.devices_truncated, true);
  assert.equal(folded.devices[0].device, dev(DEVICE_LIMIT + 1));
});

test("names resolve from the registry, mark deleted devices and are cached", async () => {
  let calls = 0;
  let time = 0;
  const names = createDeviceNames({ now: () => time, ttlMs: 1000, lookup: async (owner, id) => {
    calls++;
    assert.equal(owner, OWNER);
    return id.endsWith("1") ? { name: "MacBook", platform: "darwin", revoked: false } : null;
  } });
  const first = await names([dev(1), dev(2)]);
  assert.deepEqual(first.get(dev(1)), { name: "MacBook", platform: "darwin", revoked: false });
  assert.deepEqual(first.get(dev(2)), { deleted: true });
  await names([dev(1), dev(2)]);
  assert.equal(calls, 2);
  time = 2000;
  await names([dev(1)]);
  assert.equal(calls, 3);
});

test("a registry failure or missing registry leaves names unavailable, not an error", async () => {
  const run = async () => [row("claude", "s1", dev(1), "2026-11-22 01:00:00.000")];
  const failing = createDeviceNames({ lookup: async () => { throw new Error("AccessDenied"); } });
  const body = await userDevices(new Date(0), new Date(1000), { userExact: "u" }, ["claude"], { names: failing, run });
  assert.equal(body.names_available, false);
  assert.equal(body.devices[0].name, undefined);
  const none = await userDevices(new Date(0), new Date(1000), { userExact: "u" }, ["claude"],
    { names: createDeviceNames({ lookup: null }), run });
  assert.equal(none.names_available, false);
  const named = await userDevices(new Date(0), new Date(1000), { userExact: "u" }, ["claude"],
    { names: createDeviceNames({ lookup: async () => ({ name: "EC2", platform: "linux", revoked: true }) }), run });
  assert.equal(named.names_available, true);
  assert.deepEqual([named.devices[0].name, named.devices[0].platform, named.devices[0].revoked], ["EC2", "linux", true]);
});

test("the PII mask keeps registry names on the server", async () => {
  let looked = 0;
  const names = createDeviceNames({ lookup: async () => { looked++; return { name: "Alice's MacBook", platform: "darwin" }; } });
  const body = await userDevices(new Date(0), new Date(1000), { userExact: "u" }, ["claude"], { names, maskNames: true,
    run: async () => [row("claude", "s1", dev(1), "2026-11-22 01:00:00.000")] });
  assert.equal(looked, 0);
  assert.equal(body.names_masked, true);
  assert.equal(body.names_available, false);
  assert.ok(!JSON.stringify(body).includes("MacBook"));
});

test("the handler binds the range and user as parameters", async () => {
  let seen;
  await userDevices(new Date("2026-11-22T00:00:00Z"), new Date("2026-11-23T00:00:00Z"), { userExact: "u'x" }, ["claude"],
    { run: async (sql, params) => { seen = { sql, params }; return []; } });
  assert.deepEqual(seen.params, { from: "2026-11-22 00:00:00", to: "2026-11-23 00:00:00", userExact: "u'x" });
  assert.ok(!seen.sql.includes("u'x"));
});
