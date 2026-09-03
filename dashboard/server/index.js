import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import basicAuth from "express-basic-auth";
import { ValidationError, parseRange, parseIntervalHours, parseGroupMode, parsePositiveInt } from "./http.js";
import * as q from "./queries.js";
import { withProductivityScore } from "./productivity.js";
import { tierCostsByGroup, pricingConfig } from "./pricing.js";
import { userCostEfficiency } from "./costEfficiency.js";
import { ping, assertReadonlySession } from "./clickhouse.js";
import { probeSegmentAwareSeriesKey, probeMigrations } from "./schema.js";
import { classifyFreshness, probeLatestTelemetryMs, staleAfterMinutes } from "./freshness.js";
import { handleChat, piiMaskEnabled } from "./chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;

// CloudFront(VPC Origin) → 내부 NLB(TCP passthrough) → 파드 구조라 신뢰할 프록시 홉은 딱 1개다.
// CloudFront가 실클라이언트 IP를 X-Forwarded-For에 append하므로 hop=1이면 req.ip가 그 값이 되고,
// 클라이언트가 스스로 prepend한 위조 XFF 엔트리는 무시된다. true(전 홉 신뢰)로 두면 위조 XFF로
// per-IP rate limit(/api/chat)을 우회할 수 있어 홉 수로 고정한다.
app.set("trust proxy", 1);

// ponytail: 인증 env가 없으면 fail-open이 아니라 기동 거부다. 예전에는 BASIC_AUTH_* 중 하나가
// 누락/오타 나면 파드가 모든 /api/*를 무인증으로 서빙하면서 경고 한 줄도 남기지 않았다 —
// 배포가 성공한 것처럼 보이는 게 이 실패 모드의 핵심이다. 무인증 실행(로컬 dev, 클러스터
// 내부 프로브)은 AUTH_ALLOW_INSECURE=1로 명시적으로만 허용한다. 챗의 CHAT_ALLOW_INSECURE와
// 같은 규약이고, 둘은 독립이다: 인증 없이 서버를 띄우는 것과 인증 없이 임의 SELECT를 실행
// 가능한 챗을 켜는 것은 위험이 다르다.
// /healthz(liveness)와 /readyz(readiness)만 무인증 — kubelet은 Authorization 헤더를 붙이지
// 않는다. /api/health/data는 SPA가 부르는 데이터 라우트라 여기 들어가지 않는다: 마지막 수집
// 시각은 운영 정보다.
const AUTH_BYPASS_PATHS = new Set(["/healthz", "/readyz"]);
const authEnabled = !!(process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASSWORD);
const authAllowInsecure = process.env.AUTH_ALLOW_INSECURE === "1";
if (!authEnabled && !authAllowInsecure) {
  console.error(
    "FATAL: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are both required — refusing to start with authentication disabled. " +
      "Set both, or set AUTH_ALLOW_INSECURE=1 to run unauthenticated (local dev / probes only)."
  );
  process.exit(1);
}
if (!authEnabled) {
  console.warn("WARNING: AUTH_ALLOW_INSECURE=1 — every /api/* route is served WITHOUT authentication.");
}

// 조직별 설정 — 잘못된 값은 조용히 기본값으로 접지 않고 기동을 거부한다(위 BASIC_AUTH_* 와
// 같은 규약). DEFAULT_RANGE_DAYS 하나가 서버 warmer가 데우는 창과 parseRange의 기본 구간을
// 동시에 정한다 — 예전에는 그 둘과 RangeContext.jsx의 기본 days가 각자 하드코딩된 2였다.
let GROUP_MODE, DEFAULT_RANGE_DAYS, RANGE_CAP_DAYS;
try {
  GROUP_MODE = parseGroupMode(process.env.GROUP_MODE);
  DEFAULT_RANGE_DAYS = parsePositiveInt(process.env.DEFAULT_RANGE_DAYS, 2);
  RANGE_CAP_DAYS = parsePositiveInt(process.env.RANGE_CAP_DAYS, 90);
  if (RANGE_CAP_DAYS < DEFAULT_RANGE_DAYS) {
    throw new Error(`RANGE_CAP_DAYS (${RANGE_CAP_DAYS}) must be >= DEFAULT_RANGE_DAYS (${DEFAULT_RANGE_DAYS})`);
  }
} catch (err) {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
}
const RANGE_OPTS = { defaultDays: DEFAULT_RANGE_DAYS, capDays: RANGE_CAP_DAYS };

