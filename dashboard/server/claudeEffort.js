import { validateClientFilters } from "./clientMetrics.js";
import { ValidationError } from "./http.js";
import { effortMix } from "./queries.js";
import { knownReportedCost } from "./reportedCost.js";
import { isNonAnthropicModel } from "./nonAnthropicCost.js";

export function validateClaudeEffort(raw) {
  const filters = validateClientFilters(raw, ["claude"]);
  if (raw.userExact !== undefined || raw.modelExact !== undefined)
    throw new ValidationError("unsupported filter", "exact drilldowns require /api/clients/overview");
  return filters;
}

// Fold only after SQL separates user/session/model scopes, so missing reports
// and invalid NAC factors cannot erase a different scope's known subtotal.
// Keep counter evidence separate from overview's token-derived fallback estimates.
// Non-Anthropic counter values are already rescaled by queries.js (ADR-017).
export function foldClaudeEffort(rows) {
  const groups = new Map();
  for (const row of rows) {
    const coverage = knownReportedCost([row], { requireObservedZero: true });
    const cost = coverage.known_reported_cost;
    const active = cost !== null || Number(row.cost_counter_rows) > 0
      || Number(row.observed_usage_rows) > 0
      || ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
        .some(key => Number(row[key]) > 0);
    if (!active) continue;
    const effort = row.effort || "unknown", backend = row.backend || "unknown";
    const key = JSON.stringify([effort, backend]);
    const group = groups.get(key) || { effort, backend, cost_usd: null,
      cost_partial: false, unpriced: 0, bases: new Set(), knownBases: new Set() };
    const basis = isNonAnthropicModel(row.model) ? "aws_list_estimate" : "client_reported";
    group.bases.add(basis);
    if (cost === null) group.unpriced++;
    else {
      group.knownBases.add(basis);
      group.cost_usd = (group.cost_usd ?? 0) + cost;
    }
    groups.set(key, group);
  }
  return [...groups.values()].map(({ bases, knownBases, ...row }) => {
    const displayedBases = knownBases.size ? knownBases : bases;
    return {
      ...row,
      cost_usd: Number.isFinite(row.cost_usd) ? row.cost_usd : null,
      cost_partial: row.cost_usd !== null && (row.unpriced > 0 || !Number.isFinite(row.cost_usd)),
      cost_basis: displayedBases.size === 1 ? [...displayedBases][0] : "mixed",
    };
  }).sort((a, b) => a.effort.localeCompare(b.effort) || a.backend.localeCompare(b.backend));
}

export async function claudeEffort(from, to, raw = {}, load = effortMix) {
  const { user, model, backend } = validateClaudeEffort(raw);
  const rows = await load(from, to, { user, model, backend, excludeUnknown: false }, { byModel: true });
  if (rows.length > 50000)
    throw new ValidationError("too much client data", "narrow the requested date range");
  return { range: { from: from.toISOString(), to: to.toISOString() },
    effort: foldClaudeEffort(rows), cost_scope: "reported_or_rescaled_counters" };
}
