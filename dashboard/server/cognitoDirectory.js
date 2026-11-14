import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DERIVED_ATTRIBUTES } from "./teamDirectory.js";

const PAGE_SIZE = 60;
const MAX_USERS = 10000;
const CALL_TIMEOUT_MS = 5000;

/** A provided client only needs `send`. The default uses the SDK credential chain (including IRSA). */
export function createCognitoDirectory({ region, poolId, client }) {
  const cognito = client || new CognitoIdentityProviderClient({ region, maxAttempts: 2 });

  // Aborts after 5 s or when the caller's signal aborts, whichever comes first.
  async function send(command, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, CALL_TIMEOUT_MS);
    if (signal?.aborted) abort();
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => {
      rejectAborted = () => reject(new Error("Cognito request aborted"));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      return await Promise.race([cognito.send(command, { abortSignal: controller.signal }), aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectAborted);
    }
  }

  return {
    async listUsers(signal) {
      const users = [];
      let token;
      do {
        const page = await send(new ListUsersCommand({
          UserPoolId: poolId, Limit: PAGE_SIZE, ...(token ? { PaginationToken: token } : {}),
        }), signal);
        for (const entry of page.Users || []) {
          const attributes = Object.fromEntries((entry.Attributes || []).map((a) => [a.Name, a.Value]));
          users.push({ sub: attributes.sub, email: attributes.email, attributes });
        }
        if (users.length > MAX_USERS) throw new Error("Cognito pool has more than " + MAX_USERS + " users");
        token = page.PaginationToken;
      } while (token);
      return users;
    },

    // Options for team attributes: `email` is excluded because a per-person value cannot form teams.
    async attributeNames(signal) {
      const { UserPool } = await send(new DescribeUserPoolCommand({ UserPoolId: poolId }), signal);
      const schema = UserPool?.SchemaAttributes || [];
      const custom = schema
        .filter((a) => a.Name?.startsWith("custom:") && a.AttributeDataType === "String")
        .map((a) => a.Name)
        .sort();
      const standard = schema.some((a) => a.Name === "name") ? ["name"] : [];
      return [...custom, ...standard, ...DERIVED_ATTRIBUTES];
    },
  };
}