if (authEnabled) {
  app.use(
    "/",
    (req, res, next) => (AUTH_BYPASS_PATHS.has(req.path) ? next() : basicAuth({
      users: { [process.env.BASIC_AUTH_USER]: process.env.BASIC_AUTH_PASSWORD },
      challenge: true,
    })(req, res, next))
  );
}

// /api/* 응답 전체에 no-store. 라우트마다 res.set을 부르던 예전 방식은 route() 래퍼를 거치는
// 라우트만 덮었다 — POST /api/chat과 GET /api/config는 래퍼 밖이라 헤더가 아예 없었다(실측
// 2026-09-03: /api/config 응답에 Cache-Control 없음). 의도된 캐시 계층은 서버 쪽 메모
// 캐시(fetchCached)이고 CloudFront는 이미 CachingDisabled다 — 남은 건 브라우저의 back/forward
// 캐시인데, range picker를 바꾼 뒤 뒤로 가기로 지난 KPI가 그대로 보이면 화면의 숫자와 선택된
// 구간이 어긋난다.
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/healthz", async (_req, res) => {
  res.json({ ok: await ping().catch(() => false) });
});

// SIGTERM 이후 이미 열려 있는 keep-alive 연결로 들어오는 /readyz에 503을 돌려주기 위한 플래그
// (아래 종료 핸들러 참고). server.close()는 새 연결만 거절하고 기존 연결의 요청은 그대로
// 처리하므로, 이 플래그가 없으면 드레인 중인 파드가 {"ready":true}를 계속 답한다(실측 2026-09-02).
let shuttingDown = false;

// k8s readiness. /healthz(liveness)와 의도적으로 다르다: 여기서는 ClickHouse 접속 실패도
// not-ready로 본다(읽을 데이터가 없는 파드에 트래픽을 보낼 이유가 없다). 반대로 liveness를
// 이렇게 만들면 클러스터 장애가 정상 파드를 재시작 루프에 빠뜨린다.
app.get("/readyz", async (_req, res) => {
  const ready = !shuttingDown && (await ping().catch(() => false));
  res.status(ready ? 200 : 503).json({ ready: !!ready });
});

// intervalHours<1(분 버킷)이면 incBucketedRaw가 원본 otel_metrics_sum을 lookback 3일 포함해
// 직접 스캔한다(rollup 최적화 우회) — 서버가 요청 구간 크기를 검증하지 않으면, 인증 사용자가
// from을 오래전으로 잡고 반복 호출해 매번 대형 raw scan을 유발할 수 있다(리뷰에서 MAJOR로
// 확인). 클라이언트(RangeContext의 resolutionForSpan)는 항상 좁은 드래그 줌 구간에만 분 버킷을
// 고르지만, 서버가 그 전제를 강제하지 않는 것 자체가 신뢰 경계 밖 입력을 검증 안 하는 문제 —
// 분 버킷 요청은 이 최대 구간(넉넉히 4시간)을 넘지 못하게 막는다.
const MAX_MINUTE_BUCKET_RANGE_MS = 4 * 3600000;
function clampIntervalHours(intervalHours, from, to) {
  if (intervalHours < 1 && to - from > MAX_MINUTE_BUCKET_RANGE_MS) return 1; // 시간 버킷(rollup)으로 강제
  return intervalHours;
}

