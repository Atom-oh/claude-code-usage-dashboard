import { query, toChDateTime } from "./clickhouse.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { withComputedCost, normalizeModelId, rollupComputedCost } from "./pricing.js";
import { rollupAdoption } from "./activity.js";

// 원본: ../grafana-ab-queries.sql 의 10개 패널을 그대로 이식했다. ExperimentGroup(env 기반) 컬럼
// 대신 grouping.js의 텔레메트리 자동판별(GROUP_CTE)로 그룹을 계산한다는 점만 다르다.

// to가 "지금"(기본 실시간 뷰)에 가까우면 그대로 두고, 과거의 임의 시각(드래그 줌·히스토리컬
// 커스텀 구간)이면 정각(toStartOfHour)으로 내린다. incFlat/incBucketed의 `hour < {to:DateTime}`가
// to가 정각이 아니면 그 hour 버킷 전체(최대 59분)를 포함해 과대집계하는데(리뷰에서 MAJOR로
// 확인), 이건 "임의 과거 to"를 만드는 드래그 줌이 이 PR에서 새로 생긴 뒤로 실제 문제가 됐다.
// 반대로 to=현재인 기본 뷰에서 정각으로 내리면 매번 최대 59분의 최신 데이터가 사라지는 회귀가
// 더 크므로, 그 경우는 그대로 둔다. 10분 여유는 useApi의 quantize grace(150초)보다 넉넉해
// 실시간 뷰를 절대 과거로 오판하지 않는다.
//
// from은 정렬하지 않는다 — from까지 toStartOfHour로 내리면, 분 단위 드래그 줌처럼 from/to가
// 같은 시간(hour) 안에 있는 짧은 과거 구간(예: 10:15~10:45)에서 to만 정각(10:00)으로 내려가
// from(10:15)보다 작아져 range가 역전되고 빈 결과가 나온다(리뷰에서 CRITICAL로 확인 — 이 PR의
// 핵심 신기능인 분 단위 드래그 줌이 "1시간 미만 과거 구간 확대"에서 통째로 깨지는 회귀였다).
// alignHistoricalTo(to)가 from보다 앞서거나 "같으면"(=from이 정각인 경우까지 포함) 정렬을
// 포기하고 원본 to를 쓴다 — `aligned < from`만 검사하면 from=10:00(정각)/to=10:45에서
// aligned=10:00이 from과 같아 통과해버려 [10:00,10:00) 빈 창이 되는 경계 케이스를 놓친다
// (리뷰에서 MAJOR로 재확인). 이 좁은 구간에서는 어차피 hour 버킷 부분-포함 오차가 구간
// 자체보다 크므로, 애초에 rollup(hour 그레인)이 아니라 원본 폴백(incBucketedRaw)이 담당해야
// 할 스케일이다.
const LIVE_TOLERANCE_MS = 10 * 60000;
export function alignHistoricalTo(to) {
  const isLive = Date.now() - to.getTime() < LIVE_TOLERANCE_MS;
  return isLive ? to : new Date(Math.floor(to.getTime() / 3600000) * 3600000);
}

// raw=true(분 버킷, incBucketedRaw 경로)면 hour 정렬을 아예 적용하지 않는다 — incBucketedRaw는
// TimeUnix(원본, 나노초 정밀도)로 경계를 직접 계산해 부분-hour 과대집계 문제 자체가 없다.
// 정렬이 오히려 해가 된다: 과거 2.5시간 같은 드래그 줌(raw 경로가 허용하는 범위, 리뷰에서
// MAJOR로 확인)에서 to를 정각으로 내리면 선택한 마지막 최대 59분이 통째로 사라진다.
export function range(from, to, raw = false) {
  if (raw) return { from: toChDateTime(from), to: toChDateTime(to) };
  const aligned = alignHistoricalTo(to);
  return { from: toChDateTime(from), to: toChDateTime(aligned <= from ? to : aligned) };
}

// us.anthropic.claude-fable-5 / global.anthropic.claude-fable-5 / claude-fable-5[1m] 등은 같은
// 모델의 변형일 뿐이라(리전 라우팅·컨텍스트 윈도우는 사용자가 고르는 게 아니라 Bedrock/Claude Code가
// 자동으로 붙임) 모델 분포/비용 집계에서는 하나로 합친다. pricing.js normalizeModelId()와 동일한
// 5단계 규칙의 SQL 버전 — 표시용 모델명도 단가표 키와 같은 형태로 통일한다.
// chat.js의 SYSTEM 프롬프트도 이 함수의 결과를 그대로 인용한다(PRICING_PROMPT_TABLE과 같은 이유):
// 챗이 산문 설명을 보고 즉흥적으로 정규화하면 단가표 키와 어긋나 계산 비용이 대시보드와 발산한다.
export function normModel(col) {
  const strip = (expr, pattern) => `replaceRegexpOne(${expr}, '${pattern}', '')`;
  let expr = col;
  expr = strip(expr, "\\\\[.*\\\\]$"); // [1m] 컨텍스트 윈도우 접미사
  expr = strip(expr, "^(us|us-gov|eu|apac|jp|au|global)\\\\."); // cross-region 추론 프로파일 접두사
  expr = strip(expr, "^anthropic\\\\."); // bedrock provider 접두사
  expr = strip(expr, "-v\\\\d+(:\\\\d+)?$"); // bedrock 버전 접미사 -v1:0 / -v1
  expr = strip(expr, "-\\\\d{8}$"); // 날짜 스냅샷 접미사 -20250929
  return expr;
}

// projectBreakdown이 ProjectName='' 행에 붙이는 표시용 라벨. filterCond의 project 분기가 같은
// 문자열을 ''로 되돌린다 — 표에서 값을 그대로 복사해 필터에 넣어도 0행이 되지 않게 하는 왕복
// 보정이라 두 곳이 같은 상수를 봐야 한다.
export const UNTAGGED_PROJECT = "(untagged)";

// 대시보드 전역 필터(group/user/model) — 미지정이면 전부 통과. group은 정확매치(bedrock/enterprise/
// unknown), user/model은 부분일치(대소문자 무시)로 좁힌다. cols는 쿼리마다 실제 참조 가능한 컬럼/식을
// 넘긴다(alias가 함수마다 다르고, 로그 테이블엔 Model이 없어 model 필터가 적용 안 되는 경우도 있음).
// ponytail: model 필터는 Model attribute가 없는 지표(session.count 등)에는 매치가 안 돼 그 지표가
// 0으로 빠진다 — 세션/커밋처럼 모델 귀속이 없는 값과 model 필터를 같이 켜면 생기는 알려진 트레이드오프.
export function filterCond(filters = {}, cols = {}) {
  const conds = [];
  const params = {};
  // 저장된 Model은 normModel()로 정규화된 값과 비교하므로, 검색어도 같이 정규화한다 —
  // 안 그러면 유저가 raw Bedrock ID("global.anthropic.claude-sonnet-5")로 검색할 때
  // 정규화된 저장값("claude-sonnet-5")과 접두사가 어긋나 매치가 빗나간다.
  const fModel = filters.model ? normalizeModelId(filters.model) : filters.model;
  // unknown(모델/organization.id 신호가 전혀 없는 세션 — 실측 2026-07-09: 44세션 중 5개, ~11%)은
  // bedrock/enterprise 어느 쪽으로도 판별 불가능해 A/B 비교에 노이즈만 더한다 — group 필터를 받는
  // 쿼리에서는 기본적으로 무조건 제외한다(사용자가 group 필터를 안 걸어도).
  // 단, "총계" 지표(activeUsers/adoptionLevels — A/B 비교가 아니라 전체 유저/DAU/MAU 스냅샷)는
  // excludeUnknown: false로 unknown 세션도 포함해야 한다 — 안 그러면 그룹 무관 총계에서도
  // ~11%가 조용히 빠져 "전체 유저 수"가 실제보다 작게 나온다(리뷰에서 MAJOR로 확인).
  //
  // 정책 정리(리뷰 제안 #6 — A/B 지표 vs 총계 지표를 excludeUnknown 기준으로 표로 명시):
  //   - excludeUnknown: false(unknown 포함) — activeUsers, adoptionLevels,
  //     adoptionTimeseries, userLeaderboard의 active_days CTE, kpiSummary, costSummary(및 동일
  //     패턴의 cost 계열). kpiSummary/costSummary는 GROUP BY grp로 그룹별 비교도 같이 보여주지만,
  //     응답 전체를 합산하는 소비자(Executive.jsx의 총 지출/토큰, costPerDev)가 있어 activeUsers와
  //     같은 모수를 쓰도록 통일했다 — 안 그러면 분자(cost, unknown 제외)·분모(users, unknown
  //     포함)가 어긋난다(리뷰에서 MAJOR로 확인).
  //   - excludeUnknown 기본값(true, unknown 제외) — 그 외 순수 A/B 비교 쿼리(모델별 지출,
  //     캐시 효율 등 group으로만 나눠 보고 총계로는 안 쓰는 지표). unknown은 어느 쪽에도
  //     못 넣으므로 A/B 비교에서는 계속 제외한다.
  // filters.group==='unknown'이면 기본 제외를 건너뛴다 — 안 그러면 `grp != 'unknown' AND
  // grp = 'unknown'`이 되어 항상 빈 결과가 된다. 지금 UI(FilterBar)는 unknown 탭이 없어
  // 실질적으로 발생하지 않지만, API를 직접 호출하는 경로에 대한 방어(리뷰에서 확인).
  if (cols.group && filters.excludeUnknown !== false && filters.group !== "unknown") conds.push(`${cols.group} != 'unknown'`);
  if (filters.group && cols.group) {
    conds.push(`${cols.group} = {fGroup:String}`);
    params.fGroup = filters.group;
  }
  if (filters.user && cols.user) {
    conds.push(`positionCaseInsensitive(${cols.user}, {fUser:String}) > 0`);
    params.fUser = filters.user;
  }
  // 유저 드릴다운(드로어) 전용 — 부분일치면 kim@x.com 드로어에 joakim@x.com 데이터가 섞인다.
  if (filters.userExact && cols.user) {
    conds.push(`${cols.user} = {fUser:String}`);
    params.fUser = filters.userExact;
  }
  if (filters.model && cols.model) {
    conds.push(`positionCaseInsensitive(${normModel(cols.model)}, {fModel:String}) > 0`);
    params.fModel = fModel;
  }
  // 서브쿼리에서 이미 normModel()로 정규화된 alias를 참조할 때 — normModel 이중 적용을 피한다.
  if (filters.model && cols.modelNorm) {
    conds.push(`positionCaseInsensitive(${cols.modelNorm}, {fModel:String}) > 0`);
    params.fModel = fModel;
  }
  // 혼합 지표 쿼리(kpiSummary 등)용 — session/commit/PR 행은 Model attribute가 비어 있어
  // row-level 매치만 쓰면 model 필터를 켜는 순간 그 지표들이 전부 0으로 떨어진다.
  // Model이 있는 행(토큰/비용)은 정밀 매치, 없는 행은 세션 세미조인으로 통과시킨다.
  if (filters.model && cols.modelMixed) {
    const { model, session } = cols.modelMixed;
    conds.push(`(positionCaseInsensitive(${normModel(model)}, {fModel:String}) > 0
      OR (${model} = '' AND ${session} IN (
        SELECT SessionId FROM claude_code.otel_metrics_sum_hourly
        WHERE SessionId != '' AND hour >= toStartOfHour({from:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
          AND positionCaseInsensitive(${normModel("Model")}, {fModel:String}) > 0)))`);
    params.fModel = fModel;
  }
  // 로그 테이블(otel_logs)엔 Model이 없다 — 세션이 실제로 쓴 모델을 otel_metrics_sum에서
  // 찾아 세미조인. 의미론: "세션이 이 모델을 한 번이라도 썼으면 그 세션의 로그 이벤트 전부 통과".
  // 세션 내 모델 전환이 드물어 필터 용도로는 이 근사가 충분(이벤트 단위 정밀 귀속은 api_request
  // 조인이 필요한데, 필터링만 할 땐 오버킬).
  if (filters.model && cols.modelViaSession) {
    conds.push(`${cols.modelViaSession} IN (
      SELECT SessionId FROM claude_code.otel_metrics_sum_hourly
      WHERE SessionId != '' AND hour >= toStartOfHour({from:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
        AND positionCaseInsensitive(${normModel("Model")}, {fModel:String}) > 0)`);
    params.fModel = fModel;
  }
  // 프로젝트 필터(005의 ProjectName 컬럼) — LowCardinality(String)이라 정확 일치다. user/model과
  // 달리 부분일치를 쓰지 않는 이유: 저장소 이름은 사용자가 표의 프로젝트 열에서 그대로 복사해
  // 넣는 값이고, 부분일치면 'api'가 'api'와 'api-gateway'를 함께 잡아 프로젝트별 비교 자체가
  // 무의미해진다. cols.project를 안 넘기는 쿼리에는 그냥 적용되지 않는다. 컬럼이 아예 없는
  // 클러스터에서 이 조건이 SQL 오류를 내는 것은 http.js의 parseFilters가 projectColumns !== true
  // 일 때 project를 버려서 막는다(400이 아니라 무시 — 기존 필터 무시 정책과 동일).
  if (filters.project && cols.project) {
    conds.push(`${cols.project} = {fProject:String}`);
    params.fProject = filters.project === UNTAGGED_PROJECT ? "" : filters.project;
  }
  return { where: conds.map((c) => `AND ${c}`).join(" "), params };
}

// OTel AggregationTemporality: UNSPECIFIED=0, DELTA=1, CUMULATIVE=2. Claude Code는 세션(session.id)
// 단위로 "지금까지 합계"를 30초마다 export한다(운영 설정: cumulative). cumulative 행을 그대로
// sum(Value)하면 세션이 길수록 같은 총합이 배수로 다시 더해져 토큰/비용/세션 수가 천문학적으로
// 과대집계된다(실측: 토큰 총합이 1600억까지 나온 사례). 정답은 세션별로 "구간 끝 누적값 - 구간
// 시작 직전 누적값"만 diff하는 것 — Prometheus increase()가 하는 일과 같다. resume/헬퍼
// 프로세스는 같은 session.id를 유지한 채 카운터를 재시작한다(실측 2026-09-02) — 리셋 경계는
// session.id가 아니라 SeriesKey가 나른다(StartTimeUnix를 접어 넣음, clickhouse-migration-003.sql
// / ADR-003). 그래서 diff 쪽에 별도 드롭 감지가 여전히 필요 없고(방어적으로 greatest(diff, 0)만
// 둔다). delta
// 데이터(레거시 배포/구 seed)는 그냥 구간 sumIf면 되므로, 아래 두 헬퍼가 temporality별로 알맞은
// 계산을 세션 단위로 미리 접어(inc subquery) 기존 쿼리들이 원본과 똑같은
// sumIf(m.Value, m.MetricName = ...) 모양을 그대로 쓰게 한다.
const LOOKBACK_DAYS = 3; // from 이전에 시작한 세션의 diff baseline을 찾기 위한 조회 확장분.
// 세션이 이보다 오래 지속되면 그 이전 구간은 baseline 유실로 과대집계될 수 있다(허용된 트레이드오프).

// 진짜 OTel 시리즈 식별자 — 승격 컬럼(Model/TokenType/Decision/SkillName)만으로는 부족하다.
// 실측(2026-07-07): token.usage 데이터포인트에는 agent.name(서브에이전트)/effort/query_source/
// plugin.name 등 승격되지 않은 attribute도 실려 있어, 이걸 무시하고 SessionId+승격컬럼만으로
// GROUP BY하면 서로 다른 누적 스트림이 한 키에 섞여 max()가 작은 스트림을 잃는다(실측: 같은 키
// 안에서 Value가 줄어드는 지점이 세션당 수백~수천 회, 전체 토큰 5% 과소집계). Attributes 맵
// 전체를 해시한 값이 진짜 시리즈 키 — 이 키로 파티션하면 전부 단조 증가(drops=0)임을 확인했다.
// 실측(2026-07-10): 이 해시(cityHash64(toString(Attributes)))를 매 쿼리마다 인라인으로 계산하면
// 420만 row 스캔 기준 1.2초 중 대부분(1.9GB 문자열 직렬화)을 차지해 페이지 하나가 useApi로
// 7~9개 요청을 동시에 쏘면 ClickHouse CPU 경쟁까지 겹쳐 개별 쿼리가 10초 이상으로 늘어졌다.
// otel_metrics_sum에 SeriesKey UInt64 MATERIALIZED cityHash64(toString(Attributes)) 컬럼을
// 추가(clickhouse-schema.sql 참조)해 INSERT 시점에 한 번만 계산하도록 옮기니 같은 쿼리가
// 0.11초로 줄었다(11배) — 인라인 계산과 값이 100% 일치함을 확인(mismatch=0).
// SeriesKey는 이제 프로세스 세그먼트 단위(StartTimeUnix까지 해시에 포함, clickhouse-migration-003.sql
// / ADR-003) — session.count만 예외로 세그먼트 구분 없이 세션당 하나의 키를 유지한다.
const seriesKey = "SeriesKey";

