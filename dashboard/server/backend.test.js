import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBackend, backendSql, VALID_BACKENDS } from "./backend.js";

test("a cross-region routing prefix always resolves to bedrock-runtime, regardless of tag", () => {
  for (const model of ["us.anthropic.claude-opus-5", "us.openai.gpt-6-astra",
    "us-gov.openai.gpt-6-astra", "eu.anthropic.claude-fable-5", "apac.openai.x",
    "jp.openai.x", "au.openai.x", "global.anthropic.claude-fable-5-1", "global.openai.gpt-6-astra",
    "global.xai.grok-4.6"]) {
    assert.equal(resolveBackend(model, "bedrock-mantle"), "bedrock-runtime", model);
    assert.equal(resolveBackend(model, "unknown"), "bedrock-runtime", model);
    assert.equal(resolveBackend(model, ""), "bedrock-runtime", model);
  }
});

test("a bare vendor namespace resolves to bedrock-mantle, regardless of tag", () => {
  for (const model of ["anthropic.claude-fable-5-1", "openai.gpt-6-astra", "xai.grok-4.6",
    "zai.glm-5", "moonshotai.kimi-k2.5", "deepseek.v3.2", "qwen.qwen3-coder-next"]) {
    assert.equal(resolveBackend(model, "bedrock-runtime"), "bedrock-mantle", model);
    assert.equal(resolveBackend(model, "unknown"), "bedrock-mantle", model);
    assert.equal(resolveBackend(model, ""), "bedrock-mantle", model);
  }
});

test("a model with no dot-prefixed namespace falls back to the resource tag", () => {
  for (const model of ["claude-sonnet-5", "claude-fable-5", "claude-fable-5[1m]", "kimi-k3", ""]) {
    assert.equal(resolveBackend(model, "bedrock-mantle"), "bedrock-mantle", model);
    assert.equal(resolveBackend(model, "bedrock-runtime"), "bedrock-runtime", model);
  }
});

test("a bare model's own version-number dot is never mistaken for a vendor namespace", () => {
  for (const model of ["grok-4.6", "gpt-5.4", "claude-3.5", "gpt-5.6-luna.2"]) {
    assert.equal(resolveBackend(model, "bedrock-runtime"), "bedrock-runtime", model);
    assert.equal(resolveBackend(model, "bedrock-mantle"), "bedrock-mantle", model);
    assert.equal(resolveBackend(model, ""), "unknown", model);
  }
});

test("an invalid or missing tag on a prefix-less model is unknown", () => {
  for (const tag of [undefined, null, "", "unknown", "amazon-bedrock", "bedrock-mantle "]) {
    assert.equal(resolveBackend("claude-sonnet-5", tag), "unknown", JSON.stringify(tag));
    assert.equal(resolveBackend("", tag), "unknown", JSON.stringify(tag));
  }
});

test("VALID_BACKENDS lists exactly the two known backend strings", () => {
  assert.deepEqual(VALID_BACKENDS, ["bedrock-mantle", "bedrock-runtime"]);
});

test("backendSql embeds the exact same region/vendor regexes as resolveBackend", () => {
  const sql = backendSql("MODEL_EXPR", "TAG_EXPR");
  assert.match(sql, /multiIf\(match\(MODEL_EXPR, '\^\(us\|us-gov\|eu\|apac\|jp\|au\|global\)\\\\\.'\), 'bedrock-runtime',/);
  assert.match(sql, /match\(MODEL_EXPR, '\^\[a-z\]\[a-z0-9-\]\*\[a-z\]\\\\\.'\), 'bedrock-mantle',/);
  assert.match(sql, /TAG_EXPR IN \('bedrock-mantle','bedrock-runtime'\), TAG_EXPR, 'unknown'\)/);
});

test("backendSql takes an arbitrary SQL expression, not just a column name", () => {
  const sql = backendSql("a['model']", "r['backend']");
  assert.match(sql, /match\(a\['model'\],/);
  assert.match(sql, /r\['backend'\] IN/);
});