// 라우트 6곳이 공유하는 단일 진입점 — 예전에는 각 라우트가 `Number(query.intervalHours) || 24`를
// 직접 써서 0·음수·"abc"가 검증 없이 bucket() SQL까지 그대로 갔다. 검증(parseIntervalHours,
// 실패 시 400)과 분 버킷 구간 상한(clampIntervalHours)을 한 번에 적용한다.
function bucketHours(query, from, to) {
  return clampIntervalHours(parseIntervalHours(query.intervalHours), from, to);
}

// 전역 필터(group/user/model) — 쿼리 파라미터로 안 오면 undefined라 filterCond()가 그냥 건너뛴다.
function parseFilters(query) {
  const { group, user, model } = query;
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
// 화이트리스트(CACHE_KEY_PARAMS, 아래)로 무의미한 파라미터 폭증은 막았지만, from/to/user/model/
// email은 여전히 자유 문자열이라 인증된 클라이언트가 그 값만 계속 바꾸면 만료 전까지 distinct
// 엔트리가 계속 늘 수 있다(리뷰에서 MAJOR로 확인) — 상한을 두고 초과 시 가장 오래된(생성 순서)
// 엔트리부터 제거한다. Map은 삽입 순서를 보존하므로 키를 삭제 후 재삽입하면 자연히 LRU가 된다.
const CACHE_MAX_ENTRIES = 2000; // 워밍 대상(~25개) × 실제 뷰 조합 수 대비 넉넉한 여유치.
const cache = new Map(); // key -> { expires, promise }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
}, CACHE_TTL_MS).unref();

// 스키마 마이그레이션(migration-003) 적용 여부는 가정하지 않고 실측한다 — /api/config는
// 동기 응답을 유지해야 하므로(요청 경로에서 ClickHouse를 만지지 않는다) 부팅 시 한 번 +
// 10분마다 갱신해 최신값만 들고 있는다. 실패는 null로 접혀 경고 문구가 유지된다(fail-safe).
// 같은 10분 주기에 스키마 마이그레이션 원장(claude_code.schema_migrations) 조회도 얹는다.
let segmentAwareSeriesKey = null;
let schemaMigrations = null;
const refreshSchemaProbe = () => {
  probeSegmentAwareSeriesKey().then((v) => {
    segmentAwareSeriesKey = v;
  });
  probeMigrations().then((v) => {
    schemaMigrations = v;
  });
};
refreshSchemaProbe();
setInterval(refreshSchemaProbe, 10 * 60 * 1000).unref();

// 챗 SQL 샌드박스의 전제(계정이 readonly) 실측 — 위 스키마 프로브와 같은 패턴으로 부팅 시
// 한 번 + 10분마다 갱신한다. null(프로브 실패/접속 불가)은 false와 같게 다룬다: 확인되지
// 않은 계정으로 LLM이 만든 SELECT를 실행시키지 않는다(fail-closed). 부팅 직후 프로브가
// 돌아오기 전 잠깐도 챗은 503이다 — 그게 fail-closed의 정의다.
let chatSqlSafe = null;
const refreshReadonlyProbe = () => {
  assertReadonlySession().then((v) => {
    chatSqlSafe = v;
    if (v !== true) console.warn(`chat disabled: ClickHouse session is not confirmed readonly (probe=${String(v)})`);
  });
};
refreshReadonlyProbe();
setInterval(refreshReadonlyProbe, 10 * 60 * 1000).unref();

// 여러 탭이 60초마다 /api/health/data를 폴링하므로(web FreshnessContext.jsx) 원본
// otel_metrics_sum 스캔을 30초 메모로 묶는다 — 스키마 프로브처럼 타이머로 미리 돌리지 않는
// 이유는, 신선도는 "요청 시점" 기준이어야 의미가 있고 10분 지난 스냅샷은 그 자체로 오해라서다.
// probeLatestTelemetryMs는 절대 throw하지 않으므로(freshness.js) 이 promise는 reject되지 않아,
// route()의 캐시처럼 실패를 무효화하는 처리가 필요 없다.
const FRESHNESS_MEMO_MS = 30_000;
let freshnessMemo = { expires: 0, promise: null };
function freshnessSnapshot() {
  if (freshnessMemo.expires < Date.now()) {
    freshnessMemo = {
      expires: Date.now() + FRESHNESS_MEMO_MS,
      promise: probeLatestTelemetryMs().then((latestMs) =>
        classifyFreshness({ latestMs, nowMs: Date.now(), staleAfterMinutes })
      ),
    };
  }
  return freshnessMemo.promise;
}

