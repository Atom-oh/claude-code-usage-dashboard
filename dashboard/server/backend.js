// Shared Claude/Codex backend (mantle vs runtime) resolution (ADR-017): cross-region
// routing prefix → runtime; else a vendor namespace ending in a letter before the dot
// (excludes a model's own versioned dot, e.g. grok-4.6) → mantle; else the resource tag
// if valid (Codex only); else unknown.
const REGION_PREFIX = /^(us|us-gov|eu|apac|jp|au|in|global)\./;
const VENDOR_PREFIX = /^[a-z][a-z0-9-]*[a-z]\./;
export const VALID_BACKENDS = ["bedrock-mantle", "bedrock-runtime"];

export function resolveBackend(model, tag) {
  const m = String(model || "");
  if (REGION_PREFIX.test(m)) return "bedrock-runtime";
  if (VENDOR_PREFIX.test(m)) return "bedrock-mantle";
  return VALID_BACKENDS.includes(tag) ? tag : "unknown";
}

// JS mirror of grouping.js claudeBackendSql() for one Claude call. hasOrg is the record's
// organization.id flag; route (session_group.claude_route) and providerBedrock/providerMantle
// are session evidence, omitted where claudeBackendSql passes sessionEvidence: false.
export function resolveClaudeBackend(model, sessionGroup, { hasOrg = false, route = "",
  providerBedrock = false, providerMantle = false } = {}) {
  const bare = String(model || "").startsWith("claude-");
  if (sessionGroup === "enterprise" || (hasOrg && bare)) return "anthropic";
  if (bare && VALID_BACKENDS.includes(route)) return route;
  if (bare && providerMantle && !providerBedrock) return "bedrock-mantle";
  if (bare && providerBedrock && !providerMantle) return "bedrock-runtime";
  return resolveBackend(model, "");
}

// SQL mirror of resolveBackend(). Keep the two regexes identical to the ones above.
export function backendSql(modelExpr, tagExpr) {
  return `multiIf(match(${modelExpr}, '^(us|us-gov|eu|apac|jp|au|in|global)\\\\.'), 'bedrock-runtime',
    match(${modelExpr}, '^[a-z][a-z0-9-]*[a-z]\\\\.'), 'bedrock-mantle',
    ${tagExpr} IN ('bedrock-mantle','bedrock-runtime'), ${tagExpr}, 'unknown')`;
}
