import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DeviceTokenError } from "./deviceTokens.js";

/** A provided client is a DocumentClient. The default uses the SDK credential chain (including IRSA). */
export function createDynamoDeviceStore({ tableName, client }) {
  if (typeof tableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName))
    throw new Error("INGEST_TOKEN_TABLE is invalid");
  const database = client || DynamoDBDocumentClient.from(new DynamoDBClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2500 },
  }));

  async function send(command, { signal } = {}, conditional = false) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let timer;
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => {
      rejectAborted = () => reject(new DeviceTokenError("store_unavailable", 503));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    timer = setTimeout(abort, 3000);
    if (signal?.aborted) abort();
    try {
      return await Promise.race([database.send(command, { abortSignal: controller.signal }), aborted]);
    } catch (error) {
      if (conditional && error?.name === "ConditionalCheckFailedException") return false;
      throw new DeviceTokenError("store_unavailable", 503);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  }

  const keyNames = { "#owner": "owner", "#id": "id" };
  return {
    async put(record, options) {
      await send(new PutCommand({ TableName: tableName, Item: record,
        ConditionExpression: "attribute_not_exists(#owner) AND attribute_not_exists(#id)",
        ExpressionAttributeNames: keyNames }), options);
    },
    async get(owner, id, options) {
      const result = await send(new GetCommand({ TableName: tableName, Key: { owner, id }, ConsistentRead: true }), options);
      return result.Item;
    },
    async list(owner, cursor, options) {
      const result = await send(new QueryCommand({ TableName: tableName,
        KeyConditionExpression: "#owner = :owner", ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": owner }, ConsistentRead: true, Limit: 50,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}) }), options);
      return { items: result.Items || [], lastKey: result.LastEvaluatedKey };
    },
    async revoke(owner, id, at, options) {
      const result = await send(new UpdateCommand({ TableName: tableName, Key: { owner, id },
        ConditionExpression: "attribute_exists(#owner) AND attribute_exists(#id)",
        UpdateExpression: "SET revokedAt = if_not_exists(revokedAt, :at)",
        ExpressionAttributeNames: keyNames, ExpressionAttributeValues: { ":at": at } }), options, true);
      return result !== false;
    },
    async touch(owner, id, at, options) {
      const result = await send(new UpdateCommand({ TableName: tableName, Key: { owner, id },
        ConditionExpression: "attribute_exists(#owner) AND attribute_exists(#id) AND attribute_not_exists(revokedAt) AND expiresAt > :at",
        UpdateExpression: "SET lastSeenAt = :at",
        ExpressionAttributeNames: keyNames, ExpressionAttributeValues: { ":at": at } }), options, true);
      return result !== false;
    },
  };
}
