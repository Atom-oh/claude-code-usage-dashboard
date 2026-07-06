import { query, toChDateTime } from "./clickhouse.js";
import { GROUP_CTE, GROUP_EXPR } from "./grouping.js";

// 원본: ../grafana-ab-queries.sql 의 10개 패널을 그대로 이식했다. ExperimentGroup(env 기반) 컬럼
// 대신 grouping.js의 텔레메트리 자동판별(GROUP_CTE)로 그룹을 계산한다는 점만 다르다.

function range(from, to) {
  return { from: toChDateTime(from), to: toChDateTime(to) };
}

// 패널1: 그룹별 KPI 요약
export async function kpiSummary(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')       AS sessions,
        uniqExact(m.UserEmail)                                          AS users,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits,
        sumIf(m.Value, m.MetricName = 'claude_code.pull_request.count')  AS prs,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS total_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count') AS lines_of_code
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// 패널2: 토큰 시계열
export async function tokenTimeseries(from, to, intervalHours = 24) {
  return query(
    `${GROUP_CTE}
    SELECT
        toStartOfInterval(m.TimeUnix, INTERVAL {intervalHours:UInt32} HOUR) AS t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS tokens
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.token.usage'
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), intervalHours }
  );
}

// 패널3: 캐시 효율
export async function cacheEfficiency(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.TokenType = 'cacheRead')                 AS cache_read,
        sumIf(m.Value, m.TokenType IN ('input', 'cacheRead'))     AS input_side,
        round(cache_read / nullIf(input_side, 0), 3)              AS cache_read_ratio
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.token.usage'
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// 패널6: 모델별 토큰 분포 (교란 점검)
export async function modelDistribution(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.Model AS model, sum(m.Value) AS tokens
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.token.usage'
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
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
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count') AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')         AS tokens,
        round(loc / nullIf(tokens, 0) * 1000000, 2)                      AS loc_per_million_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')        AS commits,
        round(commits / nullIf(tokens, 0) * 1000000, 3)                  AS commits_per_million_tokens
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// 패널5: 코드 수락률
export async function codeEditDecisions(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.Decision AS decision, sum(m.Value) AS n
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.code_edit_tool.decision'
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group", decision ORDER BY "group", decision`,
    range(from, to)
  );
}

// 패널9: 활성 사용시간 시계열
export async function activeTimeSeries(from, to, intervalHours = 24) {
  return query(
    `${GROUP_CTE}
    SELECT
        toStartOfInterval(m.TimeUnix, INTERVAL {intervalHours:UInt32} HOUR) AS t,
        ${GROUP_EXPR} AS "group",
        sum(m.Value) AS active_seconds
    FROM claude_code.otel_metrics_gauge m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.active_time.total'
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY t, "group" ORDER BY t`,
    { ...range(from, to), intervalHours }
  );
}

// 패널7: skill 사용 분포
export async function skillUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.SkillName AS skill, count() AS invocations, sum(m.Value) AS est_cost_usd
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.cost.usage' AND m.SkillName != ''
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group", skill ORDER BY "group", invocations DESC`,
    range(from, to)
  );
}

// 모델별 일간 지출 트렌드 (Cost 페이지 스택 바).
export async function costByModelDaily(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT toDate(m.TimeUnix) AS day, ${GROUP_EXPR} AS "group", m.Model AS model,
        sum(m.Value) AS cost
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.cost.usage' AND m.Model != ''
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY day, "group", model ORDER BY day`,
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
    LEFT JOIN user_group ug ON l.UserEmail = ug.UserEmail
    WHERE l.EventName = 'claude_code.tool_result' AND l.McpServerName != ''
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
        countIf(l.EventName = 'claude_code.user_prompt') AS prompts,
        countIf(l.EventName = 'claude_code.tool_result')  AS tool_calls,
        round(tool_calls / nullIf(prompts, 0), 2)          AS tool_calls_per_prompt
    FROM claude_code.otel_logs l
    LEFT JOIN user_group ug ON l.UserEmail = ug.UserEmail
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
    LEFT JOIN user_group ug ON l.UserEmail = ug.UserEmail
    WHERE l.EventName = 'claude_code.tool_result'
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime}
    GROUP BY "group", tool, mcp_server ORDER BY "group", total DESC LIMIT 50`,
    range(from, to)
  );
}