// 캐시 키는 핸들러가 실제로 읽는 파라미터(from/to/group/user/model/intervalHours/email)만
// 화이트리스트로 넣은 canonical 형태 — 브라우저(useApi의 객체 삽입 순서)와 warmer(아래)가
// 파라미터를 다른 순서로 넣어도 같은 뷰면 같은 키가 나와야 한다.
// 리뷰에서 MAJOR로 확인: 예전엔 req.query 전체를 키에 넣어, 인증된 클라이언트가 핸들러가
// 안 읽는 무의미한 파라미터(?x=1,2,3...)만 바꿔가며 반복 요청하면 매번 새 키로 캐시 미스
// (in-flight dedup 우회) + cache Map이 만료 전까지 무제한으로 커질 수 있었다. 화이트리스트로
// 좁히면 그 파라미터가 뭐든 canonical 키는 유효한 뷰 개수(from×to×filters 조합)만큼만 존재한다.
// includeUnknown이 빠져 있으면 /api/cost/by-user-model을 서로 다른 값으로 부르는 두 소비자
// (Cost 유저 랭킹=기본, Users 계열별 평균=1)가 같은 키를 공유해, 먼저 도착한 쪽의 응답이 다른
// 쪽에 그대로 나간다(실측: 두 요청이 동일 결과를 반환해 확인). warmer는 기본 뷰만 데우므로
// includeUnknown=1 뷰는 첫 조회가 콜드다 — 정확성 우선.
const CACHE_KEY_PARAMS = ["from", "to", "group", "user", "model", "intervalHours", "email", "includeUnknown"];
function cacheKey(path, query) {
  const entries = CACHE_KEY_PARAMS.filter((k) => query[k] !== undefined)
    .sort()
    .map((k) => [k, query[k]]);
  return `${path}?${new URLSearchParams(entries).toString()}`;
}

function fetchCached(path, handler, query, ttlMs = CACHE_TTL_MS) {
  const key = cacheKey(path, query);
  let entry = cache.get(key);
  if (!entry || entry.expires < Date.now()) {
    const { from, to } = parseRange(query, RANGE_OPTS);
    entry = { expires: Date.now() + ttlMs, promise: Promise.resolve(handler(from, to, query, parseFilters(query))) };
    // 상한 초과 시 가장 오래 전에 삽입된 엔트리부터 제거(Map은 삽입 순서 보존 — 첫 키가 가장 오래됨).
    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
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
      // 검증은 fetchCached보다 먼저 — 잘못된 요청이 캐시 엔트리를 만들면 안 된다. 무효한
      // from/to도 예전에는 고유한 캐시 키를 하나씩 차지했다(엔트리 상한을 무의미한 키로
      // 밀어내는 형태).
      parseRange(req.query, RANGE_OPTS);
      parseIntervalHours(req.query.intervalHours);
      res.json(await fetchCached(path, handler, req.query));
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message, detail: err.detail });
        return;
      }
      // 500 본문에는 err.message를 절대 넣지 않는다 — ClickHouse 에러 텍스트에는 실패한
      // 쿼리 SQL이 통째로 실려 있어서, 인증만 통과하면 스키마와 쿼리 구조가 그대로 노출된다.
      // 클라이언트에는 id만 주고, 실제 원인은 파드 로그에서 [id]로 찾는다.
      const id = randomUUID();
      console.error(`[${id}] ${path}`, err);
      res.status(500).json({ error: "internal error", id });
    }
  });
}

