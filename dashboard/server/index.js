import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import basicAuth from "express-basic-auth";
import * as q from "./queries.js";
import { withProductivityScore } from "./productivity.js";
import { tierCosts } from "./pricing.js";
import { userCostEfficiency } from "./costEfficiency.js";
import { ping } from "./clickhouse.js";
import { handleChat } from "./chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// CloudFront → NLB → EKS 뒤라 소켓 peer는 항상 프록시 IP다. XFF를 신뢰해야 /api/chat rate limit이
// 클라이언트 단위로 걸린다(안 그러면 전원이 한 버킷에 뭉쳐 오탐 429). ponytail: 클라이언트가 XFF를
// 위조하면 한도를 우회할 수 있으나 이 상한은 인증(basic auth) 뒤의 비용/DoS 안전망이지 인가 경계가 아니다.
app.set("trust proxy", true);

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
// 우리(필터 지원, DAU/WAU/MAU + 고착도, Trends/Executive가 사용) 버전을 채택 — main의
// activeUsersTimeseries(필터 없음, activity.js 순수 함수 롤업)는 반환 shape가 상위집합
// ({t,dau,wau,mau} vs {t,dau,wau,mau,stickiness})이라 Overview.jsx도 그대로 동작한다.
route("/api/adoption/timeseries", (from, to, _q, filters) => q.adoptionTimeseries(from, to, filters));
route("/api/productivity/decisions-by-tool", (from, to, _q, filters) => q.codeEditDecisionsByTool(from, to, filters));
route("/api/productivity/loc-timeseries", (from, to, query, filters) => q.locTimeseries(from, to, Number(query.intervalHours) || 24, filters));
route("/api/cost/tiers", async (from, to, _q, filters) => tierCosts(await q.costByModel(from, to, filters)));
route("/api/users/cost-efficiency", async (from, to, _q, filters) => {
  const [leaderboard, byUserModel] = await Promise.all([q.userLeaderboard(from, to, filters), q.costByUserModel(from, to, filters)]);
  return userCostEfficiency(leaderboard, byUserModel);
});
route("/api/users/daily", (from, to, query) => q.userDaily(from, to, String(query.email || "")));
route("/api/users/decisions-by-tool", (from, to, query) => q.userDecisionsByTool(from, to, String(query.email || "")));
route("/api/users/heatmap", (_from, to, query) => q.userHeatmap(to, String(query.email || "")));

app.post("/api/chat", express.json(), handleChat);

const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

app.listen(PORT, () => console.log(`dashboard listening on :${PORT}`));
