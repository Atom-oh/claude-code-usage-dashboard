import { test } from "node:test";
import assert from "node:assert/strict";
import { describeInstallation, createInstallationProbe } from "./installation.js";

const now = Date.parse("2026-10-12T12:00:00Z");
const base = {
  now, auth: { mode: "oidc", enabled: true }, enabledClients: ["claude", "codex"],
  databaseReady: true, readonly: true, readonlyCheckedAt: "2026-10-12T11:59:00Z",
  schema: { checkedAt: "2026-10-12T11:59:00Z", migrations: [2, 4, 6],
    segmentAwareSeriesKey: true, projectColumns: true },
  latestByClient: { claude: now - 1000, codex: now - 2000 }, staleAfterMinutes: 360,
  revision: "a".repeat(40),
};

test("installation diagnostics preserve scope and limits without claiming release readiness", () => {
  const result = describeInstallation(base);
  assert.equal(result.state, "operational");
  assert.deepEqual(result.clients.map(client => [client.client, client.state]), [["claude", "receiving"], ["codex", "receiving"]]);
  assert.equal(result.database.readonlyCheckedAt, base.readonlyCheckedAt);
  assert.equal(result.schema.checkedAt, base.schema.checkedAt);
  assert.equal(result.release.revision, base.revision);
  assert.ok(Object.values(result.limits).every(value => value === true));
  assert.ok(!JSON.stringify(result).includes("commercialReady"));
});

test("empty, stale and unavailable receipt are distinct and cannot become zero usage", () => {
  for (const [latest, expected] of [[0, "empty"], [null, "unavailable"], [NaN, "unavailable"],
    [-1, "unavailable"], [now - 361 * 60000, "stale"]]) {
    const result = describeInstallation({ ...base, latestByClient: { claude: latest, codex: now } });
    assert.equal(result.clients[0].state, expected);
    assert.equal(result.state, "needs_attention");
    assert.ok(!Object.hasOwn(result.clients[0], "tokens"));
    assert.ok(!Object.hasOwn(result.clients[0], "cost"));
  }
});

test("disabled clients are not probed or treated as missing; Claude identity is inapplicable", () => {
  const result = describeInstallation({ ...base, enabledClients: ["codex"],
    schema: { ...base.schema, segmentAwareSeriesKey: null } });
  assert.deepEqual(result.clients.map(client => client.client), ["codex"]);
  assert.equal(result.schema.counterIdentity, "not_applicable");
  assert.equal(result.state, "operational");
});

test("unknown schema and readonly states are distinct from negative results", () => {
  const unknown = describeInstallation({ ...base, readonly: null,
    schema: { segmentAwareSeriesKey: null, projectColumns: null, migrations: null } });
  assert.equal(unknown.database.readonly, "unavailable");
  assert.equal(unknown.schema.counterIdentity, "unavailable");
  assert.equal(unknown.schema.projectFields, "unavailable");
  assert.equal(unknown.schema.migrations, null);
  const negative = describeInstallation({ ...base, readonly: false,
    schema: { ...base.schema, segmentAwareSeriesKey: false, projectColumns: false, migrations: [] } });
  assert.equal(negative.database.readonly, "not_readonly");
  assert.equal(negative.schema.counterIdentity, "legacy");
  assert.equal(negative.schema.projectFields, "unconfirmed");
  assert.deepEqual(negative.schema.migrations, []);
  assert.equal(negative.state, "needs_attention");
});

test("Basic/development settings are explicit and invalid release identifiers stay unavailable", () => {
  for (const enabled of [true, false]) {
    const result = describeInstallation({ ...base, auth: { mode: "basic", enabled }, revision: "untrusted/not-a-sha" });
    assert.equal(result.authentication.state, enabled ? "shared_credential" : "development_bypass");
    assert.equal(result.state, "needs_attention");
    assert.equal(result.release.revision, null);
  }
});

test("concurrent diagnostics share one bounded memo; expiry starts after work completes", async () => {
  let time = now;
  let calls = 0;
  let resolvePing;
  const probe = createInstallationProbe({
    ...base, now: () => time, ttlMs: 100,
    ping: () => { calls++; return new Promise(resolve => { resolvePing = resolve; }); },
    probeLatest: async clients => base.latestByClient[clients[0]],
    getSchema: () => base.schema, getReadonly: () => true,
    getReadonlyCheckedAt: () => base.readonlyCheckedAt,
  });
  const first = probe();
  await Promise.resolve();
  time += 1000;
  assert.equal(probe(), first);
  resolvePing(true);
  assert.equal((await first).state, "operational");
  assert.equal(probe(), first);
  time += 101;
  const next = probe();
  await Promise.resolve();
  assert.notEqual(next, first);
  resolvePing(true);
  await next;
  assert.equal(calls, 2);
});

test("probe failures become unavailable diagnostics and expose no connection details", async () => {
  const result = await createInstallationProbe({
    ...base, now: () => now, ping: async () => { throw new Error("private-password@example.invalid"); },
    probeLatest: async () => { throw new Error("private-database-url"); },
    getSchema: () => base.schema, getReadonly: () => null,
  })();
  assert.equal(result.database.state, "unavailable");
  assert.ok(result.clients.every(client => client.state === "unavailable"));
  assert.ok(!JSON.stringify(result).includes("private-"));
});