// ── 캐시 warmer ──────────────────────────────────────────────────────────
// 기본 뷰(2일·필터 없음·시간 버킷)를 QUANT_MS(현재 120초) 경계마다 서버가 스스로 조회해
// 캐시를 채운다 — 첫 방문자든 새 세션이든 캐시 히트로 즉각 응답한다. 클라이언트(useApi)가
// to를 같은 QUANT_MS 경계로 내림(quantize)하므로 warmer가 만든 키와 문자 그대로 일치한다.
// 기본 창은 DEFAULT_RANGE_DAYS 하나가 정한다 — 서버 warmer와 parseRange의 기본 구간, 그리고
// /api/config를 통해 클라이언트 기본값까지 같은 값에서 나온다(따라다녀야 하는 상수가 더 이상
// 없다).
// 한꺼번에 다 쏘면 ClickHouse 동시성 스파이크가 생기므로(실측 2026-07-10: 두 파드가 부팅 시
// 동시에 9개씩 워밍하자 가장 무거운 leaderboard가 15초 클라이언트 타임아웃) 배치로 나눠
// 분산한다. 실측(2026-07-10, otel_metrics_sum ~9.5M행): 배치 크기 5에서 쿼리 1건이 단독
// 2~4.5초인데 배치 내 5개 동시 실행 시 9~11초로 늘어남(ClickHouse CPU 경쟁) — 배치를 3으로
// 줄여 경쟁을 완화. 한 사이클 ≈ 10배치 × (쿼리 최대 ~9초 + 2초) ≈ 최대 110초(WARM_CYCLE_MAX_MS)
// — QUANT_MS(120초) 창 안에 끝나야 하고, 클라이언트 WARM_GRACE_MS(useApi.js)가 이보다 커야
// 항상 warm-완료 상태를 히트한다. 캐시가 파드 로컬 메모리라 파드마다 각자 데워야 한다(공유
// 불가, 의도된 구조).
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
    from: new Date(toMs - DEFAULT_RANGE_DAYS * 86400000).toISOString(),
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
route("/api/overview/tokens-timeseries", (from, to, query, filters) => q.tokenTimeseries(from, to, bucketHours(query, from, to), filters));
route("/api/overview/cache-efficiency", (from, to, _q, filters) => q.cacheEfficiency(from, to, filters));
route("/api/overview/model-distribution", (from, to, _q, filters) => q.modelDistribution(from, to, filters));
route("/api/productivity/normalized", (from, to, _q, filters) => q.normalizedProductivity(from, to, filters));
route("/api/productivity/decisions", (from, to, _q, filters) => q.codeEditDecisions(from, to, filters));
route("/api/productivity/active-time", (from, to, query, filters) => q.activeTimeSeries(from, to, bucketHours(query, from, to), filters));
route("/api/usage/tool-mcp", (from, to, _q, filters) => q.toolMcpUsage(from, to, filters));
route("/api/usage/tool-decisions", (from, to, _q, filters) => q.toolDecisionFunnel(from, to, filters));
route("/api/usage/skills", (from, to, _q, filters) => q.skillUsage(from, to, filters));
route("/api/users/leaderboard", async (from, to, _q, filters) => withProductivityScore(await q.userLeaderboard(from, to, filters), from, to));
route("/api/users/tools", (from, to, _q, filters) => q.userToolUsage(from, to, filters));
route("/api/users/skills", (from, to, _q, filters) => q.userSkillUsage(from, to, filters));
route("/api/cost/summary", (from, to, _q, filters) => q.costSummary(from, to, filters));
route("/api/cost/by-model", (from, to, _q, filters) => q.costByModel(from, to, filters));
// includeUnknown=1이면 unknown 그룹도 포함한다 — queries.js filterCond의 정책표대로, 이 응답을
// 그룹으로 나누지 않고 통째로 합산하는 "총계" 소비자(Users 페이지의 모델 계열별 사용자당 평균)는
// excludeUnknown:false여야 한다. 기본값(제외)은 A/B 조인 소비자(userCostEfficiency, Cost 페이지의
// 유저 랭킹)를 위해 그대로 둔다 — 그쪽은 group으로 갈라 보는 지표라 unknown을 넣을 자리가 없다.
route("/api/cost/by-user-model", (from, to, query, filters) =>
  q.costByUserModel(from, to, query.includeUnknown === "1" ? { ...filters, excludeUnknown: false } : filters));
