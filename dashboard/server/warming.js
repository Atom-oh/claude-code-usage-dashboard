const RECENT_MS = 10 * 60_000;

export function createWarmingPlan({ now = Date.now, defaultDays = 2 } = {}) {
  const routes = new Map();
  const used = new Map();
  return {
    register(path, handler) { routes.set(path, handler); },
    requested(path, query = {}) {
      // Filtered/custom windows do not justify warming an unrelated global result.
      if (["user", "userExact", "model", "modelExact", "backend", "project", "email", "group"]
        .some(key => query[key] && query[key] !== "all")) return;
      if (query.from !== undefined || query.to !== undefined) {
        const from = Date.parse(query.from), to = Date.parse(query.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) ||
          to - from !== defaultDays * 86400000 || Math.abs(now() - to) >= RECENT_MS) return;
      }
      if (routes.has(path)) used.set(path, now());
    },
    jobs() {
      const shared = routes.get("/api/clients/overview");
      const jobs = shared ? [
        { path: "/api/clients/overview", handler: shared, params: {} },
        { path: "/api/clients/overview", handler: shared, params: { view: "cost", modelTime: "1", timeFormat: "compact" } },
      ] : [];
      for (const [path, lastUsed] of used) {
        if (now() - lastUsed >= RECENT_MS) { used.delete(path); continue; }
        if (path !== "/api/clients/overview")
          jobs.push({ path, handler: routes.get(path), params: {} });
      }
      return jobs;
    },
  };
}
