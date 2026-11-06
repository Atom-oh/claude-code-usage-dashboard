import { performance } from "node:perf_hooks";

// Answer immediately while one periodic background ping refreshes the bounded-age result.
export function createHealthProbe(ping, { now = () => performance.now(), cacheMs = 1000, maxAgeMs = 15_000,
  schedule = setInterval, cancel = clearInterval } = {}) {
  let pending = false, stopped = false, checkedAt = -Infinity, value = false;
  const refresh = () => {
    const time = now();
    if (!stopped && !pending && time - checkedAt >= cacheMs) {
      pending = true;
      Promise.resolve().then(ping).then(result => { value = Boolean(result); }, () => { value = false; })
        .finally(() => { checkedAt = now(); pending = false; });
    }
  };
  const timer = schedule(refresh, cacheMs);
  timer.unref?.();
  refresh();
  const probe = () => {
    const time = now();
    refresh();
    return value && time - checkedAt < maxAgeMs;
  };
  probe.stop = () => { stopped = true; cancel(timer); };
  return probe;
}
