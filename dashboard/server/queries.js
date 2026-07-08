import { query, toChDateTime } from "./clickhouse.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { withComputedCost, normalizeModelId } from "./pricing.js";
import { rollupActiveUsers, MAU_WINDOW_DAYS } from "./activity.js";

// 원본: ../grafana-ab-queries.sql 의 10개 패널을 그대로 이식했다. ExperimentGroup(env 기반) 컬럼
// 대신 grouping.js의 텔레메트리 자동판별(GROUP_CTE)로 그룹을 계산한다는 점만 다르다.

function range(from, to) {
  return { from: toChDateTime(from), to: toChDateTime(to) };
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
function filterCond(filters = {}, cols = {}) {
  const conds = [];
  const params = {};
  // 저장된 Model은 normModel()로 정규화된 값과 비교하므로, 검색어도 같이 정규화한다 —
  // 안 그러면 유저가 raw Bedrock ID("global.anthropic.claude-sonnet-5")로 검색할 때
  // 정규화된 저장값("claude-sonnet-5")과 접두사가 어긋나 매치가 빗나간다.
  const fModel = filters.model ? normalizeModelId(filters.model) : filters.model;
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
        SELECT SessionId FROM claude_code.otel_metrics_sum
        WHERE SessionId != '' AND TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
          AND positionCaseInsensitive(${normModel("Model")}, {fModel:String}) > 0)))`);
    params.fModel = fModel;
  }
  // 로그 테이블(otel_logs)엔 Model이 없다 — 세션이 실제로 쓴 모델을 otel_metrics_sum에서
  // 찾아 세미조인. 의미론: "세션이 이 모델을 한 번이라도 썼으면 그 세션의 로그 이벤트 전부 통과".
  // 세션 내 모델 전환이 드물어 필터 용도로는 이 근사가 충분(이벤트 단위 정밀 귀속은 api_request
  // 조인이 필요한데, 필터링만 할 땐 오버킬).
  if (filters.model && cols.modelViaSession) {
    conds.push(`${cols.modelViaSession} IN (
      SELECT SessionId FROM claude_code.otel_metrics_sum
      WHERE SessionId != '' AND TimeUnix >= {from:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
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
// 전체를 해시한 sk가 진짜 시리즈 키 — 이 키로 파티션하면 전부 단조 증가(drops=0)임을 확인했다.
const seriesKey = "cityHash64(toString(Attributes))";

// 세션(SessionId) × temporality × 속성 단위로 구간 증가량을 미리 계산하는 서브쿼리. 결과 컬럼명을
// 원본 테이블과 동일하게(Value/MetricName/Model/...) 맞춰서, 기존 sumIf(m.Value, ...) 패턴을 건드리지
// 않고 FROM만 이 서브쿼리로 바꿔 끼울 수 있게 한다.
// ToolName은 otel_metrics_sum엔 승격 컬럼이 없어(otel_logs에만 있음) Attributes에서 바로 뽑는다 —
// code_edit_tool.decision의 tool_name(edit/multi_edit/write/notebook_edit)을 툴별로 쪼개는 데만 쓴다.
function incFlat(metricFilter = "") {
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

// incFlat의 시계열(버킷) 버전. 버킷별로 cumulative는 "그 버킷의 마지막 누적값 - 이전 버킷의 마지막
// 누적값"(lagInFrame), delta는 버킷 내 합(이미 그 버킷의 증가량)을 쓴다. lookback 구간의 버킷은
// 첫 실구간 버킷의 diff baseline으로만 쓰이고 바깥 WHERE t >= from에서 걸러진다.
function incBucketed(bucketExpr, metricFilter = "") {
  return `(
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
    WHERE t >= {from:DateTime}
  )`;
}

// intervalHours < 24 → HOUR 버킷, >= 24 → DAY 버킷. ClickHouse의 toStartOfInterval(..., INTERVAL n HOUR)은
// n>24에서 날짜 경계를 못 넘어가고 매일 0시로 리셋되는 동작이 있어(costByModelDaily가 원래 겪던 문제),
// 24시간 이상 구간은 항상 DAY 단위로 계산해 그 quirk를 피한다.
function bucket(intervalHours, col = "TimeUnix") {
  return intervalHours >= 24
    ? { expr: `toStartOfInterval(${col}, INTERVAL {intervalDays:UInt32} DAY)`, params: { intervalDays: Math.max(1, Math.round(intervalHours / 24)) } }
    : { expr: `toStartOfInterval(${col}, INTERVAL {intervalHours:UInt32} HOUR)`, params: { intervalHours } };
}

// 비용 계산에 필요한 토큰 타입별 합계 + Claude Code 자체 보고 비용(비교용). withComputedCost()
// (pricing.js)가 이 4개 토큰 컬럼 + reported_cost를 받아 단가표 기반 cost를 계산한다.
const TOKEN_SUMS = `
        sumIf(m.Value, m.MetricName = 'claude_code.cost.usage')                                        AS reported_cost,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')         AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')        AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheRead')     AS cache_read_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheCreation') AS cache_write_tokens`;

// 패널1: 그룹별 KPI 요약
export async function kpiSummary(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
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
      )`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to), ...f.params }
  );
}

// 패널2: 토큰 시계열
export async function tokenTimeseries(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const b = bucket(intervalHours);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS tokens,
        sumIf(m.Value, m.TokenType = 'input')  AS input_tokens,
        sumIf(m.Value, m.TokenType = 'output') AS output_tokens
    FROM ${incBucketed(b.expr, `AND MetricName = 'claude_code.token.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), ...b.params, ...f.params }
  );
}

// LOC 추가/삭제 시계열 — lines_of_code.count의 type attribute(added/removed)는 token.usage와 같은
// 승격 컬럼(TokenType = Attributes['type'])에 실린다. 일별(intervalHours=24) 버킷 기본.
// costByModelDaily와 동일하게 HOUR을 DAY로 접는다 — ClickHouse의 INTERVAL n HOUR은 n>24에서
// 날짜 경계를 못 넘고 매일 0시로 리셋되는 quirk가 있다(168h 주간 버킷 요청 시 조용히 깨짐).
export async function locTimeseries(from, to, intervalHours = 24) {
  const intervalDays = Math.max(1, Math.round(intervalHours / 24));
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.TokenType = 'added')   AS loc_added,
        sumIf(m.Value, m.TokenType = 'removed') AS loc_removed
    FROM ${incBucketed(
      `toStartOfInterval(TimeUnix, INTERVAL {intervalDays:UInt32} DAY)`,
      `AND MetricName = 'claude_code.lines_of_code.count'`
    )} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), intervalDays }
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
    FROM ${incFlat(`AND MetricName = 'claude_code.token.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to), ...f.params }
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
    FROM ${incFlat(`AND MetricName = 'claude_code.token.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", model ORDER BY "group", tokens DESC`,
    { ...range(from, to), ...f.params }
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
      )`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group" ORDER BY "group"`,
    { ...range(from, to), ...f.params }
  );
}

