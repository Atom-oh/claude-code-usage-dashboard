// Completion-cohort metrics are separate from strict whole-window summaries.
// Callers provide canonical token sums and a matched identified-session subtotal.
function number(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function count(value) {
  const n = number(value);
  return Number.isSafeInteger(n) ? n : null;
}
function ratio(numerator, denominator) {
  return numerator !== null && denominator !== null && denominator > 0
    ? number(numerator / denominator) : null;
}
function subset(part, whole) {
  const n = count(part), d = count(whole);
  return n !== null && d !== null && n <= d ? ratio(n, d) : null;
}
function cost(total) {
  const amount = number(total.cost_usd);
  return count(total.priced) > 0 && amount !== null && Number.isFinite(amount * 1e12)
    ? Math.round(amount * 1e12) / 1e12 : null;
}
function costPartial(total, amount) {
  const unpriced = count(total.unpriced);
  return unpriced === null || unpriced > 0 || count(total.priced) > 0 && amount === null;
}

export function completionUsage(total, identified, { limited = false } = {}) {
  const value = limited ? {} : total;
  const session = limited ? {} : identified;
  const completions = count(value.requests), sessionCompletions = count(session.requests);
  const tokens = completions > 0 ? count(value.tokens) : null;
  const amount = cost(value), sessionAmount = cost(session);
  const sessions = count(session.sessions);
  return {
    basis: "recorded_completions",
    status: limited ? "limited" : completions === null ? "unavailable" : completions > 0 ? "observed" : "empty",
    completions,
    tokens,
    tokens_partial: limited || completions === null || completions > 0 && tokens === null,
    cache_hit_rate: subset(value.read, value.input),
    cache_write_share: subset(value.write, value.input),
    reasoning_share: subset(value.reasoning, value.output),
    tokens_per_completion: ratio(tokens, completions),
    cost_basis: "aws_list_estimate",
    cost_usd: amount,
    unpriced: count(value.unpriced),
    cost_partial: costPartial(value, amount),
    cost_per_completion: ratio(amount, completions),
    identified_sessions: sessions,
    identified_completions: sessionCompletions,
    unidentified_completions: completions !== null && sessionCompletions !== null
      && sessionCompletions <= completions ? completions - sessionCompletions : null,
    identified_cost_usd: sessionAmount,
    identified_unpriced: count(session.unpriced),
    identified_cost_partial: costPartial(session, sessionAmount),
    cost_per_identified_session: ratio(sessionAmount, sessions),
  };
}
