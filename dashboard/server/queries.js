import { query, toChDateTime } from "./clickhouse.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";
import { withComputedCost } from "./pricing.js";
import { rollupActiveUsers, MAU_WINDOW_DAYS } from "./activity.js";

// 원본: ../grafana-ab-queries.sql 의 10개 패널을 그대로 이식했다. ExperimentGroup(env 기반) 컬럼
// 대신 grouping.js의 텔레메트리 자동판별(GROUP_CTE)로 그룹을 계산한다는 점만 다르다.

function range(from, to) {
  return { from: toChDateTime(from), to: toChDateTime(to) };
}

// claude-fable-5[1m] 같은 컨텍스트 윈도우 접미사는 같은 모델의 변형일 뿐이라(사용자가 고르는 게
// 아니라 Claude Code가 세션 상황에 따라 자동으로 붙임) 모델 분포/비용 집계에서는 하나로 합친다.
function normModel(col) {
  return `replaceRegexpOne(${col}, '\\\\[.*\\\\]$', '')`;
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

// 비용 계산에 필요한 토큰 타입별 합계 + Claude Code 자체 보고 비용(비교용). withComputedCost()
// (pricing.js)가 이 4개 토큰 컬럼 + reported_cost를 받아 단가표 기반 cost를 계산한다.
const TOKEN_SUMS = `
        sumIf(m.Value, m.MetricName = 'claude_code.cost.usage')                                        AS reported_cost,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')         AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output')        AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheRead')     AS cache_read_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'cacheCreation') AS cache_write_tokens`;

// 패널1: 그룹별 KPI 요약
export async function kpiSummary(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')       AS sessions,
        uniqExactIf(m.UserEmail, m.UserEmail != '')                     AS users,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')  AS prs,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS total_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count' AND m.TokenType = 'added') AS lines_of_code
    FROM ${incFlat(`AND MetricName IN (
        'claude_code.session.count', 'claude_code.commit.count', 'claude_code.pull_request.count',
        'claude_code.token.usage', 'claude_code.lines_of_code.count'
      )`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// 패널2: 토큰 시계열
export async function tokenTimeseries(from, to, intervalHours = 24) {
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS tokens
    FROM ${incBucketed(
      `toStartOfInterval(TimeUnix, INTERVAL {intervalHours:UInt32} HOUR)`,
      `AND MetricName = 'claude_code.token.usage'`
    )} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), intervalHours }
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
export async function cacheEfficiency(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.TokenType = 'cacheRead')                              AS cache_read,
        sumIf(m.Value, m.TokenType IN ('input', 'cacheRead', 'cacheCreation'))  AS input_side,
        round(cache_read / nullIf(input_side, 0), 3)              AS cache_read_ratio
    FROM ${incFlat(`AND MetricName = 'claude_code.token.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// 패널6: 모델별 토큰 분포 (교란 점검)
export async function modelDistribution(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model, sum(m.Value) AS tokens
    FROM ${incFlat(`AND MetricName = 'claude_code.token.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY "group", model ORDER BY "group", tokens DESC`,
    range(from, to)
  );
}

// 패널4: 토큰 정규화 생산성 (핵심 A/B 지표)
export async function normalizedProductivity(from, to) {
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
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// 패널5: 코드 수락률
export async function codeEditDecisions(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.Decision AS decision, sum(m.Value) AS n
    FROM ${incFlat(`AND MetricName = 'claude_code.code_edit_tool.decision'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY "group", decision ORDER BY "group", decision`,
    range(from, to)
  );
}

// 패널5 확장: 툴 종류별(edit/multi_edit/write/notebook_edit) 수락/거부 — 그룹 합계만 보여주던
// codeEditDecisions를 tool_name 차원으로 쪼갠 버전. ToolName이 비어있는 행(구버전 텔레메트리 등
// tool_name attribute가 없는 경우)은 집계에서 제외한다.
export async function codeEditDecisionsByTool(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.ToolName AS tool, m.Decision AS decision, sum(m.Value) AS n
    FROM ${incFlat(`AND MetricName = 'claude_code.code_edit_tool.decision'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.ToolName != ''
    GROUP BY "group", tool, decision ORDER BY "group", tool`,
    range(from, to)
  );
}

// 패널9: 활성 사용시간 시계열
// 실측 확인(2026-07-06, 실제 claude 세션): active_time.total은 gauge가 아니라 sum 테이블로
// 들어온다 — grafana-ab-queries.sql 패널9의 주석("gauge로 안 들어오면 sum으로 교체")이 실제로
// 맞았다. otel_metrics_gauge 테이블/스키마는 그대로 두고 이 쿼리만 sum을 본다.
export async function activeTimeSeries(from, to, intervalHours = 24) {
  return query(
    `${GROUP_CTE}
    SELECT
        t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS active_seconds
    FROM ${incBucketed(
      `toStartOfInterval(TimeUnix, INTERVAL {intervalHours:UInt32} HOUR)`,
      `AND MetricName = 'claude_code.active_time.total'`
    )} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), intervalHours }
  );
}

// 패널7: skill 사용 분포. skill.name은 cost.usage 행에만 실리고 token.usage에는 skill 귀속이
// 없어 토큰 기반으로 계산할 수 없다 — Claude Code 보고 비용(cost.usage) 그대로 사용. count()는
// incFlat이 세션 단위로 이미 접어놓은 뒤라 "세션 수" 근사다(delta였을 때도 export 횟수 근사였던
// 것과 마찬가지로 정확한 invocation 수는 아님).
export async function skillUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.SkillName AS skill, count() AS invocations, sum(m.Value) AS est_cost_usd
    FROM ${incFlat(`AND MetricName = 'claude_code.cost.usage'`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.SkillName != ''
    GROUP BY "group", skill ORDER BY "group", invocations DESC`,
    range(from, to)
  );
}

// 모델별 일간/주간 지출 트렌드 (Cost 페이지 스택 바). intervalHours=24|168로 일간/주간 토글.
// ponytail: toStartOfInterval(..., INTERVAL n HOUR)은 n>24에서 날짜 경계를 못 넘어가는
// ClickHouse 동작(HOUR 단위는 24 초과 시 매일 0시로 리셋)이 있어 DAY 단위로 바꿔서 계산한다.
export async function costByModelDaily(from, to, intervalHours = 24) {
  const intervalDays = Math.max(1, Math.round(intervalHours / 24));
  const rows = await query(
    `${GROUP_CTE}
    SELECT t AS day,
        ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model,
        ${TOKEN_SUMS}
    FROM ${incBucketed(
      `toStartOfInterval(TimeUnix, INTERVAL {intervalDays:UInt32} DAY)`,
      `AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`
    )} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != ''
    GROUP BY day, "group", model ORDER BY day`,
    { ...range(from, to), intervalDays }
  );
  // cost 키 이름을 유지해 SeriesBarChart(valueKey="cost")가 그대로 동작하게 한다.
  return withComputedCost(rows);
}

// 모델별 지출 vs 이전 동일 길이 기간. cumulative의 진짜 이점이 여기서 나온다 — 두 구간(현재/이전)
// × 5개 값(보고비용+토큰4타입)을 각 세션의 경계 3점(prevFrom/from/to)만 diff해서 얻고, N개 delta
// row를 매번 다시 합산할 필요가 없다. cost/prev_cost는 각 구간 토큰 합계에 단가표를 적용해 JS에서
// 계산(withComputedCost 2회 호출).
export async function costByModelCompare(from, to, prevFrom) {
  const rows = await query(
    `SELECT model,
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
            ${normModel("Model")} AS model, MetricName, TokenType,
            if(AggregationTemporality = 2,
                greatest(maxIf(Value, TimeUnix < {from:DateTime}) - maxIf(Value, TimeUnix < {prevFrom:DateTime}), 0),
                sumIf(Value, TimeUnix >= {prevFrom:DateTime} AND TimeUnix < {from:DateTime})) AS prev_v,
            if(AggregationTemporality = 2,
                greatest(maxIf(Value, TimeUnix < {to:DateTime}) - maxIf(Value, TimeUnix < {from:DateTime}), 0),
                sumIf(Value, TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime})) AS cur_v
        FROM claude_code.otel_metrics_sum
        WHERE MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage') AND Model != ''
          AND TimeUnix >= {prevFrom:DateTime} - INTERVAL ${LOOKBACK_DAYS} DAY AND TimeUnix < {to:DateTime}
        GROUP BY ${seriesKey}, SessionId, AggregationTemporality, model, MetricName, TokenType
    )
    GROUP BY model`,
    { ...range(from, to), prevFrom: toChDateTime(prevFrom) }
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
// 그룹 구분 없이 조직 전체 기준(스크린샷의 "How are you using Claude" 패널과 동일한 의미).
// uniqExact류는 "존재 여부"만 보므로 cumulative 중복 누적치에 영향받지 않아 원본 테이블을 그대로 쓴다.
export async function adoptionLevels(from, to) {
  const rows = await query(
    `SELECT
        uniqExact(UserEmail)                                                AS total_members,
        uniqExactIf(UserEmail, TimeUnix >= {to:DateTime} - INTERVAL 30 DAY) AS mau,
        uniqExactIf(UserEmail, TimeUnix >= {to:DateTime} - INTERVAL 7 DAY)  AS wau,
        uniqExactIf(UserEmail, TimeUnix >= {to:DateTime} - INTERVAL 1 DAY) AS dau
    FROM claude_code.otel_metrics_sum
    WHERE MetricName = 'claude_code.session.count' AND UserEmail != '' AND TimeUnix < {to:DateTime}`,
    { to: toChDateTime(to) }
  );
  return rows[0] || { total_members: 0, mau: 0, wau: 0, dau: 0 };
}

// adoptionLevels(스냅샷)의 시계열 버전 — 일자×유저 존재만 뽑아오고 DAU/WAU/MAU 롤링 윈도우는
// activity.js(순수 함수, 단위 테스트 있음)에서 계산한다. wau/mau가 정확하려면 from보다 29일 전
// 데이터까지 봐야 하므로 조회 구간을 넓힌다.
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

// 일별 사용자·세션·PR — Productivity 페이지의 "도입률"/"사용자당 PR" 이중축 시계열 하나로 둘 다 커버.
// 그룹 구분 없이 조직 전체 트렌드.
export async function dailyEngagement(from, to) {
  return query(
    `SELECT
        t,
        uniqExactIf(UserEmail, MetricName = 'claude_code.session.count') AS users,
        sumIf(Value, MetricName = 'claude_code.session.count')          AS sessions,
        sumIf(Value, MetricName = 'claude_code.pull_request.count')     AS prs,
        round(sumIf(Value, MetricName = 'claude_code.pull_request.count')
              / nullIf(uniqExactIf(UserEmail, MetricName = 'claude_code.session.count'), 0), 2) AS prs_per_user
    FROM ${incBucketed(
      `toDate(TimeUnix)`,
      `AND MetricName IN ('claude_code.session.count', 'claude_code.pull_request.count')`
    )} m
    GROUP BY t ORDER BY t`,
    range(from, to)
  );
}

// MCP 커넥터(서버) 사용 현황 — 실제 제품의 "읽기/쓰기" 구분은 우리 텔레메트리에 그 의미가
// 없어서(도구 이름 휴리스틱은 부정확) 유저수/호출수/성공률로 단순화.
export async function mcpConnectorUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", l.McpServerName AS connector,
        uniqExact(l.UserEmail)      AS users,
        count()                     AS calls,
        countIf(l.Success = 'true') AS ok
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result' AND l.McpServerName != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime}
    GROUP BY "group", connector ORDER BY "group", calls DESC`,
    range(from, to)
  );
}

// "에이전틱함" = 프롬프트 1개당 평균 툴 호출 수. claude_code.user_prompt 이벤트가 실제로
// 오는지 실측 필요(clickhouse-schema.sql 주석에 있던 후보 이벤트명) — 없으면 prompts=0으로
// 나와 이 지표는 그냥 비게 된다(기능 자체는 죽지 않음).
export async function agenticness(from, to, intervalHours = 24) {
  return query(
    `${GROUP_CTE}
    SELECT
        toStartOfInterval(l.Timestamp, INTERVAL {intervalHours:UInt32} HOUR) AS t,
        ${GROUP_EXPR} AS "group",
        countIf(l.EventName = 'user_prompt') AS prompts,
        countIf(l.EventName = 'tool_result')  AS tool_calls,
        round(tool_calls / nullIf(prompts, 0), 2)          AS tool_calls_per_prompt
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), intervalHours }
  );
}

// 패널8: tool/MCP 사용 패턴 (logs)
export async function toolMcpUsage(from, to) {
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
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime}
    GROUP BY "group", tool, mcp_server ORDER BY "group", total DESC LIMIT 50`,
    range(from, to)
  );
}

// Cost 페이지: 그룹별 비용/토큰 요약. 비용은 토큰 실측 × 단가표(pricing.js)로 계산 —
// Claude Code 자체 보고 비용(reported_cost)은 비교용으로만 같이 내려준다.
// 단가는 모델별로 다르므로 SQL은 그룹+모델 단위로 집계하고, 그룹 합계는 JS에서 fold한다.
export async function costSummary(from, to) {
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
    GROUP BY "group", model ORDER BY "group"`,
    range(from, to)
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
export async function costByModel(from, to) {
  const rows = await query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", ${normModel("m.Model")} AS model, ${TOKEN_SUMS}
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != ''
    GROUP BY "group", model ORDER BY "group"`,
    range(from, to)
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
export async function costByUserModel(from, to) {
  const rows = await query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, topK(1)(${GROUP_EXPR})[1] AS "group", ${normModel("m.Model")} AS model, ${TOKEN_SUMS}
    FROM ${incFlat(`AND MetricName IN ('claude_code.cost.usage', 'claude_code.token.usage')`)} m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.Model != '' AND m.UserEmail != ''
    GROUP BY user, model ORDER BY user`,
    range(from, to)
  );
  return withComputedCost(rows).map((r) => ({
    ...r,
    tokens: Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens),
  }));
}

// 유저별 어떤 tool을 얼마나 썼는지 (Usage/Users 페이지의 "사용자별 사용 내역").
export async function userToolUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT l.UserEmail AS user, topK(1)(${GROUP_EXPR})[1] AS "group", l.ToolName AS tool, count() AS uses
    FROM claude_code.otel_logs l
    LEFT JOIN session_group ug ON l.SessionId = ug.SessionId
    WHERE l.EventName = 'tool_result' AND l.UserEmail != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime}
    GROUP BY user, tool ORDER BY user, uses DESC`,
    range(from, to)
  );
}

// 유저별 어떤 skill을 얼마나 썼는지. (skillUsage와 동일한 이유로 cost.usage 기준 유지)
export async function userSkillUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, topK(1)(${GROUP_EXPR})[1] AS "group", m.SkillName AS skill, count() AS invocations
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN session_group ug ON m.SessionId = ug.SessionId
    WHERE m.MetricName = 'claude_code.cost.usage' AND m.SkillName != '' AND m.UserEmail != ''
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY user, skill ORDER BY user, invocations DESC`,
    range(from, to)
  );
}

// 패널10 확장: 유저별 리더보드 (생산성 점수는 이 raw 값을 productivity.js에서 계산). active_days는
// "존재하는 날짜 수"라 temporality와 무관 — 원본 테이블에서 바로 distinct count로 구해 별도 CTE로 조인.
export async function userLeaderboard(from, to) {
  return query(
    `${GROUP_CTE},
    active_days AS (
        SELECT UserEmail, uniqExact(toDate(TimeUnix)) AS active_days
        FROM claude_code.otel_metrics_sum
        WHERE UserEmail != '' AND TimeUnix >= {from:DateTime} AND TimeUnix < {to:DateTime}
        GROUP BY UserEmail
    )
    SELECT
        m.UserEmail AS user,
        topK(1)(${GROUP_EXPR})[1] AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')                                    AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')                                       AS tokens,
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
    WHERE m.UserEmail != ''
    GROUP BY user ORDER BY tokens DESC`,
    range(from, to)
  );
}
