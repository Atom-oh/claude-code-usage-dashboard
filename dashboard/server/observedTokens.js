// Observed counts are separate from strict token completeness and from pricing.
function count(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function observedTokenPair(input, output) {
  const a = count(input), b = count(output);
  return a !== null && b !== null && Number.isSafeInteger(a + b) ? a + b : null;
}

export function createObservedTokens() {
  return { value: 0, seen: false, missing: false, overflow: false };
}

export function addObservedTokens(state, value, overflow = false) {
  // SQL may already have combined individually safe pairs into an unsafe sum.
  if (overflow) { state.overflow = true; return; }
  const number = count(value);
  if (number === null) { state.missing = true; return; }
  state.seen = true;
  if (state.overflow) return;
  const sum = state.value + number;
  if (Number.isSafeInteger(sum)) state.value = sum;
  else state.overflow = true;
}

export function finishObservedTokens(state, { partial = false, emptyValue = null } = {}) {
  const tokens_partial = partial || state.missing || state.overflow;
  return {
    observed_tokens: state.overflow ? null : state.seen ? state.value : tokens_partial ? null : emptyValue,
    tokens_partial,
  };
}
