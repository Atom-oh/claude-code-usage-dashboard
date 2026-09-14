import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClients, selectClients } from "./clients.js";

test("client defaults preserve existing Claude deployments", () => {
  assert.deepEqual(parseClients({}), { enabledClients: ["claude"], codexEndpoint: "mantle" });
});

test("client activation accepts exactly the three supported combinations", () => {
  const codex = parseClients({ CLAUDE_ENABLED: "false", CODEX_ENABLED: "1", CODEX_BEDROCK_ENDPOINT: "runtime" });
  assert.deepEqual(codex, { enabledClients: ["codex"], codexEndpoint: "runtime" });
  assert.deepEqual(parseClients({ CODEX_ENABLED: "true" }).enabledClients, ["claude", "codex"]);
  assert.throws(() => parseClients({ CLAUDE_ENABLED: "0", CODEX_ENABLED: "false" }));
  assert.throws(() => parseClients({ CODEX_ENABLED: "yes" }));
  assert.throws(() => parseClients({ CODEX_BEDROCK_ENDPOINT: "other" }));
});

test("disabled and malformed client filters never expand the requested scope", () => {
  assert.deepEqual(selectClients(undefined, ["codex"]), ["codex"]);
  assert.deepEqual(selectClients("all", ["claude", "codex"]), ["claude", "codex"]);
  assert.deepEqual(selectClients("codex", ["claude", "codex"]), ["codex"]);
  assert.throws(() => selectClients("claude", ["codex"]));
  assert.throws(() => selectClients(["codex", "claude"], ["codex"]));
  assert.throws(() => selectClients("unknown", ["claude"]));
});