// 패널5: 코드 수락률
export async function codeEditDecisions(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.Decision AS decision, sum(m.Value) AS n
    FROM ${incFlat(`AND MetricName = 'claude_code.code_edit_tool.decision'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", decision ORDER BY "group", decision`,
    { ...range(from, to), ...f.params }
  );
}

// 패널5 확장: 툴 종류별(edit/multi_edit/write/notebook_edit) 수락/거부 — 그룹 합계만 보여주던
// codeEditDecisions를 tool_name 차원으로 쪼갠 버전. ToolName이 비어있는 행(구버전 텔레메트리 등
// tool_name attribute가 없는 경우)은 집계에서 제외한다.
// 실측 확인(2026-07-08, 프로덕션 mapKeys 쿼리): code_edit_tool.decision 83,070행 전부에
// tool_name 키 존재(Edit 48,404 / Write 34,666) — WHERE tool != ''로 빈 패널이 될 일 없음.
export async function codeEditDecisionsByTool(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.ToolName AS tool, m.Decision AS decision, sum(m.Value) AS n
    FROM ${incFlat(`AND MetricName = 'claude_code.code_edit_tool.decision'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.ToolName != '' ${f.where}
    GROUP BY "group", tool, decision ORDER BY "group", tool`,
    { ...range(from, to), ...f.params }
  );
}

// 패널9: 활성 사용시간 시계열
// 실측 확인(2026-07-06, 실제 claude 세션): active_time.total은 gauge가 아니라 sum 테이블로
// 들어온다 — grafana-ab-queries.sql 패널9의 주석("gauge로 안 들어오면 sum으로 교체")이 실제로
// 맞았다. otel_metrics_gauge 테이블/스키마는 그대로 두고 이 쿼리만 sum을 본다.
export async function activeTimeSeries(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const b = bucket(intervalHours);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS active_seconds
    FROM ${incBucketed(b.expr, `AND MetricName = 'claude_code.active_time.total'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), ...b.params, ...f.params }
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
    FROM ${incFlat(`AND MetricName = 'claude_code.cost.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.SkillName != '' ${f.where}
    GROUP BY "group", skill ORDER BY "group", invocations DESC`,
    { ...range(from, to), ...f.params }
  );
}

// 모델별 지출 트렌드 (Cost 페이지 스택 바). intervalHours로 시간별/일간/주간 토글.
export async function costByModelDaily(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", model: "m.Model" });
  const b = bucket(intervalHours);
  const rows = await query(
    `${GROUP_CTE}
    SELECT t AS day,
        ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model,
        ${TOKEN_SUMS}
    FROM ${incBucketed(b.expr, `AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' ${f.where}
    GROUP BY day, "group", model ORDER BY day`,
    { ...range(from, to), ...b.params, ...f.params }
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
        SELECT
            SessionId, UserEmail, ${normModel("Model")} AS model, MetricName, TokenType,
            if(AggregationTemporality = 2,
                greatest(maxIf(Value, TimeUnix < {from:DateTime}) - maxIf(Value, TimeUnix < {prevFrom:DateTime}), 0),
                sumIf(Value, TimeUnix >= {prevFrom:DateTime} AND TimeUnix < {from:DateTime})) AS prev_v,
            if(AggregationTemporality = 2,
                greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS cur_v
        FROM claude_code.otel_metrics_sum
        WHERE MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage') AND Model != ''
          AND TimeUnix >= {prevFrom:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
        GROUP BY ${seriesKey}, SessionId, UserEmail, AggregationTemporality, model, MetricName, TokenType
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
// uniqExact류는 "존재 여부"만 보므로 cumulative 중복 누적치에 영향받지 않아 원본 테이블을 그대로 쓴다.
export async function adoptionLevels(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        uniqExact(UserEmail)                                                AS total_members,
        uniqExactIf(UserEmail, TimeUnix >= {to:DateTime} - INTERVAL 30 DAY) AS mau,
        uniqExactIf(UserEmail, TimeUnix >= {to:DateTime} - INTERVAL 7 DAY)  AS wau,
        uniqExactIf(UserEmail, TimeUnix >= {to:DateTime} - INTERVAL 1 DAY) AS dau
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE MetricName = 'claude_code.session.count' AND UserEmail != '' AND TimeUnix < {to:DateTime} ${f.where}`,
    { to: toChDateTime(to), ...f.params }
  );
  return rows[0] || { total_members: 0, mau: 0, wau: 0, dau: 0 };
}

// adoptionLevels(스냅샷)의 시계열 버전 — 일자×유저 존재만 뽑아오고 DAU/WAU/MAU 롤링 윈도우는
// activity.js(순수 함수, 단위 테스트 있음)에서 계산한다. wau/mau가 정확하려면 from보다 29일 전
// 데이터까지 봐야 하므로 조회 구간을 넓힌다. 현재 라우트에서는 안 쓰지만(어댑션 timeseries는
// adoptionTimeseries가 담당, 아래) activity.js와 짝인 순수 계산 경로라 보존한다.
export async function activeUsersTimeseries(from, to) {
  const rows = await query(
    `SELECT toDate(TimeUnix, 'UTC') AS day, UserEmail
     FROM claude_code.otel_metrics_sum
     WHERE MetricName = 'claude_code.session.count' AND UserEmail != ''
       AND TimeUnix >= {from:DateTime} - INTERVAL ${MAU_WINDOW_DAYS} DAY AND TimeUnix < {to:DateTime}
     GROUP BY day, UserEmail`,
    range(from, to)
  );
  return rollupActiveUsers(rows, from, to);
}

// 사용자·세션·PR 시계열 — Productivity 페이지의 "도입률"/"사용자당 PR" 이중축 시계열 하나로 둘 다 커버.
// model 필터는 이 두 지표에 model 귀속이 없어 의미가 없다 — cols에서 아예 뺀다.
export async function dailyEngagement(from, to, intervalHours = 24, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail" });
  const b = bucket(intervalHours);
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        uniqExactIf(m.UserEmail, m.MetricName = 'claude_code.session.count') AS users,
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')          AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')     AS prs,
        round(sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')
              / nullIf(uniqExactIf(m.UserEmail, m.MetricName = 'claude_code.session.count'), 0), 2) AS prs_per_user
    FROM ${incBucketed(b.expr, `AND MetricName IN ('claude_code.session.count', 'claude_code.pull_request.count')`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY t ORDER BY t`,
    { ...range(from, to), ...b.params, ...f.params }
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
export async function costSummary(from, to, filters = {}) {
  // model 필터는 SELECT에 model 정규화 컬럼이 있지만, sessions는 Model attribute가 없는
  // session.count 행을 합산하는 혼합 지표라 kpiSummary와 같은 modelMixed가 필요.
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  const rows = await query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        ${normModel("m.Model")} AS model,
        ${TOKEN_SUMS},
        sumIf(m.Value, m.MetricName = 'claude_code.session.count') AS sessions
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.session.count'
      )`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE 1 = 1 ${f.where}
    GROUP BY "group", model ORDER BY "group"`,
    { ...range(from, to), ...f.params }
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
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' ${f.where}
    GROUP BY "group", model ORDER BY "group"`,
    { ...range(from, to), ...f.params }
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
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' AND m.UserEmail != '' ${f.where}
    GROUP BY user, model ORDER BY user`,
    { ...range(from, to), ...f.params }
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
// 단순하다. uniq류는 존재 여부만 보므로 cumulative 중복 누적에 영향받지 않아 원본 테이블 사용.
// 전제: ClickHouse 서버 TZ = UTC (현 배포 기본값). 아니면 toDate()의 날짜 키와 JS
// toISOString() 날짜 키가 하루 어긋나 union 조회가 빗나간다.
export async function adoptionTimeseries(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail" });
  const rows = await query(
    `${GROUP_CTE}
    SELECT toDate(m.TimeUnix) AS d, groupUniqArray(m.UserEmail) AS users
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.MetricName = 'claude_code.session.count' AND m.UserEmail != ''
      AND m.TimeUnix >= {from:DateTime} - INTERVAL 30 DAY AND m.TimeUnix < {to:DateTime} ${f.where}
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
  const b = bucket(24);
  return query(
    `SELECT t,
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')       AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count') AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits
    FROM ${incBucketed(b.expr, `AND MetricName IN (
        'claude_code.session.count', 'claude_code.lines_of_code.count',
        'claude_code.token.usage', 'claude_code.commit.count'
      )`)} m
    WHERE m.UserEmail = {email:String}
    GROUP BY t ORDER BY t`,
    { ...range(from, to), ...b.params, email }
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
    `SELECT toDate(TimeUnix) AS d, uniqExact(SessionId) AS sessions
    FROM claude_code.otel_metrics_sum
    WHERE UserEmail = {email:String}
      AND TimeUnix >= {to:DateTime} - INTERVAL {days:UInt32} DAY AND TimeUnix < {to:DateTime}
    GROUP BY d ORDER BY d`,
    { to: toChDateTime(to), email, days }
  );
}

// 패널10 확장: 유저별 리더보드 (생산성 점수는 이 raw 값을 productivity.js에서 계산). active_days는
// "존재하는 날짜 수"라 temporality와 무관 — 원본 테이블에서 바로 distinct count로 구해 별도 CTE로 조인.
export async function userLeaderboard(from, to, filters = {}) {
  const f = filterCond(filters, { group: GROUP_EXPR, user: "m.UserEmail", modelMixed: { model: "m.Model", session: "m.SessionId" } });
  // active_days에도 같은 필터를 건다(컬럼 참조만 CTE 기준으로) — 안 걸면 group/model 필터 상태에서
  // sessions/loc는 필터되는데 활성일수(점수 가중치 0.15)만 전체 활동 기준이라 점수가 불일치한다.
  // 파라미터 이름/값이 f와 동일해 중복 병합은 무해.
  const fAd = filterCond(filters, { group: GROUP_EXPR, user: "UserEmail", modelMixed: { model: "Model", session: "m.SessionId" } });
  return query(
    `${GROUP_CTE},
    active_days AS (
        SELECT UserEmail, uniqExact(toDate(TimeUnix)) AS active_days
        FROM claude_code.otel_metrics_sum m
        LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
        WHERE UserEmail != '' AND TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime} ${fAd.where}
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
      )`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    LEFT JOIN active_days ad ON m.UserEmail = ad.UserEmail
    WHERE m.UserEmail != '' ${f.where}
    GROUP BY user ORDER BY tokens DESC`,
    { ...range(from, to), ...f.params, ...fAd.params }
  );
}