// 세션(SessionId) × temporality × 속성 단위로 구간 증가량을 미리 계산하는 서브쿼리. 결과 컬럼명을
// 원본 테이블과 동일하게(Value/MetricName/Model/...) 맞춰서, 기존 sumIf(m.Value, ...) 패턴을 건드리지
// 않고 FROM만 이 서브쿼리로 바꿔 끼울 수 있게 한다.
//
// 원본이 아니라 시간별 rollup(otel_metrics_sum_hourly, clickhouse-schema.sql)을 읽는다.
// 근거(실측 2026-07-10): 살아있는 세션이 10초마다 전 시리즈를 재-export해 원본이 3일 만에
// 9.5M행(+3M행/일) — 원본 스캔 쿼리가 단독 2~4.5초, 동시 실행 시 9~11초까지 갔다. 누적 카운터는
// 버킷당 "버킷 종료 시점 누적값"(max_value)만 있으면 경계 diff가 가능하므로 시간별로 접은
// rollup(~86x 작음)으로 충분하다. 경계 baseline은 toStartOfHour({from})으로 정렬해 정확하게
// 만든다(창이 [정각(from), to)로 최대 59분 넓어지는 대신 부분-버킷 오차가 없다). to 쪽 부분
// 버킷은 to~현재(quantize 유예 ~2.5분)의 증가분까지 포함 — 더 신선할 뿐 해롭지 않다.
//
// lookback을 rollup에서도 유지하는 이유: 스캔을 무제한(hour < to)으로 열면 diff 수식은 오히려
// 더 정확해지지만(3일 초과 세션 baseline 보존), incFlat 출력 행의 "존재" 자체를 세는 소비자들
// (kpiSummary의 uniqExactIf(UserEmail...), skillUsage의 count())이 창과 무관한 전 기간
// 세션·유저까지 세게 된다 — 원본과 동일한 lookback 창을 유지해 기존 의미론을 그대로 보존한다.
// ToolName은 rollup에 실컬럼으로 접혀 있다(code_edit_tool.decision의 tool_name).
//
// to를 정각으로 내리지 않는 이유(리뷰에서 hour 경계 스큐로 지적된 지점 — 검토 후 현재
// 형태 유지가 맞다고 판단): to가 과거의 임의 시각(드래그 줌 등)이면 그 hour 버킷 전체(최대
// 59분)가 포함돼 과대집계될 수 있다 — 이건 실재하는 오차다. 하지만 to=현재(기본 뷰, 압도적
// 다수 케이스)인 경우 그 hour는 아직 채워지는 중이라 "지금까지 들어온 데이터"만 있어 과대집계가
// 아니라 단지 신선하다. costByModelCompare(vs. "이전 기간" 비교, 신선도보다 두 구간의 정합성이
// 목적)와 달리 이 함수는 기본 뷰 KPI 카드의 실시간성이 핵심 요구사항이라, to를 정각으로 내리면
// 기본 뷰에서 매번 최대 59분의 최신 데이터가 사라지는 회귀가 더 크다 — 과거/커스텀 구간의 경계
// 오차(최대 59분)를 감내하는 쪽을 선택한다.
//
// span(from,to 사이)이 짧으면(sub-hour/수시간 드래그 줌) 위 트레이드오프의 전제 자체가
// 깨진다 — hour < to의 "신선도" 이점은 사라지고, toStartOfHour(from)이 왼쪽 경계까지 최대
// 59분 넓혀 KPI 스냅샷(incFlat)이 같은 화면의 시계열보다 큰 값을 보이는 불일치가 된다(리뷰에서
// MAJOR로 확인). 이 좁은 구간에서는 원본 테이블로 직접 diff하는 게 정확하고(rollup 최적화가
// 필요한 스케일도 아님) incBucketedRaw와 동일한 sk/lookback 규칙을 따른다.
//
// 임계값을 1시간이 아니라 index.js MAX_MINUTE_BUCKET_RANGE_MS(4시간)와 맞춘다 — 프론트
// resolutionForSpan이 분 버킷(intervalHours<1)을 고르는 구간(최대 4시간)과 정확히 겹쳐야
// 같은 화면의 timeseries(incBucketedRaw, 이 구간에서 원본을 씀)와 스냅샷(incFlat)이 항상
// 같은 소스 테이블·같은 경계를 본다(리뷰에서 재확인 — 1시간 임계는 1~4시간 구간에서
// 여전히 어긋났다). raw=true를 반환해 호출부가 range(from, to, raw)에 그대로 넘기게 한다 —
// SQL의 {from}/{to} 바인딩 자체가 정렬되면 raw 분기가 무의미해지므로(리뷰에서 CONFIRMED),
// incFlat과 range()가 반드시 같은 raw 판정을 공유해야 한다.
const MAX_SNAPSHOT_RAW_RANGE_MS = 4 * 3600000;
// index.js clampIntervalHours는 `to - from > 4h`일 때만 클램프(정확히 4h는 raw 허용) — 여기서
// `<`를 쓰면 정확히 4h(1시간 버킷 4개짜리 드래그 등으로 실제 생성 가능)에서 시계열은 raw인데
// 스냅샷은 rollup을 보는 off-by-one이 재발한다(리뷰에서 확인). `<=`로 맞춘다.
export function incFlatRaw(spanMs) {
  return spanMs <= MAX_SNAPSHOT_RAW_RANGE_MS;
}
export function incFlat(metricFilter = "", spanMs = Infinity) {
  if (incFlatRaw(spanMs)) {
    // ToolName은 rollup에서만 실컬럼(code_edit_tool.decision의 tool_name을 접어놓음) — 원본
    // otel_metrics_sum에는 없어서 그대로 SELECT하면 "Unknown expression identifier"로 쿼리가
    // 깨진다(실측 확인). Attributes['tool_name']에서 직접 뽑아 같은 별칭으로 맞춘다.
    return `(
      SELECT
          SessionId, AggregationTemporality AS temp, UserEmail, MetricName, Model, TokenType, Decision, SkillName,
          Attributes['tool_name'] AS ToolName,
          if(temp = 2,
              greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
              sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS Value
      FROM claude_code.otel_metrics_sum
      WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
        ${metricFilter}
      GROUP BY ${seriesKey}, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName
    )`;
  }
  // cumulative(temp=2) baseline의 hour 경계 처리 — 세 가지 접근을 실측으로 검증했다. hour는
  // "그 버킷 종료 시점" 누적값이라 어느 쪽으로 근사해도 오차가 생긴다:
  //   - `hour < toStartOfHour(from)`(원래 방식): baseline이 너무 작아짐 → diff 과대집계.
  //   - `hour < from`(라운드 9): baseline이 너무 커짐(from-hour 종료 시점 값) → diff 과소집계.
  //   - UNION ALL로 from-hour rollup 행을 raw stitch로 "대체"(라운드 10): current 쪽도 그
  //     대체된(pre-from만 담은) 행을 보게 되어, 세션이 from-hour 안에서만 성장하고 그 뒤 rollup
  //     행이 아직 없으면 post-from 성장분이 baseline과 current 양쪽에서 사라져 diff가 0으로
  //     소실된다(리뷰에서 MAJOR로 재확인 — 대체가 아니라 보정이어야 했다).
  // 정확한 해법: 원본 rollup 행은 그대로 두고(current=maxIf(max_value, hour<to)는 항상 정확 —
  // to가 속한 hour까지의 실제 상태를 담고 있음), baseline만 raw로 보정한다:
  // `greatest(rollup의 이전 hour까지 max, raw로 구한 정확한 from 시점 값)`. 라이브 클러스터로
  // 두 시나리오(to가 다음 hour/같은 hour) 모두 정확한 diff(27,066)가 나옴을 확인했다.
  //
  // delta(temp=1)는 sum이라 이 방식이 안 통한다 — sub-hour 분해가 필요하므로 from-hour의
  // sum_value를 통째로 raw의 [from, hour 끝) 재계산값으로 교체한다(원본 hour 자체를 지우고
  // 그 구간만 다시 합산 — cumulative처럼 "이전 값과 비교"가 아니라 "그 구간의 합"이라 교체가
  // 정확하다. from-hour 이전/이후 다른 hour는 그대로).
  //
  // incBucketed(시계열)도 처음엔 같은 종류의 결함이 있었다 — 버킷 경계가 항상 정각이라
  // `WHERE t >= from`이 from이 속한 부분 시간 버킷을 통째로 걸러져, 기본 2일 뷰에서 KPI와
  // 시계열 합계가 실측 1.58%(약 3100만) 어긋났다. incBucketed에도 동일한 first-bucket raw
  // stitch를 적용하고 바깥 WHERE를 버킷 경계 기준으로 고쳐 해소됨(incBucketed 위 주석,
  // "first-bucket raw stitch" 참고 — 라이브 클러스터로 diff=0 확인).
  return `(
    SELECT
        SessionId, AggregationTemporality AS temp, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName,
        if(temp = 2,
            greatest(
                maxIf(mv, hh < {to:DateTime})
                - greatest(maxIf(mv, hh < toStartOfHour({from:DateTime})), max(from_hour_raw_baseline)),
                0
            ),
            sumIf(sv, hh > toStartOfHour({from:DateTime}) AND hh < {to:DateTime}) + max(from_hour_raw_delta)
        ) AS Value
    FROM (
        SELECT hour AS hh, ${seriesKey} AS sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName,
            max_value AS mv, sum_value AS sv,
            0 AS from_hour_raw_baseline, 0 AS from_hour_raw_delta
        FROM claude_code.otel_metrics_sum_hourly
        WHERE hour >= toStartOfHour({from:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
          ${metricFilter}
        UNION ALL
        SELECT
            toStartOfHour({from:DateTime}) AS hh, ${seriesKey} AS sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision, SkillName,
            Attributes['tool_name'] AS ToolName,
            0 AS mv, 0 AS sv,
            maxIf(Value, TimeUnix < {from:DateTime}) AS from_hour_raw_baseline,
            sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < toStartOfHour({from:DateTime}) + INTERVAL 1 HOUR) AS from_hour_raw_delta
        FROM claude_code.otel_metrics_sum
        WHERE TimeUnix >= toStartOfHour({from:DateTime}) AND TimeUnix < toStartOfHour({from:DateTime}) + INTERVAL 1 HOUR
          ${metricFilter}
        GROUP BY sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName
    )
    GROUP BY sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName
  )`;
}

// from이 속한 버킷의 시작/끝 경계 — incBucketed의 first-bucket raw stitch(아래)가 이 경계로
// "그 버킷 안에서 from 이후만" 만큼만 보정한다. bucket()과 동일한 HOUR/DAY 규칙을
// {from:DateTime}에 그대로 적용해(분 버킷은 incBucketedRaw 담당이라 여기 안 옴), 실제
// bucketExpr이 만드는 버킷 폭과 항상 일치시킨다 — 하드코딩된 toStartOfHour(from)이었다면
// day 버킷(intervalHours>=24)에서 폭이 안 맞아 보정이 어긋났을 것.
function fromBucketBounds(intervalHours) {
  const start = bucket(intervalHours, "{from:DateTime}");
  const width = intervalHours >= 24 ? "{intervalDays:UInt32} DAY" : "{intervalHours:UInt32} HOUR";
  return { startExpr: start.expr, endExpr: `${start.expr} + INTERVAL ${width}` };
}

// incFlat의 시계열(버킷) 버전 — rollup을 hour/day 버킷으로 재집계한다. 버킷별로 cumulative는
// "그 버킷의 마지막 누적값 - 이전 버킷의 마지막 누적값"(lagInFrame), delta는 버킷 내 합을 쓴다.
// lookback 구간의 버킷은 첫 실구간 버킷의 diff baseline으로만 쓰이고 바깥 WHERE t >= from에서
// 걸러진다. 분(MINUTE) 버킷은 rollup(hour 그레인)으로 못 만드므로 incBucket()이 원본 폴백을 태운다.
//
// 3단 중첩 필수(집계 → window → 바깥 WHERE t>=from) — window와 WHERE t>=from을 같은 SELECT
// 레벨에 두면 ClickHouse가 WHERE를 먼저 적용해 lookback 버킷(t<from)을 지운 뒤 window를
// 계산해, 각 시리즈의 첫 실구간 버킷 lagInFrame이 항상 0(fallback)을 반환한다 — cumulative
// 시계열의 첫 버킷이 "증가량"이 아니라 "누적 전량"으로 뻥튀기된다.
// 2026-07-12: 이 함수를 처음 작성했을 때 이미 이 문제를 의심해 "검증"했으나, 그 실험이
// 실수로 이미-안전한 3단 구조를 재현해놓고 "동일하다"고 오판했다(라운드 3 커밋의 잘못된
// 주석). 이번엔 라이브 ClickHouse에서 프로덕션과 동일한 2단 구조(버그 재현: lag=0, baseline
// 유실)와 3단 구조(정상: lag=이전 버킷값)를 나란히 실행해 실제로 값이 다르다는 것을
// 직접 확인했다 — 3단 구조가 유일하게 안전하다.
//
// first-bucket raw stitch(라운드 12 추가): 위 3단 구조로도 t=from이 속한 첫 버킷은 여전히
// [버킷 시작, 버킷 끝) 전체를 담아, WHERE t>=from을 통과하려면 t(버킷 시작)>=from이어야 하는데
// from이 정각/자정이 아니면 t<from이라 그 버킷 전체가 탈락한다 — incFlat(스냅샷)은 같은 구간을
// raw로 보정해서 잡는데 시계열은 놓쳐, 기본 2일 뷰에서 KPI 합계와 시계열 합계가 실측 1.58%
// 어긋났다(리뷰에서 4/4 모델 합의 MAJOR). incFlat과 동일한 UNION ALL raw-stitch를 여기도
// 적용한다 — cumulative는 baseline을 greatest(이전 버킷 cum, raw로 구한 정확한 from 시점 값)로
// 보정(다른 버킷의 from_bucket_raw_baseline은 항상 0이라 무해), delta는 첫 버킷의 cum 자체를
// raw [from, 버킷 끝) 재계산값으로 통째 교체한다(다른 버킷은 그대로). 바깥 WHERE도
// `t >= from`에서 `t >= startExpr`로 바꿔야 한다 — 안 그러면 보정된 첫 버킷의 t 라벨(=버킷
// 시작, 항상 from보다 이르거나 같음)이 여전히 필터에 걸려 통째로 버려진다(라이브 클러스터로
// 최초 구현에서 이 실수를 했다가 재현·발견: 보정값은 정확했는데 최종 합계에 안 들어갔었음).
export function incBucketed(intervalHours, bucketExpr, metricFilter = "") {
  const { startExpr, endExpr } = fromBucketBounds(intervalHours);
  // cumulative(temp=2)의 첫 버킷 cum(=max(mv), rollup의 자연스러운 버킷-끝 값)은 delta처럼
  // least(endExpr,{to}) 캡을 받지 않는다(리뷰에서 지적) — 이론상 to가 그 버킷 "안"에서 끝나면
  // rollup이 이미 그 hour 전체(버킷 끝까지)를 반영해 [from,to) 밖 증가분이 섞일 수 있다. 하지만
  // 실제로 발생하는 경로가 없다: historical to는 range()가 항상 hour로 내림해(alignHistoricalTo)
  // hour-그레인 경계와 정확히 맞아 겹칠 여지가 없고, live to는 지금(now) 근처라 "미래" 데이터가
  // 존재하지 않는다(초 단위 인입 지연 정도만). intervalHours=1 + to-from<1h인 직접 API 호출로만
  // 재현 가능하고 UI(resolutionForSpan)는 이 조합을 만들지 않는다 — 방어적으로만 고치면 3번째
  // raw stitch 값이 더 필요해 복잡도가 이득보다 크다고 판단해 문서화로 남긴다.
  return `(
    SELECT t, SessionId, UserEmail, MetricName, Model, TokenType, Decision, Value FROM (
        SELECT t, SessionId, UserEmail, MetricName, Model, TokenType, Decision,
            if(temp = 2,
                greatest(cum - greatest(lagInFrame(cum, 1, 0) OVER (
                    PARTITION BY sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision ORDER BY t
                ), from_bucket_raw_baseline), 0),
                if(t = ${startExpr}, from_bucket_raw_delta, cum)) AS Value
        FROM (
            SELECT t, sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision,
                if(temp = 2, max(mv), sum(sv)) AS cum,
                max(from_bucket_raw_baseline) AS from_bucket_raw_baseline,
                max(from_bucket_raw_delta) AS from_bucket_raw_delta
            FROM (
                SELECT ${bucketExpr} AS t, ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, UserEmail, MetricName, Model, TokenType, Decision,
                    max_value AS mv, sum_value AS sv, 0 AS from_bucket_raw_baseline, 0 AS from_bucket_raw_delta
                FROM claude_code.otel_metrics_sum_hourly
                WHERE hour >= toStartOfHour({from:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
                  ${metricFilter}
                UNION ALL
                SELECT ${startExpr} AS t, ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, UserEmail, MetricName, Model, TokenType, Decision,
                    0 AS mv, 0 AS sv,
                    maxIf(Value, TimeUnix < {from:DateTime}) AS from_bucket_raw_baseline,
                    -- endExpr(버킷 끝)이 아니라 least(endExpr, {to})로 캡 — 요청 구간이 버킷
                    -- 폭보다 짧으면(예: intervalHours=1인데 to-from=30분) endExpr가 {to}를 넘어가
                    -- [from,to) 밖의 delta까지 새 들어온다(리뷰에서 MAJOR로 확인 — UI의
                    -- resolutionForSpan은 이 조합을 안 만들지만 서버가 강제하지 않고 있었다).
                    sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < least(${endExpr}, {to:DateTime})) AS from_bucket_raw_delta
                FROM claude_code.otel_metrics_sum
                WHERE TimeUnix >= ${startExpr} AND TimeUnix < least(${endExpr}, {to:DateTime})
                  ${metricFilter}
                GROUP BY sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision
            )
            GROUP BY t, sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision
        )
    )
    WHERE t >= ${startExpr}
  )`;
}

