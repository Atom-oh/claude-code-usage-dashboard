import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCognitoIssuer, attributeValue, userKey, emailKey, appendHistory, flattenIntervals } from "./teamDirectory.js";

test("parseCognitoIssuer accepts only Cognito pool issuers", () => {
  assert.deepEqual(parseCognitoIssuer("https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_u01c65YjO"),
    { region: "ap-northeast-2", poolId: "ap-northeast-2_u01c65YjO" });
  assert.equal(parseCognitoIssuer("https://login.example.com/"), null);
});
test("emailKey is case-insensitive", () => {
  assert.equal(emailKey("iss", "Alice@Example.com"), emailKey("iss", "alice@example.com"));
  assert.match(emailKey("iss", "a@b"), /^[a-f0-9]{64}$/);
  assert.equal(emailKey("iss", "émile@example.com"), null);
  assert.equal(emailKey("iss", "no-at-sign"), null);
});
test("userKey is a stable digest scoped by issuer", () => {
  assert.match(userKey("iss", "sub-1"), /^[a-f0-9]{64}$/);
  assert.equal(userKey("iss", "sub-1"), userKey("iss", "sub-1"));
  assert.notEqual(userKey("iss", "sub-1"), userKey("other", "sub-1"));
});
test("attributeValue ignores unusable values", () => {
  const user = { email: "a@Example.COM", attributes: { "custom:department": "  hana ", long: "x".repeat(257), empty: "", num: 5 } };
  assert.equal(attributeValue(user, "custom:department"), "hana");
  assert.equal(attributeValue(user, "email_domain"), "example.com");
  assert.equal(attributeValue(user, "long"), null);
  assert.equal(attributeValue(user, "empty"), null);
  assert.equal(attributeValue(user, "num"), null);
  assert.equal(attributeValue({ attributes: {} }, "email_domain"), null);
});
test("appendHistory records only changes and starts at epoch", () => {
  const first = appendHistory([], { team: "hana", emailKey: "k" }, 500);
  assert.deepEqual(first, [{ team: "hana", from: 0, emailKey: "k" }]);
  assert.equal(appendHistory(first, { team: "hana", emailKey: "k" }, 900), null);
  assert.deepEqual(appendHistory(first, { team: "cs", emailKey: "k" }, 900).at(-1), { team: "cs", from: 900, emailKey: "k" });
});
test("flattenIntervals clips history to each attribute window", () => {
  const out = flattenIntervals({
    attributes: [{ attribute: "custom:department", from: 0 }, { attribute: "email_domain", from: 1000 }],
    histories: {
      "custom:department": [{ entries: [{ team: "hana", from: 0, emailKey: "k" }, { team: "cs", from: 600, emailKey: "k" }] }],
      email_domain: [{ entries: [{ team: "example.com", from: 0, emailKey: "k" }] }],
    },
  });
  assert.deepEqual(out, { keys: ["k", "k", "k"], teams: ["hana", "cs", "example.com"],
    froms: [0, 600, 1000], tos: [600, 1000, 4102444800000] });
  assert.deepEqual(flattenIntervals({ attributes: [{ attribute: "a", from: 0 }],
    histories: { a: [{ entries: [{ team: "t", from: 0, emailKey: "k" }] }] }, limit: 0 }), { error: "directory_too_large" });
});
test("flattenIntervals maps null team to empty string and drops empty intervals", () => {
  const out = flattenIntervals({
    attributes: [{ attribute: "a", from: 100 }],
    histories: { a: [{ entries: [{ team: null, from: 0, emailKey: "k" }, { team: "t", from: 50, emailKey: "k" }, { team: "u", from: 200, emailKey: "k" }] }] },
  });
  assert.deepEqual(out, { keys: ["k", "k"], teams: ["t", "u"], froms: [100, 200], tos: [200, 4102444800000] });
  const nul = flattenIntervals({ attributes: [{ attribute: "a", from: 0 }],
    histories: { a: [{ entries: [{ team: null, from: 0, emailKey: "k" }] }] } });
  assert.deepEqual(nul.teams, [""]);
});
