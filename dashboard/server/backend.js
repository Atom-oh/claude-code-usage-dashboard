// Shared Claude/Codex backend (mantle vs runtime) resolution.
//
// 2026-09-25 decision (supersedes the earlier "model names never establish backend"
// rule in docs/runbooks/codex-telemetry.md and collector-config.yaml, and Claude's old
// "bedrock channel is always bedrock-runtime" assumption): multi-model Bedrock testing
// showed the launcher's inherited `x-ccdash-backend` tag is unreliable once a gateway or
// wrapper process is in front of Codex — every row observed live carried "bedrock-mantle"
// even for `global.`-prefixed models that only exist on Bedrock Runtime. The model ID
// prefix is the more reliable signal and is checked first:
//   1. A cross-region routing prefix (us./us-gov./eu./apac./jp./au./global.) means the
//      request went through Bedrock Runtime's inference profile routing → bedrock-runtime.
//   2. Otherwise, if the model id itself starts with a bare vendor namespace
//      (anthropic./openai./xai./...) → bedrock-mantle (Bedrock Marketplace/mantle serves
//      models under their raw vendor id, never through a region-routed profile).
//   3. Otherwise (no dot-prefixed namespace at all, e.g. a bare "claude-*" or a
//      third-party short id) fall back to the resource-attribute tag, when it is one of
//      the two known values. Codex is the only client that carries this tag; Claude has
//      none, so its bare-model rows land in step 4.
//   4. Otherwise: unknown.
// See docs/decisions/ADR-017-model-prefix-backend-and-computed-fallback.md.
const REGION_PREFIX = /^(us|us-gov|eu|apac|jp|au|global)\./;
const VENDOR_PREFIX = /^[a-z][a-z0-9-]*\./;
export const VALID_BACKENDS = ["bedrock-mantle", "bedrock-runtime"];

export function resolveBackend(model, tag) {
  const m = String(model || "");
  if (REGION_PREFIX.test(m)) return "bedrock-runtime";
  if (VENDOR_PREFIX.test(m)) return "bedrock-mantle";
  return VALID_BACKENDS.includes(tag) ? tag : "unknown";
}

// SQL mirror of resolveBackend(). modelExpr/tagExpr are SQL expressions (a map access,
// a column, or a string literal such as `''` when the row's client has no resource tag).
// Keep the two regexes textually identical to the ones above (same alternation order).
export function backendSql(modelExpr, tagExpr) {
  return `multiIf(match(${modelExpr}, '^(us|us-gov|eu|apac|jp|au|global)\\\\.'), 'bedrock-runtime',
    match(${modelExpr}, '^[a-z][a-z0-9-]*\\\\.'), 'bedrock-mantle',
    ${tagExpr} IN ('bedrock-mantle','bedrock-runtime'), ${tagExpr}, 'unknown')`;
}