route("/api/cost/by-model-daily", (from, to, query, filters) => q.costByModelDaily(from, to, bucketHours(query, from, to), filters));
route("/api/cost/by-model-compare", (from, to, _q, filters) => q.costByModelCompare(from, to, new Date(from.getTime() - (to - from)), filters));
route("/api/usage/connectors", (from, to, _q, filters) => q.mcpConnectorUsage(from, to, filters));
// agenticness는 otel_logs(lookback 없음, 요청 구간만 스캔)를 직접 읽어 다른 rollup 경로들과
// 위협 모델이 다르지만, intervalHours<1(분 버킷) 요청을 검증 없이 받는 건 형제 라우트들과
// 비대칭이라 일관성 차원에서 같은 가드를 적용한다(리뷰에서 MAJOR로 확인).
route("/api/productivity/agenticness", (from, to, query, filters) => q.agenticness(from, to, bucketHours(query, from, to), filters));
route("/api/adoption/levels", (from, to, _q, filters) => q.adoptionLevels(from, to, filters));
route("/api/productivity/engagement", (from, to, query, filters) => q.dailyEngagement(from, to, bucketHours(query, from, to), filters));
// adoptionTimeseries를 채택 — 필터 지원, DAU/WAU/MAU + 고착도를 반환하고 Trends/Executive가
// 이 값을 쓴다. 롤링 윈도우는 queries.js 안에서 자체 계산한다.
route("/api/adoption/timeseries", (from, to, _q, filters) => q.adoptionTimeseries(from, to, filters));
route("/api/productivity/decisions-by-tool", (from, to, _q, filters) => q.codeEditDecisionsByTool(from, to, filters));
route("/api/productivity/loc-timeseries", (from, to, query, filters) => q.locTimeseries(from, to, bucketHours(query, from, to), filters));
route("/api/cost/tiers", async (from, to, _q, filters) => tierCostsByGroup(await q.costByModel(from, to, filters)));
route("/api/users/cost-efficiency", async (from, to, _q, filters) => {
  const [leaderboard, byUserModel] = await Promise.all([q.userLeaderboard(from, to, filters), q.costByUserModel(from, to, filters)]);
  return userCostEfficiency(leaderboard, byUserModel);
});
// email 파라미터 필수(유저 드릴다운) — 기본 뷰가 성립하지 않아 warmer에서 제외.
// group은 옵션 — Users 페이지가 유저×그룹 리더보드 행에서 여는 드로어는 그 행의 group을
// 넘겨 상단 StatTile과 여기 드릴다운의 모수를 맞춘다. 안 넘기면(예: 다른 진입 경로) 유저
// 전체 활동을 보여준다(기존 동작). email과 동일하게 String() 강제 — Express가 ?group=a&group=b
// 를 배열로, ?group[x]=y를 객체로 파싱할 수 있어 raw query 값을 그대로 filterCond에 넘기면
// 안 된다.
const groupParam = (query) => (query.group === undefined ? undefined : String(query.group));
route("/api/users/daily", (from, to, query) => q.userDaily(from, to, String(query.email || ""), groupParam(query)), { warm: false });
route("/api/users/decisions-by-tool", (from, to, query) => q.userDecisionsByTool(from, to, String(query.email || ""), groupParam(query)), { warm: false });
route("/api/users/heatmap", (_from, to, query) => q.userHeatmap(to, String(query.email || ""), 91, groupParam(query)), { warm: false });

