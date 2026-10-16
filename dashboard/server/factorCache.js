import { CapacityError } from "./capacity.js";
import { querySignal, withoutQueryContext } from "./queryContext.js";

// One factor lookup belongs to all of its current subscribers. A failed overview
// can leave immediately, but must not cancel the lookup another view still needs.
export function createFactorCache({
  now = Date.now, ttlMs = 60_000, limit = 64,
  maxBytes = 4 * 1024 * 1024, maxEntryBytes = 1024 * 1024,
} = {}) {
  const settled = new Map();
  const pending = new Map();
  let settledBytes = 0;
  const remove = key => {
    const value = settled.get(key);
    if (value) { settledBytes -= value.bytes; settled.delete(key); }
  };
  return {
    get(key, load, signal) {
      signal = querySignal(signal);
      if (signal?.aborted) return Promise.reject(signal.reason);
      const hit = settled.get(key);
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
      if (hit) remove(key);
      let entry = pending.get(key);
      if (!entry) {
        if (pending.size >= limit) return Promise.reject(new CapacityError());
        entry = { abort: new AbortController(), subscribers: new Set(), active: true };
        pending.set(key, entry);
        entry.promise = Promise.resolve().then(() => {
          entry.abort.signal.throwIfAborted();
          return withoutQueryContext(() => load(entry.abort.signal));
        }).then(value => {
          if (pending.get(key) === entry) {
            let bytes = Infinity;
            try {
              const json = JSON.stringify(value);
              if (json !== undefined) bytes = Buffer.byteLength(json);
            } catch { /* Unserializable results are delivered, never cached. */ }
            if (bytes <= maxEntryBytes && bytes <= maxBytes) {
              remove(key);
              settled.set(key, { at: now(), value, bytes });
              settledBytes += bytes;
              while (settled.size > limit || settledBytes > maxBytes)
                remove(settled.keys().next().value);
            }
          }
          return value;
        }).finally(() => {
          entry.active = false;
          if (pending.get(key) === entry) pending.delete(key);
        });
      }
      return new Promise((resolve, reject) => {
        const subscriber = {};
        let done = false;
        const finish = (callback, value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", abort);
          entry.subscribers.delete(subscriber);
          callback(value);
        };
        const abort = () => {
          finish(reject, signal.reason);
          if (entry.active && entry.subscribers.size === 0) {
            if (pending.get(key) === entry) pending.delete(key);
            entry.abort.abort();
          }
        };
        entry.subscribers.add(subscriber);
        signal?.addEventListener("abort", abort, { once: true });
        entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
      });
    },
  };
}
