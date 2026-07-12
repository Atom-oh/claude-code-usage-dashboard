import { query, toChDateTime } from "./clickhouse.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { withComputedCost, normalizeModelId } from "./pricing.js";
import { rollupActiveUsers, MAU_WINDOW_DAYS } from "./activity.js";

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
function normModel(col) {
  const strip = (expr, pattern) => `replaceRegexpOne(${expr}, '${pattern}', '')`;
  let expr = col;
  expr = strip(expr, "\\\\[.*\\\\]$"); // [1m] 컨텍스트 윈도우 접미사
  expr = strip(expr, "^(us|global|eu|apac)\\\\."); // cross-region 추론 프로파일 접두사
  expr = strip(expr, "^anthropic\\\\."); // bedrock provider 접두사
  expr = strip(expr, "-v\\\\d+:\\\\d+$"); // bedrock 버전 접미사 -v1:0
  expr = strip(expr, "-\\\\d{8}$"); // 날짜 스냅샷 접미사 -20250929
  return expr;
}

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
  //   - excludeUnknown: false(unknown 포함) — activeUsers, activeUsersTimeseries, adoptionLevels,
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
  return { where: conds.map((c) => `AND ${c}`).join(" "), params };
}

// OTel AggregationTemporality: UNSPECIFIED=0, DELTA=1, CUMULATIVE=2. Claude Code는 세션(session.id)
// 단위로 "지금까지 합계"를 30초마다 export한다(운영 설정: cumulative). cumulative 행을 그대로
// sum(Value)하면 세션이 길수록 같은 총합이 배수로 다시 더해져 토큰/비용/세션 수가 천문학적으로
// 과대집계된다(실측: 토큰 총합이 1600억까지 나온 사례). 정답은 세션별로 "구간 끝 누적값 - 구간
// 시작 직전 누적값"만 diff하는 것 — Prometheus increase()가 하는 일과 같다. 세션 재시작 = 새
// session.id라 카운터 리셋 감지가 따로 필요 없다(방어적으로 greatest(diff, 0)만 둔다). delta
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
  // cumulative(temp=2) baseline의 hour 경계 처리 — 두 방향 오류를 모두 실측으로 확인했다.
  // hour는 "그 버킷 종료 시점" 누적값이라 어느 쪽으로 근사해도 오차가 생긴다:
  //   - `hour < toStartOfHour(from)`(원래 방식): from이 속한 hour 버킷 자체를 baseline에서
  //     빼 baseline이 너무 작아짐 → diff가 그 부분 hour의 실제 증가분만큼 과대집계.
  //   - `hour < from`(라운드 9에서 시도): from이 속한 hour 버킷의 "종료 시점" 값(최대 59분
  //     미래)을 baseline으로 씀 → diff가 그만큼 과소집계(리뷰에서 재확인 — 라이브 클러스터로
  //     실제 세션 하나에서 baseline이 정확값보다 27,066 더 크게 잡혀 diff가 그만큼 작게
  //     나오는 걸 직접 검증했다).
  // 유일한 정확한 해법: from이 속한 hour 버킷만 원본 테이블로 대체(stitch)한다 — 그 버킷의
  // "정확히 from 시점까지"의 값을 raw에서 구해 rollup의 그 버킷 자리에 끼운다. span≥4h(이
  // 분기의 전제)에서는 from과 to가 같은 hour에 속할 수 없어 to 쪽 stitch는 필요 없다.
  //
  // 이 stitch로 incFlat(스냅샷)은 이제 정확하지만, incBucketed(시계열)는 여전히 다른 결함이
  // 있다 — 버킷 경계가 항상 정각(bucketExpr이 rollup의 정각 hour 컬럼 기반)이라 `WHERE t >=
  // from`이 from이 속한 부분 시간 버킷을 통째로 걸러낸다. 실측(라이브 클러스터, 실제
  // useApi.js quantize 로직으로 만든 기본 2일 뷰 from/to 그대로 재현): KPI 1,975,497,445 vs
  // 시계열 합계 1,944,228,273 — 차이 31,269,172(1.58%), [from, 다음 정각) 구간의 실제 증가량과
  // 정확히 일치. **워크샵 기본 뷰에서 상시 발생하는 실질적 크기의 차이**(quantize가 120초
  // 단위라 from이 정각에 맞을 확률은 거의 0) — "작다"고 단정할 수 없다. incBucketed의 첫
  // 버킷도 같은 stitch를 적용해야 완전히 해소되나, 시계열 버킷 경계 자체를 재구성해야 해서
  // 이 PR 스코프를 넘어선다. 알려진 잔여 불일치로 남기고 후속 작업으로 넘긴다 — incFlat(총계
  // 카드)이 정확해진 것이 핵심 목표였고, incBucketed(차트 막대/선)는 여전히 rollup의 hour
  // 그레인이 만드는 근본적 제약을 받는다.
  return `(
    SELECT
        SessionId, AggregationTemporality AS temp, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName,
        if(temp = 2,
            greatest(maxIf(mv, h < {to:DateTime}) - maxIf(mv, h < {from:DateTime}), 0),
            sumIf(sv, h >= toStartOfHour({from:DateTime}) AND h < {to:DateTime})) AS Value
    FROM (
        SELECT hour AS h, SeriesKey AS sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName,
            max_value AS mv, sum_value AS sv
        FROM claude_code.otel_metrics_sum_hourly
        WHERE hour != toStartOfHour({from:DateTime})
          AND hour >= toStartOfHour({from:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
          ${metricFilter}
        UNION ALL
        SELECT
            toStartOfHour({from:DateTime}) AS h, ${seriesKey} AS sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision, SkillName,
            Attributes['tool_name'] AS ToolName,
            maxIf(Value, TimeUnix < {from:DateTime}) AS mv,
            sumIf(Value, TimeUnix >= toStartOfHour({from:DateTime}) AND TimeUnix < {from:DateTime}) AS sv
        FROM claude_code.otel_metrics_sum
        WHERE TimeUnix >= toStartOfHour({from:DateTime}) AND TimeUnix < toStartOfHour({from:DateTime}) + INTERVAL 1 HOUR
          ${metricFilter}
        GROUP BY sk, SessionId, AggregationTemporality, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName
    )
    GROUP BY sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision, SkillName, ToolName
  )`;
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
function incBucketed(bucketExpr, metricFilter = "") {
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
                if(AggregationTemporality = 2, max(max_value), sum(sum_value)) AS cum
            FROM claude_code.otel_metrics_sum_hourly
            WHERE hour >= toStartOfHour({from:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
              ${metricFilter}
            GROUP BY t, sk, SessionId, temp, UserEmail, MetricName, Model, TokenType, Decision
        )
    )
    WHERE t >= {from:DateTime}
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
  return { sub: raw ? incBucketedRaw(b.expr, metricFilter) : incBucketed(b.expr, metricFilter), params: b.params, raw };
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
        round(cache_read / nullIf(input_side, 0), 3)              AS cache_read_ratio
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
  const rows = await query(
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
        WITH toStartOfHour({from:DateTime}) AS curFrom,
             greatest(toStartOfHour({to:DateTime}), curFrom + INTERVAL 1 HOUR) AS curTo,
             curFrom - (curTo - curFrom) AS prevFrom
        SELECT
            SessionId, any(UserEmail) AS UserEmail, ${normModel("Model")} AS model, MetricName, TokenType,
            if(AggregationTemporality = 2,
                greatest(maxIf(max_value, hour < curFrom) - maxIf(max_value, hour < prevFrom), 0),
                sumIf(sum_value, hour >= prevFrom AND hour < curFrom)) AS prev_v,
            if(AggregationTemporality = 2,
                greatest(maxIf(max_value, hour < curTo) - maxIf(max_value, hour < curFrom), 0),
                sumIf(sum_value, hour >= curFrom AND hour < curTo)) AS cur_v
        FROM claude_code.otel_metrics_sum_hourly
        WHERE MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage') AND Model != ''
          AND hour >= toStartOfHour({prevFrom:DateTime}) - INTERVAL ${LOOKBACK_DAYS} DAY AND hour < {to:DateTime}
        GROUP BY ${seriesKey}, SessionId, AggregationTemporality, model, MetricName, TokenType
    ) m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY model`,
    { ...range(from, to), prevFrom: toChDateTime(prevFrom), ...f.params }
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
export async function activeUsers(from, to, filters = {}) {
  const f = filterCond({ ...filters, excludeUnknown: false }, { group: GROUP_EXPR, user: "m.UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT uniqExactIf(m.UserEmail, m.UserEmail != '') AS users
    FROM claude_code.otel_metrics_sum_hourly m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.MetricName = 'claude_code.session.count'
      AND m.hour >= toStartOfHour({from:DateTime}) AND m.hour < {to:DateTime} ${f.where}`,
    { ...range(from, to), ...f.params }
  );
  return rows[0] || { users: 0 };
}

