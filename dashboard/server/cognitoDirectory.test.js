import test from "node:test";
import assert from "node:assert/strict";
import { createCognitoDirectory } from "./cognitoDirectory.js";

const user = (sub, email, extra = []) => ({
  Attributes: [{ Name: "sub", Value: sub }, { Name: "email", Value: email }, ...extra],
});

test("listUsers pages and maps attributes", async () => {
  const calls = [];
  const client = {
    async send(command) {
      calls.push(command.input);
      if (!command.input.PaginationToken)
        return { Users: [user("s1", "a@x", [{ Name: "custom:department", Value: "hana" }])], PaginationToken: "t2" };
      return { Users: [user("s2", "b@x")] };
    },
  };
  const directory = createCognitoDirectory({ region: "ap-northeast-2", poolId: "ap-northeast-2_abc", client });
  const users = await directory.listUsers();
  assert.deepEqual(users, [
    { sub: "s1", email: "a@x", attributes: { sub: "s1", email: "a@x", "custom:department": "hana" } },
    { sub: "s2", email: "b@x", attributes: { sub: "s2", email: "b@x" } },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].Limit, 60);
  assert.equal(calls[0].UserPoolId, "ap-northeast-2_abc");
  assert.equal(calls[1].PaginationToken, "t2");
});

test("listUsers stops with an error after 10000 users", async () => {
  const page = Array.from({ length: 60 }, (_, i) => user("s" + i, "u" + i + "@x"));
  const client = { async send() { return { Users: page, PaginationToken: "more" }; } };
  const directory = createCognitoDirectory({ region: "r", poolId: "p", client });
  await assert.rejects(directory.listUsers(), /10000/);
});

test("attributeNames offers custom string attributes and derived ones", async () => {
  const client = {
    async send(command) {
      assert.equal(command.input.UserPoolId, "p");
      return { UserPool: { SchemaAttributes: [
        { Name: "custom:department", AttributeDataType: "String" },
        { Name: "custom:budget", AttributeDataType: "Number" },
        { Name: "name", AttributeDataType: "String" },
        { Name: "email", AttributeDataType: "String" },
        { Name: "custom:cost_center", AttributeDataType: "String" },
      ] } };
    },
  };
  const directory = createCognitoDirectory({ region: "r", poolId: "p", client });
  assert.deepEqual(await directory.attributeNames(), ["custom:cost_center", "custom:department", "name", "email_domain"]);
});

test("SDK calls are aborted by the caller signal", async () => {
  const client = { send(_command, { abortSignal }) {
    return new Promise((_resolve, reject) => abortSignal.addEventListener("abort", () => reject(new Error("aborted"))));
  } };
  const directory = createCognitoDirectory({ region: "r", poolId: "p", client });
  const controller = new AbortController();
  const pending = directory.listUsers(controller.signal);
  controller.abort();
  await assert.rejects(pending);
});
