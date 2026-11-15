const PARTS = ["input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens"];
const numeric = value => ["number", "string"].includes(typeof value) && String(value).trim() !== "";
const unsafe = value => numeric(value) && Number.isInteger(Number(value))
  && Number(value) > Number.MAX_SAFE_INTEGER;

export function createObservedTokenParts() {
  return { values: Object.fromEntries(PARTS.map(key => [key, 0])), seen: false, missing: false, overflow: false };
}

// Use one validated cohort for all four disjoint components. Never combine
// independent input/output subtotals or infer an output count from observed_tokens.
export function addObservedTokenParts(state, usage, source = usage) {
  if (Number(source.observed_tokens_overflow) === 1
      || [...PARTS, "input_tokens_total"].some(key => unsafe(source[key]))) {
    state.overflow = true;
    return;
  }
  const values = PARTS.map(key => numeric(usage[key]) ? Number(usage[key]) : null);
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) {
    state.missing = true;
    return;
  }
  state.seen = true;
  if (state.overflow) return;
  for (let i = 0; i < PARTS.length; i++) state.values[PARTS[i]] += values[i];
  // The combined stack must also be exact, even if each segment is safe.
  if (!Number.isSafeInteger(Object.values(state.values).reduce((sum, value) => sum + value, 0))) {
    state.overflow = true;
  }
}

export function finishObservedTokenParts(state, { emptyValue = null } = {}) {
  const empty = state.missing || state.overflow ? null : emptyValue;
  return {
    ...Object.fromEntries(PARTS.map(key => [key, state.overflow ? null : state.seen ? state.values[key] : empty])),
    partial: state.missing || state.overflow,
  };
}