// incBucketed의 원본 테이블 버전 — 차트 드래그 줌의 분(MINUTE) 버킷 전용. 줌 구간은 좁고 드물어
// 콜드 허용(원본 스캔 비용은 lookback이 지배하지만 rollup으로 baseline만 따로 얻는 최적화는
// 필요해질 때 한다). incBucketed와 동일한 이유로 3단 중첩(집계 → window → 바깥 WHERE) 필수.
function incBucketedRaw(bucketExpr, metricFilter = "") {
  return `(
    SELECT t, SessionId, UserEmail, MetricName, Model, TokenType, Decision, Value FROM (
        SELECT t, SessionId, UserEmail, MetricName, Model, TokenType, Decision,
            if(temp = 2,
                greatest(cum - lagInFrame(cum, 1, 0) OVER (
                    PARTITION BY sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision ORDER BY t
                ), 0),
                cum) AS Value
        FROM (
            SELECT ${bucketExpr} AS t, ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, UserEmail, MetricName, Model, TokenType, Decision,
                if(AggregationTemporality = 2, max(Value), sum(Value)) AS cum
            FROM claude_code.otel_metrics_sum
            WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
              ${metricFilter}
            GROUP BY t, sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision
        )
    )
    WHERE t >= {from:DateTime}
  )`;
}

// 시계열 쿼리 공용 진입점 — 그레인에 맞는 버킷식과 소스 테이블(rollup vs 원본)을 함께 고른다.
// 호출부는 FROM ${b.sub} m + { ...b.params } 형태로 쓴다.
function incBucket(intervalHours, metricFilter = "") {
  const raw = intervalHours < 1; // 분 버킷은 hour-그레인 rollup으로 만들 수 없다
  const b = bucket(intervalHours, raw ? "TimeUnix" : "hour");
  return { sub: raw ? incBucketedRaw(b.expr, metricFilter) : incBucketed(intervalHours, b.expr, metricFilter), params: b.params, raw };
}

// intervalHours < 1 → MINUTE 버킷(차트 드래그 줌), < 24 → HOUR 버킷, >= 24 → DAY 버킷.
// ClickHouse의 toStartOfInterval(..., INTERVAL n HOUR)은 n>24에서 날짜 경계를 못 넘어가고 매일
// 0시로 리셋되는 동작이 있어(costByModelDaily가 원래 겪던 문제), 24시간 이상 구간은 항상 DAY
// 단위로 계산해 그 quirk를 피한다. intervalHours는 UInt32로 바인딩되므로 분 버킷은 분 단위로 환산.
export function bucket(intervalHours, col = "TimeUnix") {
  if (intervalHours >= 24)
    return { expr: `toStartOfInterval(${col}, INTERVAL {intervalDays:UInt32} DAY)`, params: { intervalDays: Math.max(1, Math.round(intervalHours / 24)) } };
  if (intervalHours < 1)
    return { expr: `toStartOfInterval(${col}, INTERVAL {intervalMinutes:UInt32} MINUTE)`, params: { intervalMinutes: Math.max(1, Math.round(intervalHours * 60)) } };
  return { expr: `toStartOfInterval(${col}, INTERVAL {intervalHours:UInt32} HOUR)`, params: { intervalHours } };
}

// 비용 계산에 필요한 토큰 타입별 합계 + Claude Code 자체 보고 비용(비교용). withComputedCost()
// (pricing.js)가 이 4개 토큰 컬럼 + reported_cost를 받아 단가표 기반 cost를 계산한다.
const TOKEN_SUMS = `
        sumIf(m.Value, m.MetricName = 'claude_code.cost.usage')                                        AS reported_cost,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')         AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')        AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheRead')     AS cache_read_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheCreation') AS cache_write_tokens`;

// 패널1: 그룹별 KPI 요약. excludeUnknown: false — 이 응답의 합계(클라이언트에서 groupBy 없이
// reduce)가 Overview/Executive의 "전체 세션/토큰/라인" 총계로 쓰인다. activeUsers(unknown
// 포함)와 짝을 이루는 분자이므로 같은 모수 정책을 따라야 한다(리뷰에서 MAJOR로 확인 —
// 안 그러면 costPerDev 같은 파생 비율이 분자·분모 모수가 다른 값이 된다). 그룹별로 나눠 보는
// UI(bedrock/enterprise 카드)는 정확한 group 문자열로만 필터링하므로 unknown 행이 섞여도
// 영향 없다.
export async function kpiSummary(from, to, filters = {}) {
  const f = filterCond({ ...filters, excludeUnknown: false }, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')       AS sessions,
        uniqExactIf(m.UserEmail, m.UserEmail != '')                     AS users,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')  AS prs,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')                                AS total_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')       AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')      AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added') AS lines_of_code
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.session.count', 'claude_code.commit.count', 'claude_code.pull_request.count',
        'claude_code.token.usage', 'claude_code.lines_of_code.count'
      )`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 패널2: 토큰 시계열
export async function tokenTimeseries(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const b = incBucket(intervalHours, `AND MetricName = 'claude_code.token.usage'`);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS tokens,
        sumIf(m.Value, m.TokenType = 'input')  AS input_tokens,
        sumIf(m.Value, m.TokenType = 'output') AS output_tokens
    FROM ${b.sub} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to, b.raw), ...b.params, ...f.params }
  );
}

// LOC 추가/삭제 시계열 — lines_of_code.count의 type attribute(added/removed)는 token.usage와 같은
// 승격 컬럼(TokenType = Attributes['type'])에 실린다. 다른 시계열과 동일하게 bucket()으로 버킷 —
// 1~2일 뷰(intervalHours=1)에서 시간별 다중 점을 그려야 LOC만 하루 1~2점으로 붕괴하지 않는다.
export async function locTimeseries(from, to, intervalHours = 24, filters = {}) {
  // lines_of_code.count 행엔 Model attribute가 없다(row-level model 매치는 항상 미매치) —
  // kpiSummary와 동일한 modelMixed 세미조인으로 통일한다(실측: 리뷰에서 확인).
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  const b = incBucket(intervalHours, `AND MetricName = 'claude_code.lines_of_code.count'`);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.TokenType = 'added')   AS loc_added,
        sumIf(m.Value, m.TokenType = 'removed') AS loc_removed
    FROM ${b.sub} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to, b.raw), ...b.params, ...f.params }
  );
}

// 패널3: 캐시 효율
export async function cacheEfficiency(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.TokenType = 'cacheRead')                              AS cache_read,
        sumIf(m.Value, m.TokenType IN ('input', 'cacheRead', 'cacheCreation'))  AS input_side,
        round(cache_read / nullIf(input_side, 0), 3)              AS cache_read_ratio,
        sumIf(m.Value, m.TokenType = 'input')                                  AS uncached_input,
        sumIf(m.Value, m.TokenType = 'cacheCreation')                          AS cache_write,
        sumIf(m.Value, m.TokenType = 'output')                                 AS output_tokens
    FROM ${incFlat(`AND MetricName = 'claude_code.token.usage'`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 패널6: 모델별 토큰 분포 (교란 점검)
export async function modelDistribution(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model,
        sum(m.Value) AS tokens,
        sumIf(m.Value, m.TokenType = 'input')  AS input_tokens,
        sumIf(m.Value, m.TokenType = 'output') AS output_tokens
    FROM ${incFlat(`AND MetricName = 'claude_code.token.usage'`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", model ORDER BY "group", tokens DESC`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 패널4: 토큰 정규화 생산성 (핵심 A/B 지표)
export async function normalizedProductivity(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added') AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS tokens,
        round(loc / nullIf(tokens, 0) * 1000000, 2)                      AS loc_per_million_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits,
        round(commits / nullIf(tokens, 0) * 1000000, 3)                  AS commits_per_million_tokens
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.lines_of_code.count', 'claude_code.token.usage', 'claude_code.commit.count'
      )`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 패널5: 코드 수락률
export async function codeEditDecisions(from, to, filters = {}) {
  // code_edit_tool.decision 행엔 Model attribute가 없다 — locTimeseries와 동일한 이유로 modelMixed.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.Decision AS decision, sum(m.Value) AS n
    FROM ${incFlat(`AND MetricName = 'claude_code.code_edit_tool.decision'`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", decision ORDER BY "group", decision`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 패널5 확장: 툴 종류별(edit/multi_edit/write/notebook_edit) 수락/거부 — 그룹 합계만 보여주던
