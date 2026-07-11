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

// CloudFront(VPC Origin) → 내부 NLB(TCP passthrough) → 파드 구조라 신뢰할 프록시 홉은 딱 1개다.
// CloudFront가 실클라이언트 IP를 X-Forwarded-For에 append하므로 hop=1이면 req.ip가 그 값이 되고,
// 클라이언트가 스스로 prepend한 위조 XFF 엔트리는 무시된다. true(전 홉 신뢰)로 두면 위조 XFF로
// per-IP rate limit(/api/chat)을 우회할 수 있어 홉 수로 고정한다.
app.set("trust proxy", 1);

// ponytail: Basic Auth only when creds are set — local dev / cluster-internal probes skip it.
const authEnabled = !!(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD);
if (authEnabled) {
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
  // 기본 2일 — 프론트(RangeContext) 기본값과 정합. 워크샵 기간 기본 뷰.
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 2 * 86400000);
  return { from, to };
}

// 전역 필터(group/user/model) — 쿼리 파라미터로 안 오면 undefined라 filterCond()가 그냥 건너뛴다.
function parseFilters(req) {
  const { group, user, model } = req.query;
  return { group, user, model };
}

// 짧은 TTL 캐시 — otelcol이 10초(OTEL_METRIC_EXPORT_INTERVAL)마다만 export하므로 그보다 촘촘한
// 재요청은 어차피 같은 결과다. 실측(2026-07-10): 페이지 하나가 useApi로 7~9개 API를 동시에 쏘면
// ClickHouse 레플리카가 CPU 경쟁으로 스로틀링돼 응답이 10초 이상으로 늘어짐 — 캐시 히트는 이
// 경쟁 자체를 없애 응답을 거의 즉시로 만든다. 클라이언트(useApi.js)가 to를 QUANT_MS 경계로
// 내림(quantize)하므로 같은 창 안의 모든 세션·유저가 동일한 from/to 문자열을 보내 키가 일치한다
// — 세션 간 캐시 공유 + 아래 warmer가 미리 채운 캐시에 히트하는 전제 조건.
// in-flight dedup: 캐시 미스 상태에서 동시에 들어온 요청들은 ClickHouse에 각자 쏘지 않고 먼저
// 시작된 하나의 Promise를 공유한다 — 동시 요청이 몰리는 순간(여러 유저가 같은 기본 뷰를 열 때)
// 실제 부하 배수를 그만큼 줄인다.
// QUANT_MS는 useApi.js의 QUANT_MS와 반드시 같아야 한다. TTL 산정: 창 T의 엔트리는 warmer가
// T~T+사이클(아래 WARM_CYCLE_MAX_MS 주석 참고) 사이에 만들고, 클라이언트는 grace(useApi
// WARM_GRACE_MS) 뒤부터 창 T를 요청한다 — 최악(T+0에 생성된 엔트리)이 T+grace+QUANT_MS까지
// 살아있어야 하므로 TTL ≥ grace+QUANT_MS, 여유를 둬 320초.
// 실측(2026-07-10): otel_metrics_sum이 하루 ~300만 행씩 늘며 GROUP_CTE+incFlat 풀스캔이
// 단독 2~4.5초, warmer 배치 5개 동시 실행 시 9~11초로 늘어남 — 원래 QUANT_MS=30초/
// WARM_GRACE_MS=35초 산식(쿼리 2~3초 가정)이 깨져 워밍 사이클이 창을 통째로 건너뛰고 있었다
// (Overview가 유독 느리게 느껴진 원인 — 필터 변경/최초 진입마다 그 콜드 창을 그대로 맞음).
// QUANT_MS를 120초로 늘려 창당 여유를 4배로 키움.
const QUANT_MS = 120_000;
const CACHE_TTL_MS = 320_000;
const cache = new Map(); // key -> { expires, promise }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
}, CACHE_TTL_MS).unref();

// 캐시 키는 파라미터를 이름순으로 정렬한 canonical 형태 — 브라우저(useApi의 객체 삽입 순서)와
// warmer(아래)가 파라미터를 다른 순서로 넣어도 같은 뷰면 같은 키가 나와야 한다.
function cacheKey(path, query) {
  const entries = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `${path}?${new URLSearchParams(entries).toString()}`;
}

function fetchCached(path, handler, query, ttlMs = CACHE_TTL_MS) {
  const key = cacheKey(path, query);
  let entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) {
    const req = { query };
    const { from, to } = parseRange(req);
    entry = { expires: Date.now() + ttlMs, promise: Promise.resolve(handler(from, to, query, parseFilters(req))) };
    cache.set(key, entry);
    // 핸들러가 실패하면 그 실패를 캐시하지 않는다 — 다음 요청이 재시도할 수 있어야 한다.
    entry.promise.catch(() => cache.delete(key));
  }
  return entry.promise;
}

// warmer가 순회할 라우트 레지스트리 — warm:false는 필수 파라미터(email 등)가 있어 기본 뷰가
// 성립하지 않는 엔드포인트.
const warmRoutes = [];

function route(path, handler, { warm = true } = {}) {
  if (warm) warmRoutes.push({ path, handler });
  app.get(path, async (req, res) => {
    try {
      res.json(await fetchCached(path, handler, req.query));
    } catch (err) {
      console.error(path, err);
      res.status(500).json({ error: err.message });
    }
  });
}