// Cost 페이지: 그룹별 근사 비용/토큰 요약 — cost.usage는 근사치라 A/B 실비용 비교엔 안 쓴다는
// 원칙은 유지, 여기선 "얼마나 쓰는지" 참고용 표시로만 사용.
export async function costSummary(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT
        ${GROUP_EXPR} AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.cost.usage')                            AS total_cost,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'input')  AS input_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage' AND m.TokenType = 'output') AS output_tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')                          AS sessions
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group" ORDER BY "group"`,
    range(from, to)
  );
}

// Cost 페이지: 모델별 비용/토큰 (cost.usage 행에도 model attribute가 실려있다고 가정 — 실측 필요).
export async function costByModel(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT ${GROUP_EXPR} AS "group", m.Model AS model,
        sumIf(m.Value, m.MetricName = 'claude_code.cost.usage')    AS cost,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')   AS tokens
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.Model != '' AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY "group", model ORDER BY "group", cost DESC`,
    range(from, to)
  );
}

// 유저별 어떤 tool을 얼마나 썼는지 (Usage/Users 페이지의 "사용자별 사용 내역").
export async function userToolUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT l.UserEmail AS user, any(${GROUP_EXPR}) AS "group", l.ToolName AS tool, count() AS uses
    FROM claude_code.otel_logs l
    LEFT JOIN user_group ug ON l.UserEmail = ug.UserEmail
    WHERE l.EventName = 'claude_code.tool_result' AND l.UserEmail != ''
      AND l.Timestamp >= {from:DateTime} AND l.Timestamp < {to:DateTime}
    GROUP BY user, tool ORDER BY user, uses DESC`,
    range(from, to)
  );
}

// 유저별 어떤 skill을 얼마나 썼는지.
export async function userSkillUsage(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT m.UserEmail AS user, any(${GROUP_EXPR}) AS "group", m.SkillName AS skill, count() AS invocations
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.MetricName = 'claude_code.cost.usage' AND m.SkillName != '' AND m.UserEmail != ''
      AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY user, skill ORDER BY user, invocations DESC`,
    range(from, to)
  );
}

// 패널10 확장: 유저별 리더보드 (생산성 점수는 이 raw 값을 productivity.js에서 계산)
export async function userLeaderboard(from, to) {
  return query(
    `${GROUP_CTE}
    SELECT
        m.UserEmail AS user,
        any(${GROUP_EXPR}) AS "group",
        sumIf(m.Value, m.MetricName = 'claude_code.session.count')                                    AS sessions,
        sumIf(m.Value, m.MetricName = 'claude_code.token.usage')                                       AS tokens,
        sumIf(m.Value, m.MetricName = 'claude_code.lines_of_code.count')                                AS loc,
        sumIf(m.Value, m.MetricName = 'claude_code.commit.count')                                      AS commits,
        sumIf(m.Value, m.MetricName = 'claude_code.code_edit_tool.decision' AND m.Decision = 'accept')  AS accepted,
        sumIf(m.Value, m.MetricName = 'claude_code.code_edit_tool.decision')                            AS decisions,
        uniqExact(toDate(m.TimeUnix))                                                                   AS active_days
    FROM claude_code.otel_metrics_sum m
    LEFT JOIN user_group ug ON m.UserEmail = ug.UserEmail
    WHERE m.UserEmail != '' AND m.TimeUnix >= {from:DateTime} AND m.TimeUnix < {to:DateTime}
    GROUP BY user ORDER BY tokens DESC`,
    range(from, to)
  );
}