// codeEditDecisions를 tool_name 차원으로 쪼갠 버전. ToolName이 비어있는 행(구버전 텔레메트리 등
// tool_name attribute가 없는 경우)은 집계에서 제외한다.
// 실측 확인(2026-07-08, 프로덕션 mapKeys 쿼리): code_edit_tool.decision 83,070행 전부에
// tool_name 키 존재(Edit 48,404 / Write 34,666) — WHERE tool != ''로 빈 패널이 될 일 없음.
export async function codeEditDecisionsByTool(from, to, filters = {}) {
  // code_edit_tool.decision 행엔 Model attribute가 없다 — codeEditDecisions와 동일하게 modelMixed.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.ToolName AS tool, m.Decision AS decision, sum(m.Value) AS n
    FROM ${incFlat(`AND MetricName = 'claude_code.code_edit_tool.decision'`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.ToolName != '' ${f.where}
    GROUP BY "group", tool, decision ORDER BY "group", tool`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 패널9: 활성 사용시간 시계열
// 실측 확인(2026-07-06, 실제 claude 세션): active_time.total은 gauge가 아니라 sum 테이블로
// 들어온다 — grafana-ab-queries.sql 패널9의 주석("gauge로 안 들어오면 sum으로 교체")이 실제로
// 맞았다. otel_metrics_gauge 테이블/스키마는 그대로 두고 이 쿼리만 sum을 본다.
export async function activeTimeSeries(from, to, intervalHours = 24, filters = {}) {
  // active_time.total 행엔 Model attribute가 없다 — locTimeseries와 동일한 이유로 modelMixed.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  const b = incBucket(intervalHours, `AND MetricName = 'claude_code.active_time.total'`);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS active_seconds
    FROM ${b.sub} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to, b.raw), ...b.params, ...f.params }
  );
}

// 패널7: skill 사용 분포. skill.name은 cost.usage 행에만 실리고 token.usage에는 skill 귀속이
// 없어 토큰 기반으로 계산할 수 없다 — Claude Code 보고 비용(cost.usage) 그대로 사용. count()는
// incFlat이 세션 단위로 이미 접어놓은 뒤라 "세션 수" 근사다(delta였을 때도 export 횟수 근사였던
// 것과 마찬가지로 정확한 invocation 수는 아님).
export async function skillUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.SkillName AS skill, count() AS invocations, sum(m.Value) AS est_cost_usd
    FROM ${incFlat(`AND MetricName = 'claude_code.cost.usage'`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.SkillName != '' ${f.where}
    GROUP BY "group", skill ORDER BY "group", invocations DESC`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// 모델별 지출 트렌드 (Cost 페이지 스택 바). intervalHours로 시간별/일간/주간 토글.
export async function costByModelDaily(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const b = incBucket(intervalHours, `AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`);
  const rows = await query(
    `${GROUP_CTE}
    SELECT t AS day,
        ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model,
        ${TOKEN_SUMS}
    FROM ${b.sub} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' ${f.where}
    GROUP BY day, "group", model ORDER BY day`,
    { ...range(from, to, b.raw), ...b.params, ...f.params }
  );
  // cost 키 이름을 유지해 SeriesBarChart(valueKey="cost")가 그대로 동작하게 한다.
  return withComputedCost(rows);
}

// 모델별 지출 vs 이전 동일 길이 기간. cumulative의 진짜 이점이 여기서 나온다 — 두 구간(현재/이전)
// × 5개 값(보고비용+토큰4타입)을 각 세션의 경계 3점(prevFrom/from/to)만 diff해서 얻고, N개 delta
// row를 매번 다시 합산할 필요가 없다. cost/prev_cost는 각 구간 토큰 합계에 단가표를 적용해 JS에서
// 계산(withComputedCost 2회 호출). group/user 필터를 걸려면 session_group을 여기서도 조인한다.
export async function costByModelCompare(from, to, prevFrom, filters = {}) {
  // outer는 서브쿼리 m의 projection만 보인다 — 원본 Model 컬럼이 아니라 정규화된 alias(model)로 필터.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "UserEmail", modelNorm: "model" });
  const metricFilter = "AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage') AND Model != ''";
  // rollup 분기의 WITH절이 curFrom/curTo/prevFrom을 SQL 스칼라로 재계산하는데, 그 절은 같은
  // SELECT 레벨의 표현식에만 보이고 FROM의 nested 서브쿼리(raw stitch branch)에는 안 보인다 —
  // 그 서브쿼리들은 {prevFrom:DateTime} bind param(JS가 넘긴 "정렬 전" 값)만 참조할 수 있다.
  // prevFrom-hour raw stitch가 SQL의 실제 정렬된 prevFrom과 같은 시각을 봐야 하므로, 여기서
  // JS로 동일하게 재계산해 별도 bind param(alignedPrevFrom)으로 넘긴다(리뷰에서 발견 — 처음엔
  // bind param prevFrom을 그대로 썼다가 정렬 전/후 값이 달라 stitch가 엉뚱한 hour를 보는
  // 버그였음). 두 번째 회귀(라이브 클러스터 riview에서 확인): curToAligned를 raw `to`로
  // 계산했는데, SQL의 {to:DateTime} bind param은 range(from,to)를 거쳐 alignHistoricalTo()로
  // 이미 정렬된 값이다 — historical(라이브 아님) + `to`가 정각 아님 조합에서 둘이 달라져
  // stitch가 SQL이 실제로 쓰는 prevHourStart와 다른 hour를 보게 된다. range()와 정확히
  // 동일한 정렬 규칙(정렬값이 from보다 앞서거나 같으면 포기)을 여기서도 적용한다.
  const curFromAligned = new Date(from);
  curFromAligned.setUTCMinutes(0, 0, 0);
  const alignedToCandidate = alignHistoricalTo(to);
  const effectiveTo = alignedToCandidate <= from ? to : alignedToCandidate;
  const curToAligned = new Date(Math.max(effectiveTo.getTime(), curFromAligned.getTime() + 3600000));
  const alignedPrevFrom = new Date(curFromAligned.getTime() - (curToAligned.getTime() - curFromAligned.getTime()));
  // span<=4h(incFlatRaw와 동일 임계)면 rollup의 hour 라운딩(curFrom=toStartOfHour(from) 등)을
  // 전혀 타지 않고 raw 테이블에서 정확한 [prevFrom,from)/[from,to) 창을 직접 계산한다 —
  // costSummary/costByModel(incFlat 경로)이 같은 구간에서 이미 이 정밀도를 쓰므로, 형제 Cost
  // 카드와 동일한 모수를 비교하게 된다(리뷰에서 MAJOR로 확인: rollup 경로만 쓰면 드래그 줌
  // sub-4h 구간에서 "이전 기간 대비" 카드가 나머지 카드와 다른 창을 봤다).
  const rows = incFlatRaw(to - from)
    ? await query(
        `${GROUP_CTE}
        SELECT model,
            sumIf(cur_v, MetricName = 'claude_code.cost.usage')                                        AS reported_cost,
            sumIf(prev_v, MetricName = 'claude_code.cost.usage')                                        AS prev_reported_cost,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'input')                AS input_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'input')               AS prev_input_tokens,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'output')               AS output_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'output')              AS prev_output_tokens,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheRead')            AS cache_read_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheRead')           AS prev_cache_read_tokens,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheCreation')        AS cache_write_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheCreation')       AS prev_cache_write_tokens
        FROM (
            SELECT ${seriesKey} AS sk, SessionId, any(UserEmail) AS UserEmail, ${normModel("Model")} AS model, MetricName, TokenType,
                if(AggregationTemporality = 2,
                    greatest(maxIf(Value, TimeUnix < {from:DateTime}) - maxIf(Value, TimeUnix < {prevFrom:DateTime}), 0),
                    sumIf(Value, TimeUnix >= {prevFrom:DateTime} AND TimeUnix < {from:DateTime})) AS prev_v,
                if(AggregationTemporality = 2,
                    greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                    sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS cur_v
            FROM claude_code.otel_metrics_sum
            WHERE TimeUnix >= {prevFrom:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
              ${metricFilter}
            GROUP BY sk, SessionId, AggregationTemporality, model, MetricName, TokenType
        ) m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE 1 = 1 ${f.where}
        GROUP BY model`,
        { from: toChDateTime(from), to: toChDateTime(to), prevFrom: toChDateTime(prevFrom), ...f.params }
      )
    : await query(
        `${GROUP_CTE}
        SELECT model,
            sumIf(cur_v, MetricName = 'claude_code.cost.usage')                                        AS reported_cost,
            sumIf(prev_v, MetricName = 'claude_code.cost.usage')                                        AS prev_reported_cost,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'input')                AS input_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'input')               AS prev_input_tokens,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'output')               AS output_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'output')              AS prev_output_tokens,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheRead')            AS cache_read_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheRead')           AS prev_cache_read_tokens,
            sumIf(cur_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheCreation')        AS cache_write_tokens,
            sumIf(prev_v, MetricName = 'claude_code.token.usage' AND TokenType = 'cacheCreation')       AS prev_cache_write_tokens
        FROM (
            -- prevFrom을 정렬된 경계(cur = [toStartOfHour(from), toStartOfHour(to)))의 실제 길이로
            -- 재계산한다 — JS에서 넘어온 prevFrom은 정렬 "전" (to-from)로 계산돼, from/to가 같은
            -- hour 안이 아니면 정렬 후 cur/prev 창 길이가 달라진다(예: from=10:15,to=11:45면 원래
            -- prevFrom=08:45인데 정렬 후 cur=[10:00,11:00)=1h, prev=[08:00,10:00)=2h로 비대칭 —
            -- 리뷰에서 MAJOR로 확인). curFrom/curTo로 정렬 후 길이를 구하고 그만큼을 prevFrom에
            -- 다시 뺀다.
            -- from/to가 같은 hour 안(드래그 줌으로 만들 수 있는 sub-hour 구간, 예: 10:15~10:45)이면
            -- curFrom==curTo가 되어 cur 창이 0초로 붕괴해 비교 카드가 전부 0/empty로 나온다(리뷰에서
            -- MAJOR로 확인). 이 지표는 "이전 동일 기간 대비"가 목적이라 최소 1시간 창을 보장한다.
            -- curTo는 {to:DateTime} 자체를 다시 toStartOfHour로 내림하면 안 된다 — {to}는 이미
            -- range(from,to)가 alignHistoricalTo()로 정렬을 마친 값이다(라이브 to는 정렬을
            -- "건너뛰어" 그대로 둔다). 여기서 다시 내림하면 라이브 뷰에서 가장 최근 최대 59분의
            -- 활동이 통째로 사라져 costSummary/costByModel(incFlat, 라이브 to를 안 내림)보다
            -- 훨씬 낮게 나온다(라이브 클러스터 실측: 8h33m 구간에서 -17.7%, 제거 후 +4.4%로
            -- incFlat 자체의 오차 수준과 같아짐 — 리뷰에서 MAJOR로 확인).
            WITH toStartOfHour({from:DateTime}) AS curFrom,
                 greatest({to:DateTime}, curFrom + INTERVAL 1 HOUR) AS curTo,
                 curFrom - (curTo - curFrom) AS prevFrom,
                 toStartOfHour(prevFrom) AS prevHourStart
            SELECT
                SessionId, any(UserEmail) AS UserEmail, ${normModel("Model")} AS model, MetricName, TokenType,
                -- prev_v의 baseline(hh < prevFrom)도 cur_v와 같은 결함을 갖는다 — curTo가 라이브
                -- to를 그대로 쓰게 되면서(위 주석) prevFrom = curFrom - (curTo-curFrom)도 curFrom과
                -- 달리 정각이 아닐 수 있게 됐다(예전엔 curTo가 항상 정각이라 prevFrom도 자동으로
                -- 정각이었음). raw stitch로 동일하게 보정(리뷰에서 3/4 모델 독립 지적 — 값은
                -- 세션의 활동 패턴에 따라 드물게만 드러나지만, incFlat과 동일한 근본 원인이라
                -- 구조적으로 고친다).
                if(AggregationTemporality = 2,
                    greatest(maxIf(mv, hh < curFrom) - greatest(maxIf(mv, hh < prevHourStart), max(prev_hour_raw_baseline)), 0),
                    sumIf(sv, hh > prevHourStart AND hh < curFrom) + max(prev_hour_raw_delta)) AS prev_v,
                -- cur_v의 baseline(hh < curFrom)은 incFlat이 고친 것과 동일한 결함(hour가 "버킷
                -- 종료 시점" 값이라 curFrom=toStartOfHour(from)이 정확히 from 시점이 아님)을
                -- 그대로 갖고 있었다 — costSummary/costByModel과 다른 baseline을 써서 같은
                -- 화면의 "이전 기간 대비" 카드가 나머지 카드와 어긋났다(리뷰에서 MAJOR로 확인).
                -- incFlat과 동일한 raw stitch로 보정: rollup의 이전 hour까지 max와 raw로 구한
                -- 정확한 from 시점 값 중 더 큰 쪽을 baseline으로 쓴다.
                if(AggregationTemporality = 2,
                    greatest(maxIf(mv, hh < curTo) - greatest(maxIf(mv, hh < curFrom), max(from_hour_raw_baseline)), 0),
                    sumIf(sv, hh > curFrom AND hh < curTo) + max(from_hour_raw_delta)) AS cur_v
            FROM (
                SELECT hour AS hh, ${seriesKey} AS sk, SessionId, AggregationTemporality, UserEmail, Model, MetricName, TokenType,
                    max_value AS mv, sum_value AS sv, 0 AS from_hour_raw_baseline, 0 AS from_hour_raw_delta, 0 AS prev_hour_raw_baseline, 0 AS prev_hour_raw_delta
                FROM claude_code.otel_metrics_sum_hourly
                WHERE hour >= toStartOfHour({prevFrom:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
                  ${metricFilter}
                UNION ALL
                SELECT
                    toStartOfHour({from:DateTime}) AS hh, ${seriesKey} AS sk, SessionId, AggregationTemporality, UserEmail, Model, MetricName, TokenType,
                    0 AS mv, 0 AS sv,
                    maxIf(Value, TimeUnix < {from:DateTime}) AS from_hour_raw_baseline,
                    sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < toStartOfHour({from:DateTime}) + INTERVAL 1 HOUR) AS from_hour_raw_delta,
                    0 AS prev_hour_raw_baseline, 0 AS prev_hour_raw_delta
                FROM claude_code.otel_metrics_sum
                WHERE TimeUnix >= toStartOfHour({from:DateTime}) AND TimeUnix < toStartOfHour({from:DateTime}) + INTERVAL 1 HOUR
                  ${metricFilter}
                GROUP BY sk, SessionId, AggregationTemporality, UserEmail, Model, MetricName, TokenType
                UNION ALL
                SELECT
                    toStartOfHour({alignedPrevFrom:DateTime}) AS hh, ${seriesKey} AS sk, SessionId, AggregationTemporality, UserEmail, Model, MetricName, TokenType,
                    0 AS mv, 0 AS sv,
                    0 AS from_hour_raw_baseline, 0 AS from_hour_raw_delta,
                    maxIf(Value, TimeUnix < {alignedPrevFrom:DateTime}) AS prev_hour_raw_baseline,
                    sumIf(Value, TimeUnix >= {alignedPrevFrom:DateTime} AND TimeUnix < toStartOfHour({alignedPrevFrom:DateTime}) + INTERVAL 1 HOUR) AS prev_hour_raw_delta
                FROM claude_code.otel_metrics_sum
                WHERE TimeUnix >= toStartOfHour({alignedPrevFrom:DateTime}) AND TimeUnix < toStartOfHour({alignedPrevFrom:DateTime}) + INTERVAL 1 HOUR
                  ${metricFilter}
                GROUP BY sk, SessionId, AggregationTemporality, UserEmail, Model, MetricName, TokenType
            )
            GROUP BY sk, SessionId, AggregationTemporality, model, MetricName, TokenType
        ) m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE 1 = 1 ${f.where}
        GROUP BY model`,
        { ...range(from, to), prevFrom: toChDateTime(prevFrom), alignedPrevFrom: toChDateTime(alignedPrevFrom), ...f.params }
      );
  return withComputedCost(rows).map((r) => {
    const [prev] = withComputedCost([
      {
        model: r.model,
        input_tokens: r.prev_input_tokens,
        output_tokens: r.prev_output_tokens,
        cache_read_tokens: r.prev_cache_read_tokens,
        cache_write_tokens: r.prev_cache_write_tokens,
      },
    ]);
    return { ...r, prev_cost: prev.cost };
  });
}

// 도입 수준 — 전체/월간/주간/일간 활성 유저 + DAU/MAU 고착도(고착도는 클라에서 dau/mau).
// group/user 필터를 걸면 그 하위집합만의 고착도를 볼 수 있다(예: bedrock 그룹만의 DAU/MAU).
// model 필터는 session.count에 model 귀속이 없어 의미가 없다 — cols에서 아예 뺀다.
// uniqExact류는 "존재 여부"만 보므로 시간별 rollup으로 접혀도 값이 같다(키 보존) — total_members가
// 전 기간을 봐야 해서 하한 없는 스캔인데, 원본(9.5M행+) 기준으론 이 쿼리가 데이터와 함께 무한히
// 느려지는 구조였다. rollup은 ~86x 작아 무제한이어도 저렴하다.
// excludeUnknown: false — 이건 그룹 A/B 비교가 아니라 전체 스냅샷(total_members/mau/wau/dau)이라
// unknown 세션도 포함해야 실제 "전체" 값이 된다(사용자가 명시적으로 group 필터를 걸면 그 그룹만
// 보이는 기존 동작은 유지 — filters.group 조건은 그대로 살아있다).
export async function adoptionLevels(from, to, filters = {}) {
  const f = filterCond({ ...filters, excludeUnknown: false }, { group: GROUP_EXPR, user: "UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        uniqExact(UserEmail)                                             AS total_members,
        uniqExactIf(UserEmail, hour >= {to:DateTime} - INTERVAL 30 DAY) AS mau,
        uniqExactIf(UserEmail, hour >= {to:DateTime} - INTERVAL 7 DAY)  AS wau,
        uniqExactIf(UserEmail, hour >= {to:DateTime} - INTERVAL 1 DAY)  AS dau
    FROM claude_code.otel_metrics_sum_hourly m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE MetricName = 'claude_code.session.count' AND UserEmail != '' AND hour < {to:DateTime} ${f.where}`,
    { to: toChDateTime(alignHistoricalTo(to)), ...f.params }
  );
  return rows[0] || { total_members: 0, mau: 0, wau: 0, dau: 0 };
}

// 기간 [from,to) 내 고유 활성 유저 수(ungrouped). 그룹 판별이 세션 단위라 한 유저가 bedrock/
// enterprise 두 그룹 행에 걸칠 수 있어 kpiSummary의 그룹별 users를 클라이언트에서 합산하면 중복
// 카운트된다 — Overview "전체 유저"·Executive "활성 개발자"는 이 단일 uniq 값을 써야 한다.
// 세션 존재 기반(uniqExact)이라 cumulative diff 불필요, rollup 직접 조회(키 보존이라 값 동일).
// model 필터는 cols에서 뺀다 — adoptionLevels/adoptionTimeseries(같은 People/adoption 섹션의
// DAU/WAU/MAU)도 session.count엔 model 귀속이 없다는 이유로 model 필터를 안 받는다. 이 지표만
// modelViaSession 세미조인으로 반응하면 "model 필터는 People 지표에 적용되지 않습니다" 배지가
// 뜬 화면에서 활성 개발자 수만 조용히 필터되어 DAU/MAU와 반대로 움직이는 모순이 생긴다(실측:
// 리뷰에서 확인). People 섹션 전체가 같은 규칙(model 필터 미적용)을 따르도록 통일한다.
// excludeUnknown: false — adoptionLevels와 동일한 이유(총계 지표, A/B 비교 아님).
// 좌경계 fuzz — hour >= toStartOfHour(from)이라 from이 정각이 아니면 최대 59분 앞선 활동까지
// uniq에 잡힐 수 있다. 기본 48h 뷰에선 <2%로 무시할 수준이지만, 이 PR의 핵심 신기능인 좁은
// 드래그 줌(예: 10분)에서는 왜곡이 커지고 costPerDev/productivity score로 전파된다(리뷰에서
// 2라운드 연속 MAJOR로 재확인 — Round 12에선 "document" 판정으로 남겼으나 반복 지적돼 이번엔
// 고친다). incFlat/costByModelCompare와 동일한 span<=4h(incFlatRaw) 임계로 raw 폴백 —
// adoptionLevels/adoptionTimeseries/userLeaderboard.active_days는 각각 30일/91일/선택 구간
// 전체를 보는 스냅샷·롤링 윈도우라 "좁은 드래그 줌" 시나리오가 성립하지 않아(구간이 넓을수록
// 좌경계 59분의 상대 영향이 이미 작음) 이번 라운드에선 activeUsers만 고친다.
// bedrock_users/enterprise_users는 A/B 그룹별 "사용자당 평균 지출"(Cost 페이지)의 분모다 —
// 양쪽 총지출만으로는 그룹의 사용자 수가 다르면 비교가 안 된다. GROUP BY가 아니라 uniqExactIf
// 조건 집계로 뽑는 이유: 그룹 판별이 세션 단위라 한 유저가 두 그룹에 걸칠 수 있어(grouping.js)
// 총계 users는 그룹 합이 아닌 전역 uniq여야 하고, GROUP BY로는 두 그레인을 한 쿼리에서 못 낸다.
export async function activeUsers(from, to, filters = {}) {
  const f = filterCond({ ...filters, excludeUnknown: false }, { group: GROUP_EXPR, user: "m.UserEmail" });
  const uniqs = `uniqExactIf(m.UserEmail, m.UserEmail != '') AS users,
        uniqExactIf(m.UserEmail, m.UserEmail != '' AND ${GROUP_EXPR} = 'bedrock') AS bedrock_users,
        uniqExactIf(m.UserEmail, m.UserEmail != '' AND ${GROUP_EXPR} = 'enterprise') AS enterprise_users`;
  const rows = incFlatRaw(to - from)
    ? await query(
        `${GROUP_CTE}
        SELECT ${uniqs}
        FROM claude_code.otel_metrics_sum m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE m.MetricName = 'claude_code.session.count'
          AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime} ${f.where}`,
        { from: toChDateTime(from), to: toChDateTime(to), ...f.params }
      )
    : await query(
        `${GROUP_CTE}
        SELECT ${uniqs}
        FROM claude_code.otel_metrics_sum_hourly m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE m.MetricName = 'claude_code.session.count'
          AND m.hour >= toStartOfHour({from:DateTime}) AND m.hour < {to:DateTime} ${f.where}`,
        { ...range(from, to), ...f.params }
      );
  return rows[0] || { users: 0, bedrock_users: 0, enterprise_users: 0 };
}

// 사용자·세션·PR 시계열 — Productivity 페이지의 "도입률"/"사용자당 PR" 이중축 시계열 하나로 둘 다 커버.
// session/PR 행에는 Model이 없지만, kpiSummary/normalizedProductivity/userLeaderboard와 동일하게
// modelMixed 세션 세미조인으로 model 필터를 통과시킨다 — 안 그러면 이 시계열만 전체-모델 기준이라
// 같은 페이지의 필터된 KPI/leaderboard와 모수가 어긋난다.
export async function dailyEngagement(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  const b = incBucket(intervalHours, `AND MetricName IN ('claude_code.session.count', 'claude_code.pull_request.count')`);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        uniqExactIf(m.UserEmail, m.MetricName = 'claude_code.session.count') AS users,
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')          AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')     AS prs,
        round(sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')
              / nullIf(uniqExactIf(m.UserEmail, m.MetricName = 'claude_code.session.count'), 0), 2) AS prs_per_user
    FROM ${b.sub} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t ORDER BY t`,
    { ...range(from, to, b.raw), ...b.params, ...f.params }
  );
}

// MCP 커넥터(서버) 사용 현황 — 실제 제품의 "읽기/쓰기" 구분은 우리 텔레메트리에 그 의미가
// 없어서(도구 이름 휴리스틱은 부정확) 유저수/호출수/성공률로 단순화. model 필터는 세션
// 세미조인으로 적용(세션이 쓴 모델 기준).
export async function mcpConnectorUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", l.McpServerName AS connector,
        uniqExact(l.UserEmail)      AS users,
        count()                     AS calls,
        countIf(l.Success = 'true') AS ok
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result' AND l.McpServerName != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", connector ORDER BY "group", calls DESC`,
    // raw=true — 이 쿼리는 rollup이 아니라 otel_logs(Timestamp 정밀 비교)를 직접 스캔한다.
    // range()의 historical-to 정각 내림은 rollup의 부분-hour 버킷 과대집계를 막기 위한 것으로,
    // 이 로그 테이블엔 그 문제가 없다 — 정렬하면 오히려 드래그 줌에서 최근 최대 59분의 로그가
    // 순수하게 사라진다(리뷰에서 MAJOR로 확인).
    { ...range(from, to, true), ...f.params }
  );
}

// "에이전틱함" = 프롬프트 1개당 평균 툴 호출 수. claude_code.user_prompt 이벤트가 실제로
// 오는지 실측 필요(clickhouse-schema.sql 주석에 있던 후보 이벤트명) — 없으면 prompts=0으로
// 나와 이 지표는 그냥 비게 된다(기능 자체는 죽지 않음). model 필터는 세션 세미조인으로 적용.
export async function agenticness(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  const b = bucket(intervalHours, "l.Timestamp");
  return query(
    `${GROUP_CTE}
    SELECT
        ${b.expr} AS t,
        ${GROUP_EXPR} AS "group",
        countIf(l.EventName = 'user_prompt') AS prompts,
        countIf(l.EventName = 'tool_result')  AS tool_calls,
        round(tool_calls / nullIf(prompts, 0), 2)          AS tool_calls_per_prompt
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY t, "group" ORDER BY t`,
    // raw=true — otel_logs 직접 스캔(rollup 없음), mcpConnectorUsage와 동일 이유.
    { ...range(from, to, true), ...b.params, ...f.params }
  );
}

// 패널8: tool/MCP 사용 패턴 (logs). model 필터는 세션 세미조인으로 적용.
export async function toolMcpUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group", l.ToolName AS tool, l.McpServerName AS mcp_server,
        countIf(l.Success = 'true')  AS ok,
        countIf(l.Success = 'false') AS fail,
        count()                      AS total
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", tool, mcp_server ORDER BY "group", total DESC LIMIT 50`,
    // raw=true — otel_logs 직접 스캔(rollup 없음), mcpConnectorUsage와 동일 이유.
    { ...range(from, to, true), ...f.params }
  );
}

