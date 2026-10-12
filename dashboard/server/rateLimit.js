// Per-process admission control. A shared proxy/WAF limit is still required for a fleet.
export function createRateLimiter({ max = 60, windowMs = 60_000, capacity = 4096, now = Date.now } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const time = now();
    const key = req.ip;
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= time) {
      if (buckets.size >= capacity) {
        for (const [ip, value] of buckets) if (value.reset <= time) buckets.delete(ip);
      }
      if (buckets.size >= capacity && !buckets.has(key)) {
        res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ error: "too_many_requests" });
      }
      bucket = { count: 0, reset: time + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.reset - time) / 1000))));
      return res.status(429).json({ error: "too_many_requests" });
    }
    bucket.count++;
    next();
  };
}