// adoptionLevels(스냅샷)의 시계열 버전 — 일자×유저 존재만 뽑아오고 DAU/WAU/MAU 롤링 윈도우는
// activity.js(순수 함수, 단위 테스트 있음)에서 계산한다. wau/mau가 정확하려면 from보다 29일 전
// 데이터까지 봐야 하므로 조회 구간을 넓힌다. 현재 라우트에서는 안 쓰지만(어댑션 timeseries는
// adoptionTimeseries가 담당, 아래) activity.js와 짝인 순수 계산 경로라 보존한다.
export async function activeUsersTimeseries(from, to) {
  const rows = await query(
    `SELECT toDate(hour, 'UTC') AS day, UserEmail
     FROM claude_code.otel_metrics_sum_hourly
     WHERE MetricName = 'claude_code.session.count' AND UserEmail != ''
       AND hour >= toStartOfHour({from:DateTime}) - INTERVAL ${MAU_WINDOW_DAYS} DAY AND hour < {to:DateTime}
     GROUP BY day, UserEmail`,
    range(from, to)
  );
  return rollupActiveUsers(rows, from, to);
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
    { ...range(from, to), ...f.params }
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
    { ...range(from, to), ...b.params, ...f.params }
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
    { ...range(from, to), ...f.params }
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

// Cost 페이지: 유저 × 모델별 비용/토큰. 그룹(bedrock/enterprise)은 세션 단위로 판별한 뒤 topK(1)로
// 그 유저의 다수결 그룹 하나를 뽑는다(한 유저가 두 방식을 다 쓴 경우 any()처럼 비결정적으로
// 흔들리지 않는다) — 단, incFlat이 세션당 여러 row(속성 조합별)를 낼 수 있어 정확히는 "세션 수"가
// 아니라 incFlat이 생성한 row 개수(세션×속성 조합) 가중 다수결이다.
export async function costByUserModel(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, topK(1)(${GROUP_EXPR})[1] AS "group", ${normModel("m.Model")} AS model, ${TOKEN_SUMS}
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' AND m.UserEmail != '' ${f.where}
    GROUP BY user, model ORDER BY user`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params }
  );
  return withComputedCost(rows).map((r) => ({
    ...r,
    tokens: Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens),
  }));
}

// 유저별 어떤 tool을 얼마나 썼는지 (Usage/Users 페이지의 "사용자별 사용 내역"). model 필터는
// 세션 세미조인으로 적용.
export async function userToolUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "l.UserEmail", modelViaSession: "l.SessionId" });
  return query(
    `${GROUP_CTE}
    SELECT l.UserEmail AS user, topK(1)(${GROUP_EXPR})[1] AS "group", l.ToolName AS tool, count() AS uses
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result' AND l.UserEmail != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime} ${f.where}
    GROUP BY user, tool ORDER BY user, uses DESC`,
    { ...range(from, to), ...f.params }
  );
}

// 유저별 어떤 skill을 얼마나 썼는지. (skillUsage와 동일한 이유로 cost.usage 기준 유지 — cost.usage는
// Model을 갖고 있어 model 필터도 걸 수 있다)
// 원본 테이블을 유지하는 유일한 스냅샷 쿼리 — invocations가 count()(원시 export-tick 행 수 근사)라
// 시간별 rollup으로 접으면 값이 달라진다. cost.usage+SkillName!='' 필터가 좁아 원본이어도 저렴.
export async function userSkillUsage(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, topK(1)(${GROUP_EXPR})[1] AS "group", m.SkillName AS skill, count() AS invocations
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.MetricName = 'claude_code.cost.usage' AND m.SkillName != '' AND m.UserEmail != ''
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime} ${f.where}
    GROUP BY user, skill ORDER BY user, invocations DESC`,
    { ...range(from, to), ...f.params }
  );
}

