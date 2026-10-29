import { test } from "node:test";
import assert from "node:assert/strict";
import { createDynamoDeviceStore } from "./deviceTokenStore.js";

test("Dynamo reads are consistent, queries stay in the owner partition and pages are bounded", async () => {
  const calls = [];
  const store = createDynamoDeviceStore({ tableName: "devices", client: {
    async send(command) {
      calls.push(command);
      return command.constructor.name === "GetCommand" ? { Item: { owner: "alice", id: "id" } }
        : { Items: [{ owner: "alice", id: "id" }], LastEvaluatedKey: { owner: "alice", id: "id" } };
    },
  } });
  assert.deepEqual(await store.get("alice", "id"), { owner: "alice", id: "id" });
  const page = await store.list("alice", { owner: "alice", id: "previous" });
  assert.deepEqual(page, { items: [{ owner: "alice", id: "id" }], lastKey: { owner: "alice", id: "id" } });
  assert.deepEqual(calls[0].input, { TableName: "devices", Key: { owner: "alice", id: "id" }, ConsistentRead: true });
  assert.deepEqual(calls[1].input, { TableName: "devices",
    KeyConditionExpression: "#owner = :owner", ExpressionAttributeNames: { "#owner": "owner" },
    ExpressionAttributeValues: { ":owner": "alice" }, ConsistentRead: true, Limit: 50,
    ExclusiveStartKey: { owner: "alice", id: "previous" } });
});

test("writes reject collisions and conditional updates never resurrect missing or expired records", async () => {
  const commands = [];
  const store = createDynamoDeviceStore({ tableName: "devices", client: {
    async send(command) { commands.push(command); return {}; },
  } });
  await store.put({ owner: "alice", id: "id", secretHash: "hash" });
  assert.equal(await store.revoke("alice", "id", 100), true);
  assert.equal(await store.touch("alice", "id", 200), true);
  assert.equal(commands[0].input.ConditionExpression, "attribute_not_exists(#owner) AND attribute_not_exists(#id)");
  assert.equal(commands[1].input.ConditionExpression, "attribute_exists(#owner) AND attribute_exists(#id)");
  assert.equal(commands[1].input.UpdateExpression, "SET revokedAt = if_not_exists(revokedAt, :at)");
  assert.equal(commands[2].input.ConditionExpression,
    "attribute_exists(#owner) AND attribute_exists(#id) AND attribute_not_exists(revokedAt) AND expiresAt > :at");
  assert.deepEqual(commands[2].input.ExpressionAttributeValues, { ":at": 200 });
});

test("conditional update misses return false; failures are sanitized and cancellation aborts sends", async () => {
  const conditional = createDynamoDeviceStore({ tableName: "devices", client: {
    async send() { throw Object.assign(new Error("private table ARN"), { name: "ConditionalCheckFailedException" }); },
  } });
  assert.equal(await conditional.revoke("alice", "absent", 100), false);
  assert.equal(await conditional.touch("alice", "absent", 100), false);
  assert.equal(await conditional.stage("alice", "absent", "h", { hash: "n", issuedAt: 1, expiresAt: 2, purgeAt: 3 }), false);
  assert.equal(await conditional.promote("alice", "absent", { hash: "n", expiresAt: 2, purgeAt: 3 }, 1), false);
  await assert.rejects(conditional.put({}), { code: "store_unavailable", message: "store_unavailable" });
  const controller = new AbortController();
  let receivedSignal;
  const unavailable = createDynamoDeviceStore({ tableName: "devices", client: {
    send(_command, { abortSignal }) { receivedSignal = abortSignal; return new Promise(() => {}); },
  } });
  const result = unavailable.get("alice", "id", { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: "store_unavailable", message: "store_unavailable" });
  assert.equal(receivedSignal.aborted, true);
});

test("renewal staging and promotion are conditional updates on verified hashes", async () => {
  const commands = [];
  const store = createDynamoDeviceStore({ tableName: "devices", client: {
    async send(command) { commands.push(command); return {}; },
  } });
  assert.equal(await store.stage("alice", "id", "current", { hash: "next", issuedAt: 10, expiresAt: 20, purgeAt: 30 }), true);
  assert.equal(await store.promote("alice", "id", { hash: "next", expiresAt: 20, purgeAt: 30, previous: "current" }, 15), true);
  assert.equal(await store.flagReuse("alice", "id", 16), true);
  const base = { TableName: "devices", Key: { owner: "alice", id: "id" },
    ExpressionAttributeNames: { "#owner": "owner", "#id": "id" } };
  assert.deepEqual(commands[0].input, { ...base,
    ConditionExpression: "attribute_exists(#owner) AND attribute_exists(#id) AND secretHash = :current"
      + " AND attribute_not_exists(revokedAt) AND expiresAt > :at",
    UpdateExpression: "SET pendingHash = :hash, pendingIssuedAt = :at, pendingExpiresAt = :expiresAt, purgeAt = :purgeAt",
    ExpressionAttributeValues: { ":current": "current", ":hash": "next", ":at": 10, ":expiresAt": 20, ":purgeAt": 30 } });
  assert.deepEqual(commands[1].input, { ...base,
    ConditionExpression: "attribute_exists(#owner) AND attribute_exists(#id) AND pendingHash = :hash"
      + " AND pendingExpiresAt = :expiresAt AND pendingExpiresAt > :at AND attribute_not_exists(revokedAt)",
    UpdateExpression: "SET secretHash = :hash, expiresAt = :expiresAt, purgeAt = :purgeAt, renewedAt = :at,"
      + " previousHash = :previous REMOVE pendingHash, pendingIssuedAt, pendingExpiresAt",
    ExpressionAttributeValues: { ":hash": "next", ":expiresAt": 20, ":purgeAt": 30, ":at": 15, ":previous": "current" } });
  assert.deepEqual(commands[2].input, { ...base,
    ConditionExpression: "attribute_exists(#owner) AND attribute_exists(#id) AND attribute_not_exists(reuseDetectedAt)",
    UpdateExpression: "SET reuseDetectedAt = :at", ExpressionAttributeValues: { ":at": 16 } });
});