// Cost 페이지: 그룹별 비용/토큰 요약. 비용은 토큰 실측 × 단가표(pricing.js)로 계산 —
// Claude Code 자체 보고 비용(reported_cost)은 비교용으로만 같이 내려준다.
// 단가는 모델별로 다르므로 SQL은 그룹+모델 단위로 집계하고, 그룹 합계는 JS에서 fold한다.
// excludeUnknown: false — kpiSummary와 동일한 이유(응답 전체 합계가 "총 지출/개발자당 지출"
// 총계로 쓰인다, Cost.jsx/Executive.jsx). unknown을 빼면 activeUsers(unknown 포함) 대비
// 분자가 작아져 개발자당 지출이 실제보다 낮게 나온다(리뷰에서 MAJOR로 확인).
export async function costSummary(from, to, filters = {}) {
  // model 필터는 SELECT에 model 정규화 컬럼이 있지만, sessions는 Model attribute가 없는
  // session.count 행을 합산하는 혼합 지표라 kpiSummary와 같은 modelMixed가 필요.
  const f = filterCond({ ...filters, excludeUnknown: false }, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        ${normModel("m.Model")} AS model,
        ${TOKEN_SUMS},
        sumIf(m.Value, m.MetricName = 'claude_code.session.count') AS sessions
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.session.count'
      )`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", model ORDER BY "group"`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
  const byGroup = new Map();
  for (const r of withComputedCost(rows)) {
    if (!byGroup.has(r.group)) {
      byGroup.set(r.group, {
        group: r.group,
        computed_cost: 0,
        reported_cost: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        unpriced_tokens: 0,
        sessions: 0,
      });
    }
    const g = byGroup.get(r.group);
    g.computed_cost += r.cost || 0;
    g.reported_cost += Number(r.reported_cost);
    g.input_tokens += Number(r.input_tokens);
    g.output_tokens += Number(r.output_tokens);
    g.cache_read_tokens += Number(r.cache_read_tokens);
    g.cache_write_tokens += Number(r.cache_write_tokens);
    if (r.unpriced) {
      g.unpriced_tokens +=
        Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens);
    }
    g.sessions += Number(r.sessions);
  }
  return [...byGroup.values()].sort((a, b) => a.group.localeCompare(b.group));
}

// Cost 페이지: 모델별 비용/토큰. cost는 토큰 실측 × 단가표로 계산한 값, reported_cost는
// Claude Code 자체 보고값(비교용). 단가표에 없는 모델은 cost: null + unpriced: true로 노출.
export async function costByModel(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model, ${TOKEN_SUMS}
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' ${f.where}
    GROUP BY "group", model ORDER BY "group"`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
  return withComputedCost(rows).map((r) => ({
    ...r,
    tokens: Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens),
  }));
}

// Cost 페이지: 유저 × 그룹 × 모델별 비용/토큰. group은 세션 단위 실제 값 — userCostEfficiency가
// 이 결과를 userLeaderboard(유저×그룹 행)와 그룹까지 맞춰 조인해야 하므로(안 그러면 두 그룹을
// 오간 유저의 전체 비용이 양쪽 그룹 행에 중복으로 붙는다), 여기도 topK(1) 다수결이 아니라 실제
// 그룹으로 쪼갠다.
export async function costByUserModel(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model, ${TOKEN_SUMS}
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' AND m.UserEmail != '' ${f.where}
    GROUP BY user, "group", model ORDER BY user`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
  return withComputedCost(rows).map((r) => ({
    ...r,
    tokens: Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens),
  }));
}

// 유저별 어떤 tool을 얼마나 썼는지 (Usage/Users 페이지의 "사용자별 사용 내역"). model 필터는
// 세션 세미조인으로 적용. group은 세션 단위 실제 값(다수결 아님) — 유저가 두 그룹을 오가면
// 유저×그룹×tool로 행이 갈라진다(Users 페이지가 그룹별 카드로 나눠 보여줌).
export async function userToolUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT l.UserEmail AS user, ${GROUP_EXPR} AS "group", l.ToolName AS tool, count() AS uses
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result' AND l.UserEmail != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY user, "group", tool ORDER BY user, uses DESC`,
    // raw=true — otel_logs 직접 스캔(rollup 없음). mcpConnectorUsage/toolMcpUsage와 같은 이유로
    // 리뷰가 명시적으로 지적한 건 아니지만 동일 카테고리 버그라 같이 고친다.
    { ...range(from, to, true), ...f.params }
  );
}

// 유저별 어떤 skill을 얼마나 썼는지. (skillUsage와 동일한 이유로 cost.usage 기준 유지 — cost.usage는
// Model을 갖고 있어 model 필터도 걸 수 있다)
// 원본 테이블을 유지하는 유일한 스냅샷 쿼리 — invocations가 count()(원시 export-tick 행 수 근사)라
// 시간별 rollup으로 접으면 값이 달라진다. cost.usage+SkillName!='' 필터가 좁아 원본이어도 저렴.
// group은 세션 단위 실제 값(다수결 아님) — userToolUsage와 동일 이유.
export async function userSkillUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, ${GROUP_EXPR} AS "group", m.SkillName AS skill, count() AS invocations
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.MetricName = 'claude_code.cost.usage' AND m.SkillName != '' AND m.UserEmail != ''
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime} ${f.where}
    GROUP BY user, "group", skill ORDER BY user, invocations DESC`,
    // raw=true — otel_metrics_sum 원본 직접 스캔(rollup 없음), mcpConnectorUsage와 동일 이유.
    { ...range(from, to, true), ...f.params }
  );
}

// Trends 페이지: 일별 DAU/WAU/MAU 시계열. 롤링 윈도우(7일/30일)는 ClickHouse에서 일별 유저
// 집합만 뽑고 JS에서 접는다 — 유저 수가 수백 명 수준이라 집합 union이 싸고, SQL 셀프조인보다
// 단순하다. uniq류는 존재 여부만 보므로 시간별 rollup으로 접혀도 값이 같다(키 보존).
// 날짜 키는 toDate(..., 'UTC')로 고정 — JS는 toISOString()(UTC)로 롤링 union하므로 서버 TZ가
// UTC가 아니어도 하루 어긋나지 않는다(activity.js의 rollupAdoption이 그 규칙으로 접는다).
// excludeUnknown: false — activeUsers/adoptionLevels와 같은 "총계/DAU·WAU·MAU" 계열이라
// 그룹 무관 모수여야 한다. 빠뜨리면 이 시계열만 unknown ~11%가 빠져 Trends의 DAU/WAU/MAU가
// Overview 스냅샷(adoptionLevels)보다 낮게 나오는 모순이 생긴다(리뷰에서 MAJOR로 확인).
// 좌경계 fuzz는 activeUsers 위 주석과 동일(document 판정) — 여긴 30일 lookback의 시작점에만
// 영향을 줘 활동 밀도상 영향이 더 작다.
export async function adoptionTimeseries(from, to, filters = {}) {
  const f = filterCond({ ...filters, excludeUnknown: false }, { group: GROUP_EXPR, user: "m.UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT toDate(m.hour, 'UTC') AS d, groupUniqArray(m.UserEmail) AS users
    FROM claude_code.otel_metrics_sum_hourly m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.MetricName = 'claude_code.session.count' AND m.UserEmail != ''
      AND m.hour >= toStartOfHour({from:DateTime}) - INTERVAL 30 DAY AND m.hour < {to:DateTime} ${f.where}
    GROUP BY d ORDER BY d`,
    { ...range(from, to), ...f.params }
  );
  return rollupAdoption(rows, from, to);
}

// 유저 드릴다운: 특정 유저의 일별 세션/LOC/토큰/커밋 시계열. group을 넘기면 그 그룹 세션만 —
// Users 페이지의 리더보드 행이 이제 유저×그룹으로 갈라져 있어(userLeaderboard), 드로어를 그
// 행에서 열었을 때 상단 StatTile(그 행의 그룹 값)과 여기 시계열의 모수가 같아야 한다(안 그러면
// straddler의 한쪽 그룹 행을 열어도 양 그룹 합산 차트가 나와 숫자가 안 맞는다).
export async function userDaily(from, to, email, group) {
  const b = incBucket(24, `AND MetricName IN (
        'claude_code.session.count', 'claude_code.lines_of_code.count',
        'claude_code.token.usage', 'claude_code.commit.count'
      )`);
  // excludeUnknown: false — group 미지정(드로어를 그룹 무관 컨텍스트에서 열 때)이면 이 유저의
  // 전체 활동을 봐야 한다. 기본값(true)이면 group을 안 넘겨도 unknown 세션이 조용히 빠진다.
  const f = filterCond({ group, excludeUnknown: false }, { group: GROUP_EXPR });
  return query(
    `${GROUP_CTE}
    SELECT t,
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')       AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added') AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits
    FROM ${b.sub} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.UserEmail = {email:String} ${f.where}
    GROUP BY t ORDER BY t`,
    { ...range(from, to, b.raw), ...b.params, email, ...f.params }
  );
}

// 유저 드릴다운: 특정 유저의 도구별 수락/거부. userDaily/userHeatmap과 같은 exact match —
// 부분일치({user})면 kim@x.com 드로어에 joakim@x.com 데이터가 섞인다. group/excludeUnknown도
// userDaily와 같은 이유로 전달 — 안 그러면 group 미지정 시 이 차트만 unknown 세션을 제외해
// 드로어의 나머지 두 차트(전체 활동 기준)와 모수가 어긋난다.
export async function userDecisionsByTool(from, to, email, group) {
  return codeEditDecisionsByTool(from, to, { userExact: email, group, excludeUnknown: false });
}

// 유저 드릴다운: GitHub식 활동 히트맵 — to 기준 지난 91일(13주)의 일별 세션 수. group을 넘기면
// 그 그룹 세션만(userDaily와 동일 이유). 세션 수는 SessionId 존재 기반(uniqExact)이라
// temporality와 무관.
export async function userHeatmap(to, email, days = 91, group) {
  // excludeUnknown: false — group 미지정(드로어를 그룹 무관 컨텍스트에서 열 때)이면 이 유저의
  // 전체 활동을 봐야 한다. 기본값(true)이면 group을 안 넘겨도 unknown 세션이 조용히 빠진다.
  const f = filterCond({ group, excludeUnknown: false }, { group: GROUP_EXPR });
  return query(
    `${GROUP_CTE}
    SELECT toDate(m.hour, 'UTC') AS d, uniqExact(m.SessionId) AS sessions
    FROM claude_code.otel_metrics_sum_hourly m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.UserEmail = {email:String} AND m.MetricName = 'claude_code.session.count' AND m.SessionId != ''
      AND m.hour >= {to:DateTime} - INTERVAL {days:UInt32} DAY AND m.hour < {to:DateTime} ${f.where}
    GROUP BY d ORDER BY d`,
    { to: toChDateTime(to), email, days, ...f.params }
  );
}