// ── 캐시 warmer ──────────────────────────────────────────────────────────
// 기본 뷰(2일·필터 없음·시간 버킷)를 QUANT_MS(30초) 경계마다 서버가 스스로 조회해 캐시를
// 채운다 — 첫 방문자든 새 세션이든 캐시 히트로 즉각 응답한다. 클라이언트(useApi)가 to를 같은
// 30초 경계로 내림(quantize)하므로 warmer가 만든 키와 문자 그대로 일치한다. 워크샵 기본값이
// 바뀌면 WARM_DAYS와 RangeContext.jsx의 기본 days를 같이 바꿔야 한다.
// 한꺼번에 다 쏘면 ClickHouse 동시성 스파이크가 생기므로(실측 2026-07-10: 두 파드가 부팅 시
// 동시에 9개씩 워밍하자 가장 무거운 leaderboard가 15초 클라이언트 타임아웃) 배치로 나눠
// 분산한다. 실측(2026-07-10, otel_metrics_sum ~9.5M행): 배치 크기 5에서 쿼리 1건이 단독
// 2~4.5초인데 배치 내 5개 동시 실행 시 9~11초로 늘어남(ClickHouse CPU 경쟁) — 배치를 3으로
// 줄여 경쟁을 완화. 한 사이클 ≈ 10배치 × (쿼리 최대 ~9초 + 2초) ≈ 최대 110초(WARM_CYCLE_MAX_MS)
// — QUANT_MS(120초) 창 안에 끝나야 하고, 클라이언트 WARM_GRACE_MS(useApi.js)가 이보다 커야
// 항상 warm-완료 상태를 히트한다. 캐시가 파드 로컬 메모리라 파드마다 각자 데워야 한다(공유
// 불가, 의도된 구조).
const WARM_DAYS = 2;
const WARM_BATCH = 3;
const WARM_BATCH_GAP_MS = 2_000;

async function warmCache() {
  // grace 없이 "지금 이 순간의 경계"를 데운다 — grace는 클라이언트(useApi.js)에만 있다.
  // 타이밍 근거: warmer는 이 함수가 불린 시각 T(항상 QUANT_MS 배수)에 창 T를 만들기 시작해,
  // 배치 진행에 최대 WARM_CYCLE_MAX_MS(아래)까지 걸려 T+WARM_CYCLE_MAX_MS 이내에 끝낸다.
  // 클라이언트는 창 W를 W+WARM_GRACE_MS 시점부터 요청한다(useApi.js) — WARM_GRACE_MS가
  // WARM_CYCLE_MAX_MS보다 크면 클라이언트가 요청을 시작하는 시점엔 항상 이미 다 데워져 있다.
  // (실측 2026-07-10: 이전 버전은 여기서도 grace를 빼 warmer가 "한 창 전"을 데우는 꼴이 돼
  // 클라이언트가 요청하는 창과 영원히 어긋났다 — grace는 한쪽에서만 적용해야 한다.)
  const toMs = Math.floor(Date.now() / QUANT_MS) * QUANT_MS;
  const query = {
    from: new Date(toMs - WARM_DAYS * 86400000).toISOString(),
    to: new Date(toMs).toISOString(),
    intervalHours: "1", // days<=2일 때 프론트가 보내는 값과 동일(문자열 — URLSearchParams 정합)
  };
  for (let i = 0; i < warmRoutes.length; i += WARM_BATCH) {
    await Promise.allSettled(
      warmRoutes.slice(i, i + WARM_BATCH).map(({ path, handler }) =>
        fetchCached(path, handler, query).catch((err) => console.error("warm", path, err.message))
      )
    );
    if (i + WARM_BATCH < warmRoutes.length) await new Promise((r) => setTimeout(r, WARM_BATCH_GAP_MS));
  }
}

function scheduleWarmer() {
  // setInterval 대신 경계 정렬 setTimeout 체인 — 매번 "다음 QUANT_MS 경계"에 정확히 맞춰
  // 실행한다(interval 드리프트 방지) — warmCache()가 Date.now()로 창을 계산하므로 이 타이밍이
  // 맞아야 항상 "막 지난 경계"를 데운다.
  const delay = QUANT_MS - (Date.now() % QUANT_MS);
  setTimeout(async () => {
    await warmCache().catch((err) => console.error("warmCache", err));
    scheduleWarmer();
  }, delay).unref();
}

route("/api/overview/kpi", (from, to, _q, filters) => q.kpiSummary(from, to, filters));
route("/api/overview/active-users", (from, to, _q, filters) => q.activeUsers(from, to, filters));
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
// email 파라미터 필수(유저 드릴다운) — 기본 뷰가 성립하지 않아 warmer에서 제외.
route("/api/users/daily", (from, to, query) => q.userDaily(from, to, String(query.email || "")), { warm: false });
route("/api/users/decisions-by-tool", (from, to, query) => q.userDecisionsByTool(from, to, String(query.email || "")), { warm: false });
route("/api/users/heatmap", (_from, to, query) => q.userHeatmap(to, String(query.email || "")), { warm: false });

// 챗은 Bedrock 호출 + 임의 read-only SELECT라 다른 데이터 API보다 리스크가 높다. auth env가
// 없으면 fail-open이 아니라 fail-closed — 명시적으로 CHAT_ALLOW_INSECURE=1을 켠 로컬 dev에서만 무인증 허용.
const chatAllowed = authEnabled || process.env.CHAT_ALLOW_INSECURE === "1";
app.post(
  "/api/chat",
  express.json(),
  chatAllowed ? handleChat : (_req, res) => res.status(503).json({ error: "챗은 인증(BASIC_AUTH_*) 설정 시에만 활성화됩니다" })
);

const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

app.listen(PORT, () => {
  console.log(`dashboard listening on :${PORT}`);
  // 부팅 직후 즉시 한 번 데우고(배포 직후 첫 방문자도 히트), 이후 15초 경계마다 반복.
  warmCache().catch((err) => console.error("warmCache(boot)", err));
  scheduleWarmer();
});
