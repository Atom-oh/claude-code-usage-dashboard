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
