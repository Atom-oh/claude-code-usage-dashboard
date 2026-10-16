export class CapacityError extends Error {
  constructor() {
    super("runtime capacity exhausted");
  }
}

export function createBudget(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("invalid capacity");
  let active = 0;
  return {
    acquire() {
      if (active >= maximum) throw new CapacityError();
      active++;
      let released = false;
      return () => {
        if (!released) { released = true; active--; }
      };
    },
    get active() { return active; },
  };
}

export function createQueuedBudget({ maximum = 24, maxWaiting = 128, waitMs = 30_000 } = {}) {
  if (![maximum, maxWaiting, waitMs].every(value => Number.isSafeInteger(value) && value > 0))
    throw new RangeError("invalid queued capacity");
  let active = 0;
  const waiting = [];
  const grant = () => {
    active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      const next = waiting.shift();
      if (next) {
        next.cleanup();
        next.resolve(grant());
      }
    };
  };
  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      if (active < maximum) return grant();
      if (waiting.length >= maxWaiting) throw new CapacityError();
      return new Promise((resolve, reject) => {
        let timer;
        const waiter = { resolve, cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        } };
        const cancel = error => {
          const index = waiting.indexOf(waiter);
          if (index < 0) return;
          waiting.splice(index, 1);
          waiter.cleanup();
          reject(error);
        };
        const abort = () => cancel(signal.reason);
        timer = setTimeout(() => cancel(new CapacityError()), waitMs);
        timer.unref();
        signal?.addEventListener("abort", abort, { once: true });
        waiting.push(waiter);
      });
    },
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

export function capacityResponse(res) {
  return res.set("Retry-After", "1").status(503).json({
    error: "요청이 많습니다. 잠시 후 다시 시도해 주세요.", code: "capacity_exhausted",
  });
}

export function createRequestAdmission(maximum = 200) {
  const budget = createBudget(maximum);
  return (_req, res, next) => {
    let release;
    try { release = budget.acquire(); } catch (error) {
      if (error instanceof CapacityError) return capacityResponse(res);
      throw error;
    }
    const finish = () => {
      release();
      res.removeListener("finish", finish);
      res.removeListener("close", finish);
    };
    res.once("finish", finish);
    res.once("close", finish);
    if (res.writableEnded || res.destroyed) return finish();
    next();
  };
}

export function createResultCache({ maxEntries = 2000, maxPending = 64,
  maxWaiting = 0, waitMs = 30_000,
  maxBytes = 16 * 1024 * 1024, maxEntryBytes = 1024 * 1024, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 0 ||
      !Number.isSafeInteger(waitMs) || waitMs < 1)
    throw new RangeError("invalid cache waiting capacity");
  const budget = maxWaiting
    ? createQueuedBudget({ maximum: maxPending, maxWaiting, waitMs })
    : createBudget(maxPending);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < maxPending + maxWaiting ||
      ![maxBytes, maxEntryBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
      maxEntryBytes > maxBytes)
    throw new RangeError("cache must accommodate pending entries");
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes || 0;
    entries.delete(key);
  };
  return {
    sweep() {
      for (const [key, entry] of entries)
        if (!entry.pending && entry.expires <= now()) remove(key);
    },
    get(key, load, ttlMs) {
      const existing = entries.get(key);
      if (existing?.pending || (existing && existing.expires > now())) return existing.promise;
      if (existing) remove(key);
      this.sweep();
      // Reject before inserting a key or allocating a queued promise. Repeated
      // denied arrivals must not temporarily grow the cache beyond its bound.
      if (budget.active >= maxPending && (budget.waiting || 0) >= maxWaiting)
        throw new CapacityError();
      const oldest = entries.size >= maxEntries
        ? [...entries].find(([, entry]) => !entry.pending) : null;
      if (entries.size >= maxEntries && !oldest) throw new CapacityError();
      // Reserve admission before work. A queued key holds no database/load slot;
      // its promise stays shared, including while waiting past the response TTL.
      const reservation = budget.acquire();
      let release;
      if (oldest) remove(oldest[0]);
      const entry = { pending: true, expires: Infinity, promise: null };
      entry.promise = Promise.resolve(reservation).then(slot => {
        release = slot;
        return load();
      }).then(value => {
        const serialized = JSON.stringify(value);
        const size = serialized === undefined ? 0 : Buffer.byteLength(serialized);
        if (size > maxEntryBytes) {
          remove(key); // Return the full result; only cache admission changes.
          return value;
        }
        while (bytes + size > maxBytes) {
          const oldest = [...entries].find(([, candidate]) => !candidate.pending);
          if (!oldest) break;
          remove(oldest[0]);
        }
        entry.pending = false;
        entry.bytes = size;
        bytes += size;
        entry.expires = now() + ttlMs;
        return value;
      }).catch(error => {
        if (entries.get(key) === entry) remove(key);
        throw error;
      }).finally(() => release?.());
      entries.set(key, entry);
      return entry.promise;
    },
    get size() { return entries.size; },
    get bytes() { return bytes; },
    get pending() { return budget.active; },
    get waiting() { return budget.waiting || 0; },
  };
}

export function createSlidingLimiter({ maximum = 10, windowMs = 60_000,
  maxKeys = 4096, now = Date.now } = {}) {
  if (![maximum, windowMs, maxKeys].every(value => Number.isSafeInteger(value) && value > 0))
    throw new RangeError("invalid rate limit");
  const entries = new Map();
  return key => {
    const current = now();
    const hits = (entries.get(key) || []).filter(time => current - time < windowMs);
    if (hits.length >= maximum) return true; // Never store denied attempts.
    if (!entries.has(key) && entries.size >= maxKeys) {
      for (const [other, times] of entries)
        if (current - times.at(-1) >= windowMs) entries.delete(other);
      if (entries.size >= maxKeys) return true; // Preserve live limits; no eviction bypass.
    }
    hits.push(current);
    entries.set(key, hits);
    return false;
  };
}
