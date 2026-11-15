import assert from "node:assert/strict";
import { test } from "node:test";
import { apiResponse, from, to } from "./fixtures.mjs";

test("provides a synthetic shared Skills response over the capture window", () => {
  const url = new URL("http://127.0.0.1/api/clients/skills");
  url.searchParams.set("client", "claude");
  const result = apiResponse(url);
  assert.deepEqual(result.clients, ["claude"]);
  assert.equal(result.effective_range.from, from);
  assert.equal(result.effective_range.to, to);
  assert.equal(result.by_client[0].client, "claude");
  assert.equal(result.by_client[0].skills[0].skill, "synthetic:docs-check");
  assert.equal(result.by_client[0].skills[0].calls, 24);
  assert.equal(result.by_client[0].skills_limited, false);
});