// 패널10 확장: 유저별 리더보드 (생산성 점수는 이 raw 값을 productivity.js에서 계산). active_days는
// "존재하는 날짜 수"라 temporality와 무관 — rollup에서 바로 distinct count로 구해 별도 CTE로 조인.
// group은 세션 단위 실제 값(다수결 아님) — 유저가 두 그룹을 오가면 유저×그룹으로 행이 갈라진다
// (Users 페이지가 그룹별 리더보드로 나눠 보여줌). active_days는 두 CTE로 나눠 조인한다:
//   - active_days(UserEmail, group) — 표시 컬럼 "활성일"/점수의 그룹별 activeDayShare(가중
//     0.15)용. user 단위로만 조인하면 straddler의 그룹별 값이 유저 전체 활성일로 부푼다.
//   - active_days_user(UserEmail) — 그룹 무관 distinct 활성일. Executive.jsx의 orgScore가
//     유저×그룹 행을 user 단위로 접어 점수를 재계산할 때 쓴다 — 그룹별 값을 그냥 합산하면
//     같은 날 두 그룹 모두 활동한 유저의 그 날이 이중 계상되므로(리뷰에서 MAJOR로 확인),
//     distinct는 SQL에서 한 번에 구해 별도 컬럼(user_active_days)으로 내려준다.
export async function userLeaderboard(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  // active_days에도 같은 필터를 건다(컬럼 참조만 CTE 기준으로) — 안 걸면 group/model 필터 상태에서
  // sessions/loc는 필터되는데 활성일수(점수 가중치 0.15)만 전체 활동 기준이라 점수가 불일치한다.
  // 파라미터 이름/값이 f와 동일해 중복 병합은 무해.
  // active_days CTE의 MetricName='claude_code.session.count' 필터: "존재 여부"만 보므로 활동이
  // 있는 날엔 반드시 session.count 행이 있어(30초마다 재보고) 의미 손실이 없고(adoptionLevels/
  // userHeatmap과 동일 근거), 전체 metric을 스캔할 때보다 3배 빠르다(실측 2026-07-10: 8.0→2.5초 —
  // 필터가 없으면 이 쿼리가 워밍/실요청에서 ClickHouse 클라이언트 15초 타임아웃까지 갔다).
  // 좌경계 fuzz는 activeUsers 위 주석과 동일(document 판정) — 여기선 active_days가 생산성
  // 점수 가중치 0.15의 입력이라 극단적으로 좁은 커스텀 구간에서 ±1일 정도의 왜곡 가능성 인지.
  const fAd = filterCond(filters, { group: GROUP_EXPR, user: "UserEmail", modelMixed: { model: "Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE},
    active_days AS (
        SELECT UserEmail, ${GROUP_EXPR} AS "group", uniqExact(toDate(hour, 'UTC')) AS active_days
        FROM claude_code.otel_metrics_sum_hourly m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE UserEmail != '' AND MetricName = 'claude_code.session.count'
          AND hour >= toStartOfHour({from:DateTime}) AND hour < {to:DateTime} ${fAd.where}
        GROUP BY UserEmail, "group"
    ),
    -- 그룹 무관(유저 전체) distinct 활성일 — Executive.jsx의 orgScore가 유저×그룹 행을 다시
    -- user 단위로 접어 점수를 재계산할 때 쓴다. 위 active_days(그룹별)를 유저 단위로 그냥
    -- 합산하면 같은 날 두 그룹 모두 활동한 straddler의 그 날이 이중 계상된다(리뷰에서 MAJOR로
    -- 확인) — distinct 날짜는 SQL로 한 번에 구해야 정확하다.
    active_days_user AS (
        SELECT UserEmail, uniqExact(toDate(hour, 'UTC')) AS active_days
        FROM claude_code.otel_metrics_sum_hourly m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE UserEmail != '' AND MetricName = 'claude_code.session.count'
          AND hour >= toStartOfHour({from:DateTime}) AND hour < {to:DateTime} ${fAd.where}
        GROUP BY UserEmail
    )
    SELECT
        m.UserEmail AS user,
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')                                    AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')                                       AS tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')             AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')            AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added')      AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')                                      AS commits,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')                                AS prs,
        sumIf(m.Value, m.MetricName = 'claude_code.code_edit_tool.decision' AND m.Decision = 'accept')  AS accepted,
        sumIf(m.Value, m.MetricName = 'claude_code.code_edit_tool.decision')                            AS decisions,
        any(ad.active_days)                                                                             AS active_days,
        any(adu.active_days)                                                                            AS user_active_days
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.session.count', 'claude_code.token.usage', 'claude_code.lines_of_code.count',
        'claude_code.commit.count', 'claude_code.pull_request.count', 'claude_code.code_edit_tool.decision'
      )`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    LEFT JOIN active_days ad ON m.UserEmail = ad.UserEmail AND ${GROUP_EXPR} = ad."group"
    LEFT JOIN active_days_user adu ON m.UserEmail = adu.UserEmail
    WHERE m.UserEmail != '' ${f.where}
    GROUP BY user, "group" ORDER BY tokens DESC`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params, ...fAd.params }
  );
}

// =============================================================================
// 2026-08-11 스펙 동기화 — STEP 2/3/4 신규 패널의 앱 계층. 아래 함수들은 일부러 incFlat/
// incBucketed를 건드리지 않는다 — 그 두 함수는 40여 개 소비자가 공유하는 세션-경계 diff
// 엔진이고, 과거 리뷰에서 "3단 중첩 필수"/"first-bucket raw stitch" 같은 미묘한 버그를 여러
// 차례 겪은 코드다(위 주석 참고). AppVersion/EndUserId 같은 새 차원을 그 GROUP BY에 얹는
// 것도 이론적으로는 안전하지만(추가 차원은 다른 소비자의 재집계 결과를 바꾸지 않음), 검증
// 목적의 이 패널들까지 그 위험을 감수할 필요가 없어 각자 자기 완결적인 쿼리로 짠다.
// =============================================================================

// 4-2 검증: 버전 코호트별 세션 수 — 두 그룹이 실제로 같은 Claude Code 버전을 쓰는지 확인.
// sum(Value) 대신 uniqExact(SessionId)로 "존재 여부"만 본다(adoptionLevels와 동일 근거) —
// 세션 하나가 30초마다 재-export하는 session.count를 그대로 sum하면 안 된다.
export async function versionCohortSessions(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        AppVersion AS app_version,
        uniqExact(SessionId) AS sessions
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE MetricName = 'claude_code.session.count' AND AppVersion != ''
      AND TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime} ${f.where}
    GROUP BY "group", app_version ORDER BY "group", sessions DESC`,
    // raw=true — otel_metrics_sum 직접 스캔. 검증용 쿼리라 rollup 최적화(StartType/AppVersion이
    // 막 추가돼 과거분이 비어 있는 rollup)에 의존하지 않는 게 오히려 안전하다.
    { ...range(from, to, true), ...f.params }
  );
}

// 4-2 검증: 버전 코호트별 cost.usage/token.usage 실측 diff — v2.1.214 이전 이중계상 주장을
// 실측으로 검증한다(문서에 없는 주장이라 단정하지 않고 비율을 그대로 보여준다). incFlat과
// 동일한 세션-경계 diff 공식(greatest(끝값-시작값,0) / 구간 sumIf)을 AppVersion 그레인으로
// 로컬 복제 — LOOKBACK_DAYS도 incFlat과 동일 상수를 재사용해 baseline 정책을 맞춘다.
// 버전 비교는 문자열이 아니라 (major,minor,patch) 정수 튜플로 한다 — 문자열 사전순 비교는
// '2.1.30' < '2.1.214'를 false로 잘못 판정한다('3' > '2', 실제로는 30 < 214) — 지금
// 관측된 버전(2.1.202~2.1.226)이 전부 세 자리라 우연히 안 틀렸을 뿐이다. grafana-ab-queries.sql
// 패널 20과 동일한 수정.
export async function versionCohortCost(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        if(
            (toUInt32OrZero(splitByChar('.', app_version)[1]),
             toUInt32OrZero(splitByChar('.', app_version)[2]),
             toUInt32OrZero(splitByChar('.', app_version)[3])) < (2, 1, 214),
            'pre-2.1.214', '>=2.1.214'
        ) AS version_cohort,
        sum(inc_cost)   AS cost_usd,
        sum(inc_tokens) AS tokens,
        round(sum(inc_cost) / nullIf(sum(inc_tokens), 0) * 1000000, 4) AS usd_per_million_tokens
    FROM (
        SELECT SessionId, AppVersion AS app_version,
            sumIf(inc, MetricName = 'claude_code.cost.usage')  AS inc_cost,
            sumIf(inc, MetricName = 'claude_code.token.usage') AS inc_tokens
        FROM (
            SELECT ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, MetricName, AppVersion,
                if(temp = 2,
                    greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                    sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS inc
            FROM claude_code.otel_metrics_sum
            WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
              AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')
              AND AppVersion != ''
            GROUP BY sk, SessionId, temp, MetricName, AppVersion
        )
        GROUP BY SessionId, app_version
    ) m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", version_cohort ORDER BY "group", version_cohort`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 2 패널 13: 서브에이전트 팬아웃 — traces beta가 아니라 otel_logs의 subagent_completed로