// 2026-08-11 스펙 동기화 — STEP 2/3/4 신규 패널. traces beta(권한 대기/TTFT)는 아직 라이브
// 데이터가 없을 수 있어 warm: false(빈 결과를 매 사이클 워밍하는 낭비를 피함) — 데이터가
// 쌓이면 warm: true로 되돌릴 것.
route("/api/productivity/permission-wait", (from, to, _q, filters) => q.permissionWaitOverhead(from, to, filters), { warm: false });
route("/api/productivity/ttft", (from, to, _q, filters) => q.ttftComparison(from, to, filters), { warm: false });
route("/api/productivity/interaction-breakdown", (from, to, _q, filters) => q.interactionBreakdown(from, to, filters), { warm: false });
route("/api/usage/subagent-fanout", (from, to, _q, filters) => q.subagentFanout(from, to, filters));
route("/api/usage/skill-activations", (from, to, _q, filters) => q.skillActivations(from, to, filters));
route("/api/usage/compaction", (from, to, _q, filters) => q.compactionPressure(from, to, filters));
route("/api/reliability/refusals", (from, to, _q, filters) => q.refusalRate(from, to, filters));
route("/api/reliability/retries-exhausted", (from, to, _q, filters) => q.retriesExhausted(from, to, filters));
route("/api/reliability/api-errors", (from, to, _q, filters) => q.apiErrors(from, to, filters));
route("/api/usage/plugins", (from, to) => q.pluginInventory(from, to));
route("/api/integrity/version-cohort-sessions", (from, to, _q, filters) => q.versionCohortSessions(from, to, filters));
route("/api/integrity/version-cohort-cost", (from, to, _q, filters) => q.versionCohortCost(from, to, filters));

// 2026-09-01 추가 패널 — 전부 오늘 실데이터가 있는 소스(metrics/logs)라 기본 warm 대상.
route("/api/productivity/active-time-summary", (from, to, _q, filters) => q.activeTimeSummary(from, to, filters));
route("/api/cost/effort-mix", (from, to, _q, filters) => q.effortMix(from, to, filters));
route("/api/productivity/languages", (from, to, _q, filters) => q.languageBreakdown(from, to, filters));
route("/api/reliability/api-latency", (from, to, _q, filters) => q.apiLatency(from, to, filters));
route("/api/usage/tool-latency", (from, to, _q, filters) => q.toolLatency(from, to, filters));
route("/api/usage/commands", (from, to, _q, filters) => q.commandAdoption(from, to, filters));
route("/api/usage/hook-overhead", (from, to, _q, filters) => q.hookOverhead(from, to, filters));
route("/api/usage/mcp-health", (from, to, _q, filters) => q.mcpHealth(from, to, filters));
route("/api/cost/by-agent", (from, to, _q, filters) => q.agentCost(from, to, filters));

// 챗은 Bedrock 호출 + 임의 read-only SELECT라 다른 데이터 API보다 리스크가 높다. 위의
// AUTH_ALLOW_INSECURE와 같은 규약이지만 플래그는 따로 둔다 — 무인증으로 대시보드를 띄우는
// 것(AUTH_ALLOW_INSECURE)과 그 상태에서 임의 SELECT를 실행하는 챗까지 켜는 것
// (CHAT_ALLOW_INSECURE)은 위험이 다르고, 후자는 언제나 별도 opt-in이어야 한다.
const chatAllowed = authEnabled || process.env.CHAT_ALLOW_INSECURE === "1";
app.post("/api/chat", express.json(), (req, res) => {
  if (!chatAllowed) {
    return res.status(503).json({ error: "챗은 인증(BASIC_AUTH_*) 설정 시에만 활성화됩니다" });
  }
  if (chatSqlSafe !== true) {
    return res.status(503).json({ error: "챗은 ClickHouse 계정이 readonly가 아니면 비활성화됩니다" });
  }
  return handleChat(req, res);
});