// Trends 페이지: 일별 DAU/WAU/MAU 시계열. 롤링 윈도우(7일/30일)는 ClickHouse에서 일별 유저
// 집합만 뽑고 JS에서 접는다 — 유저 수가 수백 명 수준이라 집합 union이 싸고, SQL 셀프조인보다
// 단순하다. uniq류는 존재 여부만 보므로 시간별 rollup으로 접혀도 값이 같다(키 보존).
// 날짜 키는 toDate(..., 'UTC')로 고정 — JS는 toISOString()(UTC)로 롤링 union하므로 서버 TZ가
// UTC가 아니어도 하루 어긋나지 않는다(activeUsersTimeseries와 동일 규칙).
// excludeUnknown: false — activeUsers/adoptionLevels와 같은 "총계/DAU·WAU·MAU" 계열이라
// 그룹 무관 모수여야 한다. 빠뜨리면 이 시계열만 unknown ~11%가 빠져 Trends의 DAU/WAU/MAU가
// Overview 스냅샷(adoptionLevels)보다 낮게 나오는 모순이 생긴다(리뷰에서 MAJOR로 확인).
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
  const byDay = new Map(rows.map((r) => [r.d, r.users]));
  const DAY = 86400000;
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const out = [];
  for (let t = Math.ceil(from.getTime() / DAY) * DAY; t < to.getTime(); t += DAY) {
    const union = (days) => {
      const s = new Set();
      for (let i = 0; i < days; i++) for (const u of byDay.get(dayKey(t - i * DAY)) || []) s.add(u);
      return s.size;
    };
    const dau = union(1), mau = union(30);
    out.push({ t: dayKey(t), dau, wau: union(7), mau, stickiness: mau > 0 ? Number(((dau / mau) * 100).toFixed(1)) : 0 });
  }
  return out;
}

