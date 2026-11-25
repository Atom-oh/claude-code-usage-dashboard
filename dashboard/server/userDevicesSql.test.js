import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

test("user devices read the stamped attribute from ClickHouse logs", {
  skip: !process.env.USER_DEVICES_SQL_TEST_URL,
}, async () => {
  process.env.CH_URL = process.env.USER_DEVICES_SQL_TEST_URL;
  process.env.CH_USER = "default";
  process.env.CH_PASSWORD = "";
  const { createClient } = await import("@clickhouse/client");
  const db = createClient({ url: process.env.CH_URL, database: "claude_code" });
  const { userDevices } = await import("./userDevices.js");
  try {
    const id = randomUUID().slice(0, 8);
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const user = `devices-${id}@example.invalid`;
    const mac = `${"a".repeat(64)}.${"1".repeat(32)}`, ec2 = `${"a".repeat(64)}.${"2".repeat(32)}`;
    let n = 0;
    const log = (session, clock, { device, codex = false, event = "user_prompt", os = "darwin", who = user } = {}) => ({
      Timestamp: `${day} ${clock}.${String(n++).padStart(9, "0")}`,
      ResourceAttributes: { "user.email": who, "os.type": os, ...(device ? { "ccdash.device": device } : {}) },
      LogAttributes: { "event.name": codex ? `codex.${event}` : event,
        ...(codex ? { "conversation.id": session } : { "session.id": session }) },
    });
    await db.insert({ table: "otel_logs", format: "JSONEachRow", values: [
      log(`${id}-s1`, "10:00:00", { device: mac }), log(`${id}-s1`, "10:05:00", { device: mac }),
      log(`${id}-c1`, "11:00:00", { device: mac, codex: true, event: "api_request" }),
      // Streaming rows are skipped: this conversation has no other event.
      log(`${id}-c2`, "11:30:00", { device: ec2, codex: true, event: "sse_event" }),
      log(`${id}-s2`, "12:00:00", { device: ec2, os: "linux" }),
      log(`${id}-s3`, "13:00:00"),                                   // unattributed
      log(`${id}-s4`, "13:30:00", { device: mac, who: `other-${id}@example.invalid` }),
      log(`${id}-s5`, "23:30:00", { device: mac }),                  // outside the range
    ] });
    const from = new Date(`${day}T09:00:00Z`), to = new Date(`${day}T20:00:00Z`);
    const body = await userDevices(from, to, { userExact: user }, ["claude", "codex"]);
    assert.deepEqual(body.devices.map((d) => [d.device, d.clients, d.os_types, d.sessions]), [
      [ec2, ["claude"], ["linux"], 1],
      [mac, ["claude", "codex"], ["darwin"], 2],
    ]);
    assert.deepEqual(body.sessions, { [`${id}-s2`]: ec2, [`${id}-c1`]: mac, [`${id}-s1`]: mac });
    assert.equal(body.unattributed_sessions, 1);
    assert.equal(body.names_available, false);
    assert.match(body.devices[1].first_seen, new RegExp(`^${day} 10:00:00`));
    assert.match(body.devices[1].last_seen, new RegExp(`^${day} 11:00:00`));
  } finally {
    await db.close();
  }
});