// 이메일 마스킹 on/off를 프론트에 런타임으로 알려준다 — 이미지는 한 번만 빌드해 여러 배포에
// 재사용하므로(dashboard/Dockerfile) 빌드타임 VITE_ 변수로는 배포별로 못 바꾼다. ClickHouse도
// 구간 파라미터도 안 쓰므로 route() 래퍼(캐시/range 파싱)를 거치지 않는다.
// 같은 이유로 캐시쓰기 TTL 가정(pricingConfig)도 런타임에 노출한다 — build-once-deploy-many.
app.get("/api/config", (_req, res) =>
  res.json({
    piiMask: piiMaskEnabled,
    pricing: pricingConfig,
    schema: { segmentAwareSeriesKey, migrations: schemaMigrations },
    groupMode: GROUP_MODE,
    defaultRangeDays: DEFAULT_RANGE_DAYS,
    rangeCapDays: RANGE_CAP_DAYS,
  })
);

// /healthz, /api/config에 이어 route() 래퍼를 거치지 않는 세 번째 라우트다 — 구간 파라미터가
// 없고, 상태가 나쁠 때 503을 내려야 하는데 route()는 성공 200 / 에러 500만 낸다.
// stale과 unknown을 같은 503으로 묶는 게 의도다: 측정할 수 없을 때 조용해지면 README
// "Telemetry Ingestion"이 기록한 장애(~43시간 공백을 아무도 몰랐음)를 그대로 재현한다.
app.get("/api/health/data", async (_req, res) => {
  const snapshot = await freshnessSnapshot();
  // 30초 메모는 서버 쪽 캐시다 — 브라우저나 중간 CDN이 이 응답을 더 오래 붙들면 수집 중단이
  // 화면에 늦게 뜬다.
  res.set("Cache-Control", "no-store");
  res.status(snapshot.status === "ok" ? 200 : 503).json(snapshot);
});

const webDist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(webDist));
app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));

const SHUTDOWN_TIMEOUT_MS = 10_000;

// app을 export하고 리스닝은 엔트리 모듈일 때만 — 모듈 로드가 곧 포트 바인딩이면 테스트에서
// import할 수 없어서, route() 래퍼(400/500 매핑·no-store·500 본문에 SQL 안 싣기)가 통째로
// 테스트 불가였다(실측: no-store 한 줄을 지워도 스위트가 그대로 통과). app.test.js가 이걸
// import해 실제 소켓으로 검증한다 — 모듈 스코프의 부작용(인증 fail-closed 검사, 스키마/readonly
// 프로브, 라우트 등록)은 그 import 시점에 그대로 돌아야 하므로 여기 가드 안으로 옮기지 않는다.
export { app };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const server = app.listen(PORT, () => {
    console.log(`dashboard listening on :${PORT}`);
    // 부팅 직후 즉시 한 번 데우고(배포 직후 첫 방문자도 히트), 이후 QUANT_MS 경계마다 반복.
    warmCache().catch((err) => console.error("warmCache(boot)", err));
    scheduleWarmer();
  });

  // k8s 롤링 업데이트에서 SIGTERM은 파드가 Service endpoints에서 빠지기 *전에* 도착한다 —
  // 드레인 중인 파드가 계속 ready라고 답하면 안 되므로 shuttingDown을 세워 /readyz를 503으로
  // 뒤집는다. 단, 플래그와 server.close()는 같은 동기 틱에서 실행되므로 둘의 순서는 의미가 없고
  // (어떤 요청 핸들러도 한쪽만 관측할 수 없다), close()는 리스너를 즉시 닫아 SIGTERM 이후의
  // *새* 연결은 503이 아니라 거절된다(실측 2026-09-02, 열린 연결을 붙든 상태에서 확인). 엔드포인트
  // 제거가 전파될 시간은 이 코드가 아니라 preStop 훅/terminationGracePeriod에서 나와야 한다.
  // 상한 타이머는 keep-alive 소켓이 남아 close() 콜백이 오지 않는 경우의 안전망이고, unref()해서
  // 이 타이머 자체가 정상 종료를 붙들지 않게 한다. 기존 주기 타이머(캐시 스윕, 스키마 프로브,
  // warmer 체인)는 이미 전부 unref()되어 있어 별도 정리가 필요 없다.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`${signal} received — readiness now failing, draining connections`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    });
  }
}