// (오늘 실데이터 존재, 베타 플래그 불필요). PromptId(인터랙션 단위)당 완료 건수 분포.
export async function subagentFanout(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        count()                    AS subagent_completions,
        uniqExact(l.PromptId)      AS interactions,
        round(count() / nullIf(uniqExact(l.PromptId), 0), 2) AS avg_subagents_per_interaction
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'subagent_completed' AND l.PromptId != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 3 패널 14: 스킬 발동 분포 — skill.name × invocation_trigger. claude-proactive 비율이
// "우리가 만든 스킬이 실제로 자동 발동하는지"의 핵심 지표.
export async function skillActivations(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.SkillName AS skill,
        l.InvocationTrigger AS trigger,
        count() AS invocations
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'skill_activated'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", skill, trigger ORDER BY "group", invocations DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 3 패널 15: compaction 압박 — 세션당 발생 횟수 + 압축률(1 - post/pre tokens).
export async function compactionPressure(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.CompactionTrigger AS trigger,
        count() AS compactions,
        uniqExact(l.SessionId) AS sessions,
        round(count() / nullIf(uniqExact(l.SessionId), 0), 2) AS compactions_per_session,
        round(avg(1 - l.PostTokens / nullIf(l.PreTokens, 0)), 3) AS avg_compression_ratio
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'compaction' AND l.PreTokens > 0
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", trigger ORDER BY "group", compactions DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 3 패널 16: refusal 율 — server_fallback_hop='true'(사용자가 못 본 refusal)은
// user_visible_refusals에서 제외하고 별도 컬럼으로 둔다(최종 집계에 합산 금지).
export async function refusalRate(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        countIf(l.ServerFallbackHop != 'true') AS user_visible_refusals,
        countIf(l.ServerFallbackHop = 'true')  AS server_hidden_refusals
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'api_refusal'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 3 패널 17: 재시도 소진 — Bedrock 쿼터 병목 탐지에 직결.
export async function retriesExhausted(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        count() AS exhausted_retries,
        round(avg(l.TotalAttempts), 1)        AS avg_total_attempts,
        round(avg(l.TotalRetryDurationMs), 0) AS avg_retry_duration_ms
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'api_retries_exhausted'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 3 패널 18: 플러그인 인벤토리 — 그룹 무관, 플릿 전체에서 어떤 플러그인이 활성인지.
export async function pluginInventory(from, to) {
  return query(
    `SELECT PluginName AS plugin, MarketplaceName AS marketplace,
        count() AS session_loads, uniqExact(SessionId) AS sessions
    FROM claude_code.otel_logs
    WHERE EventName = 'plugin_loaded' AND PluginName != ''
      AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
    GROUP BY plugin, marketplace ORDER BY session_loads DESC`,
    range(from, to, true)
  );
}

// STEP 2 패널 11: 권한 대기 오버헤드 (traces beta) — claude_code.tool.blocked_on_user의
// DurationMs p50/p95, 그룹별. 이 스팬은 v2.1.214+에서만 나온다 — 결정 3(앞으로의 구현이
// 우선, 구버전 호환은 범위 밖)에 따라 데이터가 없는 구간은 0으로 위장하지 않고
// {unsupported:true}를 반환해 프론트가 "데이터 없음"으로 구분해 그릴 수 있게 한다.
export async function permissionWaitOverhead(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "t.UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        t.AppVersion AS app_version,
        quantile(0.5)(t.DurationMs)  AS p50_wait_ms,
        quantile(0.95)(t.DurationMs) AS p95_wait_ms,
        count() AS n
    FROM claude_code.otel_traces t
    LEFT JOIN session_group ug ON t.SessionId = ug.SessionId
    WHERE t.SpanType = 'tool.blocked_on_user'
      AND t.Timestamp >= {from:DateTime} AND t.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", app_version ORDER BY "group", app_version`,
    { ...range(from, to, true), ...f.params }
  );
  return rows.length ? { unsupported: false, rows } : { unsupported: true, minVersion: "2.1.214", rows: [] };
}

// STEP 2 패널 12: TTFT 비교 (traces beta) — claude_code.llm_request의 TtftMs p50/p95를
// 그룹 × 모델로. normModel()과 동일한 5단계 regex를 인라인 재현(JS 함수라 SQL에서 직접
// 호출 불가 — grafana-ab-queries.sql 패널 12와 동일한 이유).
export async function ttftComparison(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "t.UserEmail", model: "t.Model" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        ${normModel("t.Model")} AS model,
        quantile(0.5)(t.TtftMs)  AS p50_ttft_ms,
        quantile(0.95)(t.TtftMs) AS p95_ttft_ms,
        count() AS n
    FROM claude_code.otel_traces t
    LEFT JOIN session_group ug ON t.SessionId = ug.SessionId
    WHERE t.SpanType = 'llm_request'
      AND t.Timestamp >= {from:DateTime} AND t.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", model ORDER BY "group", n DESC`,
    { ...range(from, to, true), ...f.params }
  );
  return rows.length ? { unsupported: false, rows } : { unsupported: true, minVersion: null, rows: [] };
}

// STEP 3 패널 21: API 에러율 — 그룹 × 모델. Bedrock 스로틀링·검증 오류의 조기 신호로,
// 에러가 한쪽 그룹에만 몰리면 그 그룹의 생산성 하락이 "플랫폼 특성"이 아니라 "장애"다.
// api_request/api_error는 로그 이벤트라 누적 카운터가 아니다 — refusalRate/retriesExhausted와
// 동일하게 incFlat/incBucketed 없이 그대로 센다.
//
// 분모 선택(errors / (requests + errors)): api_request가 실패 요청까지 포함하는지(= api_error가
// 부분집합인지)는 문서에도 실측에도 없다. 실측 2026-08-31: api_request 176,597행 / api_error
// 580행이라 두 해석의 상대 차이는 0.33%로 이 패널의 해석 정밀도보다 훨씬 작다. 합집합을 분모로
// 쓰는 이유는 정확도가 아니라 안전성이다 — 두 해석 중 어느 쪽이든 값이 [0,1]을 벗어나지 않는다
// (disjoint일 때 errors/requests는 에러가 폭증하면 1을 넘어 "에러율 137%"가 나온다).
// requests/errors 원본 카운트를 같이 내려 소비자가 다른 분모로 재계산할 수 있게 남긴다.
//
// 실측 2026-08-31(mapKeys(LogAttributes)): api_error는 model·error·duration_ms·attempt 키가
// 100%, status_code는 545/580(94%). api_request는 model 키 100%. otel_logs엔 Model 승격 컬럼이
// 없어 LogAttributes['model']을 normModel()로 정규화한다(ttftComparison이 otel_traces의 Model에
// 하는 것과 같은 5단계 규칙).
export async function apiErrors(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  const params = { ...range(from, to, true), ...f.params };
  const [byModel, byStatus] = await Promise.all([
    query(
      `${GROUP_CTE}
      SELECT
          ${GROUP_EXPR} AS "group",
          ${normModel("l.LogAttributes['model']")} AS model,
          countIf(l.EventName = 'api_request') AS requests,
          countIf(l.EventName = 'api_error')   AS errors,
          count()                              AS total,
          round(errors / nullIf(total, 0), 4)  AS error_rate
      FROM claude_code.otel_logs l
      LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
      WHERE l.EventName IN ('api_request', 'api_error')
        AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
      GROUP BY "group", model ORDER BY "group", total DESC`,
      params
    ),
    // status_code가 빈 문자열인 에러(실측 2026-08-31: 580건 중 35건)는 HTTP 상태가 아예 없는
    // 전송 계층 실패(예: Stream idle timeout)다 — 버리면 가장 중요한 케이스가 사라지므로
    // 'no-http-status' 센티널로 따로 남긴다(프론트가 이 리터럴을 그대로 분기한다).
    query(
      `${GROUP_CTE}
      SELECT
          ${GROUP_EXPR} AS "group",
          if(l.LogAttributes['status_code'] = '', 'no-http-status', l.LogAttributes['status_code']) AS status_code,
          count() AS errors
      FROM claude_code.otel_logs l
      LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
      WHERE l.EventName = 'api_error'
        AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
      GROUP BY "group", status_code ORDER BY "group", errors DESC`,
      params
    ),
  ]);
  return { byModel, byStatus };
}

// STEP 3 패널 22: 툴 권한 결정 퍼널 — tool_decision 이벤트를 툴 × 허용 출처(source) × 수락/거부로
// 분해한다. source가 핵심 지표다: config는 사전 허용(개발자를 안 멈춤), user_temporary는 매번
// 물어봤다는 뜻(권한 대기로 생산성이 깎임), user_permanent는 사용자가 직접 허용목록에 넣은 것.
// 실측 2026-08-31: tool_decision 169,862행, tool_name/decision/source 키 전부 100%.
//
// decision(accept/reject)을 행 차원이 아니라 countIf 컬럼으로 펴는 이유: refusalRate와 동일한
// 스타일이고, 그래야 accept_rate가 행마다 바로 나온다(decision이 행이면 비율이 얹힐 행이 없다).
// n = count()를 같이 두는 건 n != accepts + rejects인 행이 보이면 accept/reject 외의 decision
// 값이 새로 생겼다는 신호이기 때문 — 실측 시점엔 두 값뿐이다.
// tool_name은 승격 컬럼 ToolName(= LogAttributes['tool_name'])을 쓴다(toolMcpUsage와 동일).
// 상위 20개 툴 서브쿼리는 그룹을 안 나눈다 — 그룹별 상위 20개를 뽑으면 두 그룹의 툴 집합이
// 달라져 A/B 비교 자체가 성립하지 않는다.
export async function toolDecisionFunnel(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.ToolName AS tool,
        l.LogAttributes['source'] AS source,
        countIf(l.LogAttributes['decision'] = 'accept') AS accepts,
        countIf(l.LogAttributes['decision'] = 'reject') AS rejects,
        count() AS n,
        round(accepts / nullIf(accepts + rejects, 0), 3) AS accept_rate
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_decision' AND l.ToolName != ''
      AND l.ToolName IN (
          SELECT ToolName FROM claude_code.otel_logs
          WHERE EventName = 'tool_decision' AND ToolName != ''
            AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
          GROUP BY ToolName ORDER BY count() DESC LIMIT 20
      )
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", tool, source ORDER BY "group", n DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// STEP 2 패널 23: 인터랙션 시간 분해 (traces beta) — claude_code.interaction 스팬의 DurationMs
// p50/p95와, 그 시간 중 자식 스팬(llm_request / tool.execution / tool.blocked_on_user)이 차지한
// 시간의 비중. "느린 게 모델 때문인가, 툴 실행 때문인가, 권한 대기 때문인가"를 한 표로 가른다.
//
// 자식은 TraceId로 붙인다(한 인터랙션의 스팬들은 TraceId를 공유하고 interaction 스팬이 루트).
// 자식을 TraceId 단위로 먼저 접은 뒤 1:1로 조인하는 게 필수다 — SpanType별 자식 행을 그대로
// 조인하면 interaction 행이 자식 종류 수만큼 복제돼 quantile과 분모 sum(i.DurationMs)가 그 배수로
// 뻥튀기된다. join_use_nulls=0이라 자식이 없는 인터랙션은 NULL이 아니라 0으로 들어와 그대로 합산된다.
//
// 비중 합계는 1을 넘을 수 있다 — 자식 스팬은 동시에 진행될 수 있고, tool 스팬의 duration_ms는
// 권한 대기 + 실행을 함께 담는다(clickhouse-schema.sql 2c 주석). "구성비"가 아니라 "인터랙션 총
// 시간 대비 각 종류가 쓴 시간의 배수"로 읽어야 한다.
// 실측 2026-09-04(첫 트레이스 유입, v2.1.260): SpanType(span.type 속성)은 접두어 없는
// 'interaction'/'llm_request'/'tool.execution'/'tool.blocked_on_user'이고, 'claude_code.' 접두어는
// SpanName 쪽에만 붙는다 — 문서를 따라 접두어 값으로 필터하던 초기 구현은 데이터가 있어도 0행이라
// 세 패널이 "미수집"으로 남았다. interaction 스팬은 duration_ms 속성이 없어(DurationMs=0) 스팬
// 자체의 Duration(ns) 컬럼을 ms로 환산해 쓴다 — 자식 스팬은 두 값이 같다(실측 avg 동일).
// interaction 5건 모두 ParentSpanId=''(루트)였지만 조건은 SpanType만으로 둔다 — 조건을 더 걸어
// 패널이 조용히 비는 쪽이 더 위험하다.
// 트레이스는 CLAUDE_CODE_ENHANCED_TELEMETRY_BETA가 켜진 클라이언트에서만 온다 — ttftComparison/
// permissionWaitOverhead와 동일하게 {unsupported:true}를 반환해 프론트가 "0"과 "미수집"을
// 구분할 수 있게 한다. minVersion "2.1.214"는 tool.blocked_on_user / tool.execution 스팬이
// 그 버전부터 나오기 때문(문서 확인).
export async function interactionBreakdown(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "i.UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        count() AS interactions,
        quantile(0.5)(i.DurationMs)  AS p50_interaction_ms,
        quantile(0.95)(i.DurationMs) AS p95_interaction_ms,
        round(sum(c.llm_ms)       / nullIf(sum(i.DurationMs), 0), 3) AS llm_share,
        round(sum(c.tool_exec_ms) / nullIf(sum(i.DurationMs), 0), 3) AS tool_exec_share,
        round(sum(c.blocked_ms)   / nullIf(sum(i.DurationMs), 0), 3) AS blocked_share
    FROM (
        SELECT TraceId, SessionId, UserEmail, intDiv(Duration, 1000000) AS DurationMs
        FROM claude_code.otel_traces
        WHERE SpanType = 'interaction'
          AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
    ) i
    LEFT JOIN (
        SELECT TraceId,
            sumIf(DurationMs, SpanType = 'llm_request')          AS llm_ms,
            sumIf(DurationMs, SpanType = 'tool.execution')       AS tool_exec_ms,
            sumIf(DurationMs, SpanType = 'tool.blocked_on_user') AS blocked_ms
        FROM claude_code.otel_traces
        WHERE SpanType IN ('llm_request', 'tool.execution', 'tool.blocked_on_user')
          AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
        GROUP BY TraceId
    ) c ON i.TraceId = c.TraceId
    LEFT JOIN session_group ug ON i.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, true), ...f.params }
  );
  return rows.length ? { unsupported: false, rows } : { unsupported: true, minVersion: "2.1.214", rows: [] };
}

// =============================================================================
// 2026-09-01 추가 패널. Effort/Language/AgentName은 incFlat/incBucketed가 안 나르는
// 차원이다 — ADR-001에 따라 GROUP BY를 넓히지 않고 versionCohortCost와 동일한 자기완결
// 로컬 diff 서브쿼리(세션-경계 diff, LOOKBACK_DAYS 재사용)로 짠다.
// =============================================================================

// 활성 사용시간 스냅샷 — active_time.total의 type attribute('user'|'cli')는 token.usage와
// 같은 승격 컬럼(TokenType)에 실린다(실측 7d: cli 123h, user 2.8h). TokenType은 incFlat이
// 이미 나르는 차원이라 로컬 diff 불필요.
export async function activeTimeSummary(from, to, filters = {}) {
  // active_time.total 행엔 Model attribute가 없다 — activeTimeSeries와 동일하게 modelMixed.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.TokenType = 'user') AS user_seconds,
        sumIf(m.Value, m.TokenType = 'cli')  AS cli_seconds,
        uniqExactIf(m.SessionId, m.SessionId != '') AS sessions
    FROM ${incFlat(`AND MetricName = 'claude_code.active_time.total'`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
}

// effort별 비용/토큰 — cost는 계산 비용(토큰 × pricing.js 단가, 이 페이지의 다른 Cost 카드와
// 동일 기준)이고 reported_cost는 Claude Code 자체 보고값(대조용)이다. 실측 2026-09-03:
// v2.1.251은 fable-5-1을 opus-5 단가로 보고해 보고 비용이 정가의 약 0.5×, v2.1.258은 정가 —
// 보고 비용은 클라이언트 버전에 종속이라 패널 기준으로 쓸 수 없다. Speed 컬럼은 실측 0행(이
// 플릿은 fast 모드 미사용)이라 안 본다. effort ''(실측 7d cost 578)는 effort attribute가 없는
// 행 — 'unknown'으로 묶는다. 단가를 고르려면 model 그레인이 필요해서 바깥 SELECT에
// normModel(m.Model)과 TokenType별 토큰 컬럼을 두고, group × effort까지는 JS에서
// rollupComputedCost로 접는다(TokenType은 이미 SeriesKey에 포함돼 있어 GROUP BY에 추가해도
// 행이 늘지 않는다 — incFlat 내부 서브쿼리와 동일한 패턴). m.Model != '' 필터는 일부러 걸지
// 않는다 — 걸면 보고 비용까지 조용히 빠진다. model이 빈 행은 unpriced_tokens로 드러난다.
export async function effortMix(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        if(m.Effort = '', 'unknown', m.Effort) AS effort,
        ${normModel("m.Model")} AS model,
        sumIf(m.inc, m.MetricName = 'claude_code.cost.usage')                                     AS reported_cost,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')         AS input_tokens,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')        AS output_tokens,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheRead')     AS cache_read_tokens,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheCreation') AS cache_write_tokens
    FROM (
        SELECT ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, MetricName, Model, Effort, TokenType, any(UserEmail) AS UserEmail,
            if(temp = 2,
                greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS inc
        FROM claude_code.otel_metrics_sum
        WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
          AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')
        GROUP BY sk, SessionId, temp, MetricName, Model, Effort, TokenType
    ) m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", effort, model ORDER BY "group", effort`,
    { ...range(from, to, true), ...f.params }
  );
  return rollupComputedCost(rows, ["group", "effort"]).sort((a, b) => a.group.localeCompare(b.group) || b.cost - a.cost);
}

// 언어별 편집 수락 — Language는 incFlat 미탑재 차원이라 effortMix와 동일한 로컬 diff
// (Decision은 incFlat에 있지만 Language와 함께 나와야 해 같이 로컬로 뽑는다).
// 실측 top에 리터럴 'unknown'이 이미 존재 — ''도 같은 의미라 한 행으로 합친다.
export async function languageBreakdown(from, to, filters = {}) {
  // code_edit_tool.decision 행엔 Model attribute가 없다 — codeEditDecisions와 동일하게 modelMixed.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        if(m.Language = '', 'unknown', m.Language) AS language,
        sum(m.inc) AS edits,
        sumIf(m.inc, m.Decision = 'accept') AS accepted
    FROM (
        SELECT ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, Model, Language, Decision, any(UserEmail) AS UserEmail,
            if(temp = 2,
                greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS inc
        FROM claude_code.otel_metrics_sum
        WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
          AND MetricName = 'claude_code.code_edit_tool.decision'
        GROUP BY sk, SessionId, temp, Model, Language, Decision
    ) m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", language ORDER BY "group", edits DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// API 지연 p50/p95 — api_request는 로그 이벤트라 누적 카운터가 아니다(apiErrors와 동일).
// duration_ms/model/effort 전부 비승격 LogAttributes(실측 7d: p50 5968ms / p95 36262ms) —
// model은 apiErrors와 같은 normModel() 정규화가 필요하다. 한 스캔의 두 그레인(모델/effort)이라
// apiErrors의 키드 객체 패턴을 따른다 — 소비자는 data?.byModel || [].
export async function apiLatency(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  const params = { ...range(from, to, true), ...f.params };
  const dur = "toFloat64OrZero(l.LogAttributes['duration_ms'])";
  const [byModel, byEffort] = await Promise.all([
    query(
      `${GROUP_CTE}
      SELECT
          ${GROUP_EXPR} AS "group",
          ${normModel("l.LogAttributes['model']")} AS model,
          count() AS requests,
          round(quantile(0.5)(${dur}))  AS p50_ms,
          round(quantile(0.95)(${dur})) AS p95_ms
      FROM claude_code.otel_logs l
      LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
      WHERE l.EventName = 'api_request'
        AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
      GROUP BY "group", model ORDER BY "group", requests DESC`,
      params
    ),
    query(
      `${GROUP_CTE}
      SELECT
          ${GROUP_EXPR} AS "group",
          if(l.LogAttributes['effort'] = '', 'unknown', l.LogAttributes['effort']) AS effort,
          count() AS requests,
          round(quantile(0.5)(${dur}))  AS p50_ms,
          round(quantile(0.95)(${dur})) AS p95_ms
      FROM claude_code.otel_logs l
      LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
      WHERE l.EventName = 'api_request'
        AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
      GROUP BY "group", effort ORDER BY "group", requests DESC`,
      params
    ),
  ]);
  return { byModel, byEffort };
}

// 툴 실행 지연/에러 — errors는 Success='false'와 error attribute 존재를 합집합으로 센다:
// 승격 Success만 보면 에러 메시지만 있고 Success가 안 찍힌 행을 놓친다(실측: Bash p50 281 /
// p95 5008ms). LIMIT 50은 toolMcpUsage와 동일한 상한.
export async function toolLatency(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.ToolName AS tool,
        count() AS uses,
        countIf(l.Success = 'false' OR l.LogAttributes['error'] != '') AS errors,
        round(quantile(0.5)(l.DurationMs))  AS p50_ms,
        round(quantile(0.95)(l.DurationMs)) AS p95_ms
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", tool ORDER BY "group", uses DESC LIMIT 50`,
    { ...range(from, to, true), ...f.params }
  );
}

// 슬래시 커맨드 도입 + 프롬프트 길이 — user_prompt 한 스캔의 두 그레인(커맨드별/그룹 요약)이라
// apiErrors의 키드 객체 패턴. command_name = ''(일반 자연어 프롬프트)는 commands에선 제외하고
// prompts 요약에는 포함한다.
export async function commandAdoption(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  const params = { ...range(from, to, true), ...f.params };
  const len = "toFloat64OrZero(l.LogAttributes['prompt_length'])";
  const [commands, prompts] = await Promise.all([
    query(
      `${GROUP_CTE}
      SELECT
          ${GROUP_EXPR} AS "group",
          l.LogAttributes['command_name'] AS command,
          count() AS uses,
          uniqExactIf(l.UserEmail, l.UserEmail != '') AS users
      FROM claude_code.otel_logs l
      LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
      WHERE l.EventName = 'user_prompt' AND l.LogAttributes['command_name'] != ''
        AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
      GROUP BY "group", command ORDER BY "group", uses DESC`,
      params
    ),
    query(
      `${GROUP_CTE}
      SELECT
          ${GROUP_EXPR} AS "group",
          count() AS prompts,
          round(quantile(0.5)(${len}))  AS p50_len,
          round(quantile(0.95)(${len})) AS p95_len
      FROM claude_code.otel_logs l
      LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
      WHERE l.EventName = 'user_prompt'
        AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
      GROUP BY "group" ORDER BY "group"`,
      params
    ),
  ]);
  return { commands, prompts };
}

// 훅 오버헤드 — total_duration_ms/num_blocking은 비승격 LogAttributes(실측 7d: 총 13888s,
// p95 213ms). blocked는 "블로킹 훅이 1개 이상 걸린 실행 수"(num_blocking>0인 행 카운트) —
// num_blocking 합산이 아니라 실행 단위로 세야 executions와 같은 분모로 비율이 된다.
export async function hookOverhead(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  const dur = "toFloat64OrZero(l.LogAttributes['total_duration_ms'])";
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        count() AS executions,
        round(sum(${dur}) / 1000, 1) AS total_seconds,
        round(quantile(0.95)(${dur})) AS p95_ms,
        countIf(toFloat64OrZero(l.LogAttributes['num_blocking']) > 0) AS blocked
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'hook_execution_complete'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to, true), ...f.params }
  );
}

