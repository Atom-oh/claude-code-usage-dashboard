import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicAuth from "express-basic-auth";
import * as q from "./queries.js";
import { withProductivityScore } from "./productivity.js";
import { ping } from "./clickhouse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// ponytail: Basic Auth only when creds are set — local dev / cluster-internal probes skip it.
if (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD) {
  app.use(
    "/",
    (req, res, next) => (req.path === "/healthz" ? next() : basicAuth({
      users: { [process.env.BASIC_AUTH_USER]: process.env.BASIC_AUTH_PASSWORD },
      challenge: true,
    })(req, res, next))
  );
}

app.get("/healthz", async (_req, res) => {
  res.json({ ok: await ping().catch(() => false) });
});

function parseRange(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 7 * 86400000);
  return { from, to };
}

// 전역 필터(group/user/model) — 쿼리 파라미터로 안 오면 undefined라 filterCond()가 그냥 건너뛴다.
function parseFilters(req) {
  const { group, user, model } = req.query;
  return { group, user, model };
}

function route(path, handler) {
  app.get(path, async (req, res) => {
    try {
      const { from, to } = parseRange(req);
      res.json(await handler(from, to, req.query, parseFilters(req)));
    } catch (err) {
      console.error(path, err);
      res.status(500).json({ error: err.message });
    }
  });
}

route("/api/overview/kpi", (from, to, _q, filters) => q.kpiSummary(from, to, filters));
route("/api/overview/tokens-timeseries", (from, to, query, filters) => q.tokenTimeseries(from, to, Number(query.intervalHours) || 24, filters));
route("/api/overview/cache-efficiency", (from, to, _q, filters) => q.cacheEfficiency(from, to, filters));
route("/api/overview/model-distribution", (from, to, _q, filters) => q.modelDistribution(from, to, filters));
route("/api/productivity/normalized", (from, to, _q, filters) => q.normalizedProductivity(from, to, filters));
route("/api/productivity/decisions", (from, to, _q, filters) => q.codeEditDecisions(from, to, filters));
route("/api/productivity/active-time", (from, to, query, filters) => q.activeTimeSeries(from, to, Number(query.intervalHours) || 24, filters));
route("/api/usage/tool-mcp", (from, to, _q, filters) => q.toolMcpUsage(from, to, filters));
route("/api/usage/skills", (from, to, _q, filters) => q.skillUsage(from, to, filters));
route("/api/users/leaderboard", async (from, to, _q, filters) => withProductivityScore(await q.userLeaderboard(from, to, filters), from, to));
route("/api/users/tools", (from, to, _q, filters) => q.userToolUsage(from, to, filters));
route("/api/users/skills", (from, to, _q, filters) => q.userSkillUsage(from, to, filters));
route("/api/cost/summary", (from, to, _q, filters) => q.costSummary(from, to, filters));
route("/api/cost/by-model", (from, to, _q, filters) => q.costByModel(from, to, filters));
route("/api/cost/by-user-model", (from, to, _q, filters) => q.costByUserModel(from, to, filters));
route("/api/cost/by-model-daily", (from, to, query, filters) => q.costByModelDaily(from, to, Number(query.intervalHours) || 24, filters));
route("/api/cost/by-model-compare", (from, to, _q, filters) => q.costByModelCompare(from, to, new Date(from.getTime() - (to - from)), filters));
route("/api/usage/connectors", (from, to, _q, filters) => q.mcpConnectorUsage(from, to, filters));
route("/api/productivity/agenticness", (from, to, query, filters) => q.agenticness(from, to, Number(query.intervalHours) || 24, filters));
route("/api/adoption/levels", (from, to, _q, filters) => q.adoptionLevels(from, to, filters));
route("/api/productivity/engagement", (from, to, query, filters) => q.dailyEngagement(from, to, Number(query.intervalHours) || 24, filters));

const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

app.listen(PORT, () => console.log(`dashboard listening on :${PORT}`));