// 유저 드릴다운: 특정 유저의 일별 세션/LOC/토큰/커밋 시계열.
export async function userDaily(from, to, email) {
  const b = incBucket(24, `AND MetricName IN (
        'claude_code.session.count', 'claude_code.lines_of_code.count',
        'claude_code.token.usage', 'claude_code.commit.count'
      )`);
  return query(
    `SELECT t,
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')       AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added') AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits
    FROM ${b.sub} m
    WHERE m.UserEmail = {email:String}
    GROUP BY t ORDER BY t`,
    { ...range(from, to, b.raw), ...b.params, email }
  );
}

// 유저 드릴다운: 특정 유저의 도구별 수락/거부. userDaily/userHeatmap과 같은 exact match —
// 부분일치({user})면 kim@x.com 드로어에 joakim@x.com 데이터가 섞인다.
export async function userDecisionsByTool(from, to, email) {
  return codeEditDecisionsByTool(from, to, { userExact: email });
}

// 유저 드릴다운: GitHub식 활동 히트맵 — to 기준 지난 91일(13주)의 일별 세션 수.
// 세션 수는 SessionId 존재 기반(uniqExact)이라 temporality 무관.
export async function userHeatmap(to, email, days = 91) {
  return query(
    `SELECT toDate(hour, 'UTC') AS d, uniqExact(SessionId) AS sessions
    FROM claude_code.otel_metrics_sum_hourly
    WHERE UserEmail = {email:String} AND MetricName = 'claude_code.session.count' AND SessionId != ''
      AND hour >= {to:DateTime} - INTERVAL {days:UInt32} DAY AND hour < {to:DateTime}
    GROUP BY d ORDER BY d`,
    { to: toChDateTime(to), email, days }
  );
}

// 패널10 확장: 유저별 리더보드 (생산성 점수는 이 raw 값을 productivity.js에서 계산). active_days는
// "존재하는 날짜 수"라 temporality와 무관 — rollup에서 바로 distinct count로 구해 별도 CTE로 조인.
export async function userLeaderboard(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  // active_days에도 같은 필터를 건다(컬럼 참조만 CTE 기준으로) — 안 걸면 group/model 필터 상태에서
  // sessions/loc는 필터되는데 활성일수(점수 가중치 0.15)만 전체 활동 기준이라 점수가 불일치한다.
  // 파라미터 이름/값이 f와 동일해 중복 병합은 무해.
  // active_days CTE의 MetricName='claude_code.session.count' 필터: "존재 여부"만 보므로 활동이
  // 있는 날엔 반드시 session.count 행이 있어(30초마다 재보고) 의미 손실이 없고(adoptionLevels/
  // userHeatmap과 동일 근거), 전체 metric을 스캔할 때보다 3배 빠르다(실측 2026-07-10: 8.0→2.5초 —
  // 필터가 없으면 이 쿼리가 워밍/실요청에서 ClickHouse 클라이언트 15초 타임아웃까지 갔다).
  const fAd = filterCond(filters, { group: GROUP_EXPR, user: "UserEmail", modelMixed: { model: "Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE},
    active_days AS (
        SELECT UserEmail, uniqExact(toDate(hour, 'UTC')) AS active_days
        FROM claude_code.otel_metrics_sum_hourly m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE UserEmail != '' AND MetricName = 'claude_code.session.count'
          AND hour >= toStartOfHour({from:DateTime}) AND hour < {to:DateTime} ${fAd.where}
        GROUP BY UserEmail
    )
    SELECT
        m.UserEmail AS user,
        topK(1)(${GROUP_EXPR})[1] AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')                                    AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')                                       AS tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')             AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')            AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added')      AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')                                      AS commits,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')                                AS prs,
        sumIf(m.Value, m.MetricName = 'claude_code.code_edit_tool.decision' AND m.Decision = 'accept')  AS accepted,
        sumIf(m.Value, m.MetricName = 'claude_code.code_edit_tool.decision')                            AS decisions,
        any(ad.active_days)                                                                             AS active_days
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.session.count', 'claude_code.token.usage', 'claude_code.lines_of_code.count',
        'claude_code.commit.count', 'claude_code.pull_request.count', 'claude_code.code_edit_tool.decision'
      )`, to - from)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    LEFT JOIN active_days ad ON m.UserEmail = ad.UserEmail
    WHERE m.UserEmail != '' ${f.where}
    GROUP BY user ORDER BY tokens DESC`,
    { ...range(from, to, incFlatRaw(to - from)), ...f.params, ...fAd.params }
  );
}
