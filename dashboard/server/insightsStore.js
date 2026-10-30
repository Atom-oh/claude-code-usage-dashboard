import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

// Daily insight storage (docs/reference/iac.md#daily-insights). One lease item per period
// gates the model call across pods; the result item is written once and never replaced.
export const LEASE_MS = 15 * 60_000;
export const MAX_ATTEMPTS = 3;
const RETENTION_SECONDS = 90 * 86_400;
const NEW_ITEM = { ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } };

export class InsightsStoreError extends Error {
  constructor() { super("insights store unavailable"); this.name = "InsightsStoreError"; }
}

export const purgeAt = (period) => Math.floor(Date.parse(`${period}T00:00:00Z`) / 1000) + RETENTION_SECONDS;

/** A provided client is a DocumentClient. The default uses the SDK credential chain (including IRSA). */
export function createInsightsStore({ tableName, client }) {
  if (typeof tableName !== "string" || !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName))
    throw new Error("INSIGHTS_TABLE is invalid");
  const database = client || DynamoDBDocumentClient.from(new DynamoDBClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2500 },
  }));

  // Returns false for a failed condition; any other failure is an unavailable store.
  async function send(command, conditional = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      return await database.send(command, { abortSignal: controller.signal });
    } catch (error) {
      if (conditional && error?.name === "ConditionalCheckFailedException") return false;
      throw new InsightsStoreError();
    } finally {
      clearTimeout(timer);
    }
  }
  const get = async (pk) =>
    (await send(new GetCommand({ TableName: tableName, Key: { pk }, ConsistentRead: true })))?.Item || null;

  return {
    getResult: (period) => get(`daily#${period}`),
    getLease: (period) => get(`lease#${period}`),
    // Compare-and-set on the observed lease: one pod wins each attempt, and an
    // unexpired or exhausted lease is never replaced.
    async acquireLease(period, owner, nowMs) {
      const current = await get(`lease#${period}`);
      if (current && Number(current.expiresAt) > nowMs) return { acquired: false, reason: "held" };
      const attempts = current ? Number(current.attempts) || 0 : 0;
      if (attempts >= MAX_ATTEMPTS) return { acquired: false, reason: "exhausted" };
      const item = { pk: `lease#${period}`, period, owner, attempts: attempts + 1,
        expiresAt: nowMs + LEASE_MS, purgeAt: purgeAt(period) };
      const condition = current ? {
        ConditionExpression: "#attempts = :attempts AND #expiresAt = :expiresAt",
        ExpressionAttributeNames: { "#attempts": "attempts", "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: { ":attempts": current.attempts, ":expiresAt": current.expiresAt },
      } : NEW_ITEM;
      const won = await send(new PutCommand({ TableName: tableName, Item: item, ...condition }), true);
      return won === false ? { acquired: false, reason: "lost" } : { acquired: true, attempts: attempts + 1 };
    },
    async putResult(period, item) {
      const written = await send(new PutCommand({ TableName: tableName,
        Item: { ...item, pk: `daily#${period}`, period, purgeAt: purgeAt(period) }, ...NEW_ITEM }), true);
      return written !== false;
    },
  };
}
