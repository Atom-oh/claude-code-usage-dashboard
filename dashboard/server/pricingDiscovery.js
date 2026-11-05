import { codexModel } from "./codexPricing.js";

// Set only by the running server. Importing query modules must not start network work.
let observer = () => {};
export function setPriceDiscoveryObserver(next = () => {}) { observer = next; }
export function observePricingModels(rows) { observer(rows); }

// One full public catalog scan serves all observed unknowns without sending their
// model IDs (or other telemetry) to AWS. No timer runs until an unknown is seen.
export function createPriceDiscovery({ prices, refresh, onChanged = () => {}, onError = () => {},
  now = Date.now, setTimer = setTimeout, retryMs = 5 * 60_000,
  negativeMs = 6 * 60 * 60_000, maxTracked = 256 }) {
  const attempted = new Map(), queued = new Set(), activeModels = new Set();
  const currentPrices = () => typeof prices === "function" ? prices() : prices;
  let active = null, timer = null, nextNetworkAt = 0;

  function remember(model, until) {
    attempted.delete(model);
    attempted.set(model, until);
    while (attempted.size > maxTracked) attempted.delete(attempted.keys().next().value);
  }

  function start() {
    timer = null;
    if (active || !queued.size) return;
    const wait = nextNetworkAt - now();
    if (wait > 0) {
      timer = setTimer(start, wait);
      timer.unref?.();
      return;
    }
    for (const model of queued) if (!Object.hasOwn(currentPrices(), model)) activeModels.add(model);
    queued.clear();
    if (!activeModels.size) return;
    nextNetworkAt = now() + retryMs;
    active = (async () => {
      // Ensure even a synchronously throwing refresh clears the assigned promise.
      await Promise.resolve();
      let delay = negativeMs;
      try {
        const result = await refresh();
        if (result.changed) onChanged(result);
      } catch (error) { delay = retryMs; onError(error); }
      finally {
        const until = now() + delay;
        for (const model of activeModels) remember(model, until);
        activeModels.clear();
        active = null;
        if (queued.size) start();
      }
    })();
  }

  function observe(rows) {
    for (const row of rows) {
      const raw = typeof row.model === "string" ? row.model : "";
      if (!["bedrock-mantle", "bedrock-runtime"].includes(row.backend)
          || raw.startsWith("us-gov.")
          || row.backend === "bedrock-mantle" && /^(us|eu|apac|jp|au|in|global)\./.test(raw)) continue;
      const model = codexModel(raw);
      if (!/^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9._-]{0,110}$/.test(model)
          || model.startsWith("anthropic.") || Object.hasOwn(currentPrices(), model)
          || (attempted.get(model) ?? -1) > now()) continue;
      if (active) {
        if (activeModels.size < maxTracked) activeModels.add(model);
      } else if (queued.size < maxTracked) queued.add(model);
    }
    if (!active && !timer && queued.size) start();
  }
  return { observe, idle: () => active || Promise.resolve() };
}
