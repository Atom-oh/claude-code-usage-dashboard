// Explicit HTTP rejections, not timeouts, connection failures or server errors.
// They establish zero recorded completion usage only in otherwise empty scopes.
export const REJECTED_REQUEST_STATUSES = ["400", "401", "403", "404", "413", "415", "422", "429"];
export const CODEX_USAGE_KEYS = ["input_token_count", "output_token_count",
  "cached_token_count", "cache_write_token_count", "reasoning_token_count", "tool_token_count"];

export function isRejectedRequestEvent(attributes) {
  const status = attributes["http.response.status_code"];
  return ["codex.api_request", "codex.api_error"].includes(attributes["event.name"])
    && ["string", "number"].includes(typeof status)
    && REJECTED_REQUEST_STATUSES.includes(String(status).trim())
    && !CODEX_USAGE_KEYS.some(key => Object.hasOwn(attributes, key));
}

export function isRejectedRequestGroup(row) {
  const count = Number(row.count ?? 1), rejected = Number(row.rejected_count ?? 0);
  return row.kind === "request" && typeof row.session === "string" && row.session !== ""
    && Number(row.requires_usage ?? 0) === 0
    && Number.isSafeInteger(count) && count > 0 && rejected === count;
}
