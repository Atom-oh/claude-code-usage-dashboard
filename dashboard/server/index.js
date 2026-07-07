import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicAuth from "express-basic-auth";
import * as q from "./queries.js";
import { withProductivityScore } from "./productivity.js";
import { tierCosts } from "./pricing.js";
import { userCostEfficiency } from "./costEfficiency.js";
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

function route(path, handler) {
  app.get(path, async (req, res) => {
    try {
      const { from, to } = parseRange(req);
      res.json(await handler(from, to, req.query));
    } catch (err) {
      console.error(path, err);
      res.status(500).json({ error: err.message });
    }
  });
}

route("/api/overview/kpi", (from, to) => q.kpiSummary(from, to));
route("/api/overview/tokens-timeseries", (from, to, query) => q.tokenTimeseries(from, to, Number(query.intervalHours) || 24));
route("/api/overview/cache-efficiency", (from, to) => q.cacheEfficiency(from, to));
route("/api/overview/model-distribution", (from, to) => q.modelDistribution(from, to));
route("/api/productivity/normalized", (from, to) => q.normalizedProductivity(from, to));
route("/api/productivity/decisions", (from, to) => q.codeEditDecisions(from, to));
route("/api/productivity/active-time", (from, to, query) => q.activeTimeSeries(from, to, Number(query.intervalHours) || 24));
route("/api/usage/tool-mcp", (from, to) => q.toolMcpUsage(from, to));
route("/api/usage/skills", (from, to) => q.skillUsage(from, to));
route("/api/users/leaderboard", async (from, to) => withProductivityScore(await q.userLeaderboard(from, to), from, to));
route("/api/users/tools", (from, to) => q.userToolUsage(from, to));
route("/api/users/skills", (from, to) => q.userSkillUsage(from, to));
route("/api/cost/summary", (from, to) => q.costSummary(from, to));
route("/api/cost/by-model", (from, to) => q.costByModel(from, to));
route("/api/cost/by-user-model", (from, to) => q.costByUserModel(from, to));
route("/api/cost/by-model-daily", (from, to, query) => q.costByModelDaily(from, to, Number(query.intervalHours) || 24));
route("/api/cost/by-model-compare", (from, to) => q.costByModelCompare(from, to, new Date(from.getTime() - (to - from))));
route("/api/usage/connectors", (from, to) => q.mcpConnectorUsage(from, to));
route("/api/productivity/agenticness", (from, to, query) => q.agenticness(from, to, Number(query.intervalHours) || 24));
route("/api/adoption/levels", (from, to) => q.adoptionLevels(from, to));
route("/api/adoption/timeseries", (from, to) => q.activeUsersTimeseries(from, to));
route("/api/productivity/engagement", (from, to) => q.dailyEngagement(from, to));
route("/api/productivity/loc-timeseries", (from, to, query) => q.locTimeseries(from, to, Number(query.intervalHours) || 24));
route("/api/productivity/decisions-by-tool", (from, to) => q.codeEditDecisionsByTool(from, to));
route("/api/cost/tiers", async (from, to) => tierCosts(await q.costByModel(from, to)));
route("/api/users/cost-efficiency", async (from, to) => userCostEfficiency(await q.userLeaderboard(from, to), await q.costByUserModel(from, to)));

const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

app.listen(PORT, () => console.log(`dashboard listening on :${PORT}`));