// MCP 연결 헬스 — mcp_server_connection은 서버명이 승격 McpServerName(tool_result의
// mcp_server.name)이 아니라 LogAttributes['server_name']에 실린다. status는 connected/failed/
// disconnected 세 값(실측 7d: connected 1229, failed 56) — disconnected는 attempts에만 잡혀
// attempts != connected + failed일 수 있다(의도된 동작).
export async function mcpHealth(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.LogAttributes['server_name'] AS server,
        count() AS attempts,
        countIf(l.LogAttributes['status'] = 'connected') AS connected,
        countIf(l.LogAttributes['status'] = 'failed')    AS failed,
        round(quantile(0.95)(toFloat64OrZero(l.LogAttributes['duration_ms']))) AS p95_ms
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'mcp_server_connection'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", server ORDER BY "group", attempts DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// 에이전트(서브에이전트)별 비용/토큰 — AgentName은 incFlat 미탑재 차원이라 effortMix와 동일한
// 로컬 diff(실측 7d: AgentName 비어있지 않은 행 4.56M). ''는 메인 스레드 귀속 — 'main'으로
// 표기한다. cost/reported_cost의 의미와 model 그레인 · rollupComputedCost 접기는 effortMix와
// 동일하다(실측 2026-09-03: 보고 비용은 클라이언트 버전에 종속 — v2.1.251이 fable-5-1을
// opus-5 단가로 보고). 상위 30개 절단은 접은 뒤 JS에서 한다 — SQL LIMIT은 model로 쪼개진
// 행에 걸려서 에이전트 하나의 비용이 잘린다.
export async function agentCost(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        if(m.AgentName = '', 'main', m.AgentName) AS agent,
        ${normModel("m.Model")} AS model,
        sumIf(m.inc, m.MetricName = 'claude_code.cost.usage')                                     AS reported_cost,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')         AS input_tokens,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')        AS output_tokens,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheRead')     AS cache_read_tokens,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheCreation') AS cache_write_tokens
    FROM (
        SELECT ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, MetricName, Model, AgentName, TokenType, any(UserEmail) AS UserEmail,
            if(temp = 2,
                greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS inc
        FROM claude_code.otel_metrics_sum
        WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
          AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')
        GROUP BY sk, SessionId, temp, MetricName, Model, AgentName, TokenType
    ) m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", agent, model ORDER BY "group", agent`,
    { ...range(from, to, true), ...f.params }
  );
  return rollupComputedCost(rows, ["group", "agent"]).sort((a, b) => b.cost - a.cost).slice(0, 30);
}

// =============================================================================
// 2026-09-04 추가 패널. otel_logs api_request(보고 비용 vs 계산 비용, AppVersion 그레인)와
// otel_traces 인터랙션 드릴다운(유저 1명의 턴별 워터폴).
// =============================================================================

// 버전별 보고 비용 vs 계산 비용 — cost_usd는 클라이언트 자체 단가표로 클라이언트 사이드에서
// 매겨지므로 AppVersion에 종속된다(실측 2026-09-03: v2.1.251이 claude-fable-5-1을 opus-5
// 단가로 보고, ≈0.5×). model:은 modelViaSession:이 아니라 l.LogAttributes['model'] 그 자체를
// 쓴다 — api_request는 다른 otel_logs 이벤트(apiErrors/mcpHealth/hookOverhead)와 달리 model
// 속성을 행의 100%에 갖고 있다(실측 2026-09-04). cache_creation_tokens는 로그 속성명이고
// withComputedCost는 cache_write_tokens를 읽으므로 별칭이 곧 가격 계산의 전제조건이다. 단가표
// 밖 모델도 행을 버리지 않는다 — cost/ratio가 null일 뿐이다.
export async function reportedVsComputedByVersion(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", model: "l.LogAttributes['model']" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.AppVersion AS app_version,
        ${normModel("l.LogAttributes['model']")} AS model,
        count() AS requests,
        sum(toFloat64OrZero(l.LogAttributes['cost_usd']))             AS reported_cost,
        sum(toUInt64OrZero(l.LogAttributes['input_tokens']))          AS input_tokens,
        sum(toUInt64OrZero(l.LogAttributes['output_tokens']))         AS output_tokens,
        sum(toUInt64OrZero(l.LogAttributes['cache_read_tokens']))     AS cache_read_tokens,
        sum(toUInt64OrZero(l.LogAttributes['cache_creation_tokens'])) AS cache_write_tokens
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'api_request'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", app_version, model ORDER BY requests DESC`,
    { ...range(from, to, true), ...f.params }
  );
  return withComputedCost(rows).map((r) => ({
    ...r,
    ratio: r.cost > 0 ? Number(r.reported_cost) / r.cost : null,
  }));
}

// 유저 1명의 턴별 워터폴 — "왜 이 세션이 느렸나"에 답한다. interactionBreakdown과 동일한
// TraceId 자식 접기를 쓰지만, 자식 서브쿼리에는 일부러 SpanType 필터가 없다 — AgentId는
// 스팬 타입을 가리지 않고 실린다(실측 2026-09-04). SpanType 필터를 걸면 agents가 과소집계된다.
// SpanType 값은 접두사 없이 'interaction'/'llm_request'/'tool'/'tool.execution'/
// 'tool.blocked_on_user'로 온다 — claude_code. 접두사는 SpanName에만 붙는다. ParentAgentId는
// 라이브 데이터에서 한 번도 채워진 적이 없다(실측 2026-09-04: 0행) — 그래서 에이전트 깊이/트리는
// 도출할 수 없고, 인터랙션당 distinct 에이전트 수만 도출 가능하다. llm/tool/blocked 세 구간은
// 서로 겹칠 수 있어(tool 스팬의 duration_ms가 대기+실행을 함께 담음) 합이 interaction_ms를
// 넘을 수 있다 — interactionBreakdown과 동일한 주의사항.
export async function userInteractions(from, to, email) {
  const rows = await query(
    `SELECT
        i.SessionId    AS session_id,
        i.TraceId      AS trace_id,
        i.started_at   AS started_at,
        i.DurationMs   AS interaction_ms,
        c.llm_ms       AS llm_ms,
        c.tool_exec_ms AS tool_exec_ms,
        c.blocked_ms   AS blocked_ms,
        c.agents       AS agents,
        c.llm_calls    AS llm_calls
    FROM (
        SELECT TraceId, SessionId, Timestamp,
            formatDateTime(Timestamp, '%Y-%m-%d %H:%i:%S', 'UTC') AS started_at,
            intDiv(Duration, 1000000) AS DurationMs
        FROM claude_code.otel_traces
        WHERE SpanType = 'interaction' AND UserEmail = {email:String}
          AND Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
    ) i
    LEFT JOIN (
        SELECT TraceId,
            sumIf(DurationMs, SpanType = 'llm_request')          AS llm_ms,
            sumIf(DurationMs, SpanType = 'tool.execution')       AS tool_exec_ms,
            sumIf(DurationMs, SpanType = 'tool.blocked_on_user') AS blocked_ms,
            uniqExactIf(AgentId, AgentId != '')                  AS agents,
            countIf(SpanType = 'llm_request')                    AS llm_calls
        FROM claude_code.otel_traces
        WHERE Timestamp >= {from:DateTime} AND Timestamp < {to:DateTime}
        GROUP BY TraceId
    ) c ON i.TraceId = c.TraceId
    ORDER BY i.Timestamp DESC LIMIT 200`,
    { ...range(from, to, true), email }
  );
  return rows.length ? { unsupported: false, rows } : { unsupported: true, minVersion: "2.1.214", rows: [] };
}

// =============================================================================
// 2026-09-09 추가 패널 — project.name / app.entrypoint (clickhouse-migration-005.sql).
// ProjectName은 incFlat/incBucketed가 나르지 않는 차원이고 시간별 롤업에도 없다(005는 롤업을
// 건드리지 않는다) — ADR-001에 따라 그 GROUP BY를 넓히지 않고 versionCohortCost/effortMix와
// 동일한 자기완결 로컬 diff 서브쿼리(세션-경계 diff, LOOKBACK_DAYS 재사용)로 짠다.
// 나머지 세 개는 otel_logs 직접 스캔이라 005 컬럼 유무와 무관하게 동작한다 — project 필터만
// ProjectName을 참조하고, 그 필터는 컬럼이 없는 클러스터에서는 parseFilters가 버린다.
// =============================================================================

// 프로젝트(저장소)별 사용 — group × ProjectName. 비용은 Claude Code 보고값(cost.usage)이다.
// 계산 비용(토큰 × pricing.js 단가)을 쓰지 않는 이유: 단가를 고르려면 바깥 SELECT에 model
// 그레인이 필요하고(effortMix가 그렇게 한다), 그러면 같은 SELECT에서 uniqExact(SessionId)/
// users를 프로젝트 그레인으로 접을 수 없다(유니크는 합산이 안 된다). 세션·사용자 수가 이
// 패널의 핵심이라 그쪽을 지키고, 보고 비용이 클라이언트 버전에 종속이라는 사실(실측 2026-09-03)
// 은 프론트 라벨과 help에 적는다 — 같은 페이지의 "Skill 사용 분포"와 동일한 규약이다.
// 사용자 식별자는 ADR-002의 Bedrock 폴백(UserEmail이 비면 EndUserId)을 쓴다 — 이 파일에서
// 처음이며, ADR-002 결정대로 기존 ~90개 UserEmail 참조에는 소급 적용하지 않는다.
// 세션·사용자 수는 in_range로 게이트한다: 내부 서브쿼리가 LOOKBACK_DAYS만큼 앞의 baseline 행까지
// 읽으므로 구간 전에 끝난 세션도 inc=0인 행으로 남아, 비용·토큰은 0인데 세션 수만 부풀었다
// (PR #31 리뷰에서 MAJOR로 확인). 게이트를 inc > 0으로 걸지 않는 이유: 구간 안에 활동은 있었지만
// 카운터가 안 움직인 세션(유휴 하트비트)이 빠진다. 실측(2026-09-10, 24.8.14.39): baseline만 있는
// 세션을 섞은 픽스처에서 같은 프로젝트의 sessions/users가 2/2 → 1/1로 줄고 cost/tokens(4/400)는
// 그대로였다. 부작용으로, 구간 안 활동이 전혀 없는 프로젝트는 사라지지 않고 전부 0인 행이 된다.
export async function projectBreakdown(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.user_id", model: "m.Model", project: "m.ProjectName" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        if(m.ProjectName = '', '${UNTAGGED_PROJECT}', m.ProjectName) AS project,
        sumIf(m.inc, m.MetricName = 'claude_code.cost.usage')  AS cost_usd,
        sumIf(m.inc, m.MetricName = 'claude_code.token.usage') AS tokens,
        uniqExactIf(m.SessionId, m.in_range) AS sessions,
        uniqExactIf(m.user_id, m.user_id IS NOT NULL AND m.in_range) AS users
    FROM (
        SELECT ${seriesKey} AS sk, SessionId, AggregationTemporality AS temp, MetricName, Model, ProjectName,
            any(coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, ''))) AS user_id,
            countIf(TimeUnix >= {from:DateTime}) > 0 AS in_range,
            if(temp = 2,
                greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS inc
        FROM claude_code.otel_metrics_sum
        WHERE TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
          AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')
        GROUP BY sk, SessionId, temp, MetricName, Model, ProjectName
    ) m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", project ORDER BY "group", cost_usd DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// 권한 모드 전환 — permission_mode_changed 이벤트(실측 2026-09-09: 30일 25행, bypassPermissions
// →auto 38 / plan→auto 34 등). from_mode/to_mode는 승격 컬럼이 아니라 LogAttributes다.
// 값을 정규화하거나 매핑하지 않고 그대로 내려보낸다 — Claude Code가 새 모드 이름을 추가하면
// 빈 셀이 아니라 그 이름이 보이는 쪽이 낫다(프론트의 라벨 매퍼도 같은 규약).
export async function permissionModeChanges(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId", project: "l.ProjectName" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.LogAttributes['from_mode'] AS from_mode,
        l.LogAttributes['to_mode']   AS to_mode,
        count() AS changes,
        uniqExact(l.SessionId) AS sessions
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'permission_mode_changed'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", from_mode, to_mode ORDER BY "group", changes DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// 도구 승인 출처 — tool_result의 decision_source/decision_type(실측 2026-09-09: 30일 8,195행,
// config 75,334 vs 사용자 승인 386). toolDecisionFunnel(tool_decision 이벤트의 source)과 다른
// 이벤트다: 이쪽은 "실제로 실행된 도구가 어떤 승인 경로로 통과했는지"이고 hook 값이 추가로
// 있다. decision_source가 빈 행(속성이 없는 실행)은 제외한다 — 분모에 넣으면 '승인 경로'
// 비중이 아니라 '속성을 실은 비율'이 된다.
// share의 분모는 같은 채널의 전체 건수다 — GROUP BY 결과 위에서 윈도우 함수로 계산한다
// (24.8에서 실행 확인). 채널별로 정규화해야 두 채널의 승인 습관을 비교할 수 있다.
export async function toolDecisionSources(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId", project: "l.ProjectName" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        l.LogAttributes['decision_source'] AS decision_source,
        l.LogAttributes['decision_type']   AS decision_type,
        count() AS tool_results,
        round(count() / sum(count()) OVER (PARTITION BY "group"), 3) AS share
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result' AND l.LogAttributes['decision_source'] != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", decision_source, decision_type ORDER BY "group", tool_results DESC`,
    { ...range(from, to, true), ...f.params }
  );
}

// 진입점 — api_request의 app.entrypoint(실측 2026-09-09, 프로드 14일: 'vscode' 29,938행,
// 터미널 세션은 빈 값). 005의 승격 컬럼 Entrypoint를 쓰지 않고 LogAttributes를 직접 읽는다:
// 승격 컬럼의 정의가 곧 이 맵 조회라 값이 정의상 동일하고(실측 2026-09-09: 전 행 mismatch=0,
// ADD COLUMN 이전 파트 포함), 그래야 이 패널이 005 미적용 클러스터에서도 그대로 동작한다.
// 승격 컬럼은 애드혹/Grafana 쿼리와 향후 필터를 위한 것이다.
// cost_usd는 Claude Code가 이벤트에 실은 보고값이다(reportedVsComputedByVersion과 같은 소스) —
// 계산 비용이 아니므로 프론트 라벨에 그 사실을 적는다.
// model 필터는 세션 세미조인(modelViaSession)이 아니라 행 단위 l.LogAttributes['model']이다 —
// api_request는 전 행에 model 속성이 있어(실측 2026-09-04, 100%) reportedVsComputedByVersion과
// 같은 규칙을 쓸 수 있다. 세미조인이면 한 세션이 A·B 두 모델을 쓴 경우 B의 requests/cost가 A
// 필터에도 합산된다(실측 2026-09-10, 24.8.14.39 픽스처: sonnet 필터에서 vscode requests 2·
// cost $1.00, 행 단위로는 1·$0.10). permissionModeChanges/toolDecisionSources는 그 이벤트에
// model 속성이 없어 세미조인을 유지한다(PR #31 리뷰에서 MAJOR로 확인).
export async function entrypointBreakdown(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", model: "l.LogAttributes['model']", project: "l.ProjectName" });
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        if(l.LogAttributes['app.entrypoint'] = '', 'terminal', l.LogAttributes['app.entrypoint']) AS entrypoint,
        count() AS requests,
        uniqExact(l.SessionId) AS sessions,
        sum(toFloat64OrZero(l.LogAttributes['cost_usd'])) AS cost_usd,
        uniqExactIf(coalesce(nullIf(l.UserEmail, ''), nullIf(l.EndUserId, '')),
                    coalesce(nullIf(l.UserEmail, ''), nullIf(l.EndUserId, '')) IS NOT NULL) AS users
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'api_request'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY "group", entrypoint ORDER BY "group", requests DESC`,
    { ...range(from, to, true), ...f.params }
  );
}
