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
