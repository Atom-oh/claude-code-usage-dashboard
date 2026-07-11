-- =============================================================================
-- Grafana A/B 대시보드 쿼리 (ClickHouse 데이터소스)
-- 공통: 모든 쿼리는 ExperimentGroup 으로 분리해 bedrock vs enterprise 비교
--       $__timeFilter / $__fromTime / $__toTime 은 Grafana ClickHouse 매크로
-- 주의: cost.usage 는 근사치라 "실비용 비교" 금지 → 토큰 정규화로 대체
-- 주의: 대시보드(dashboard/server)는 2026-07-10부터 시간별 rollup(otel_metrics_sum_hourly,
--       clickhouse-schema.sql)을 읽는다. 아래 레거시 패널은 원본 테이블을 그대로 읽으며 유효
--       — 단 cumulative 이중합산 이슈(sum(Value) 직접 합산 금지)는 여기서도 동일하게 적용된다.
-- =============================================================================


-- 【패널 1】그룹별 KPI 요약 (Stat 패널, 표 형태)
-- 세션/유저/커밋/PR/토큰/추가라인
SELECT
    ExperimentGroup,
    uniqExactIf(SessionId, false) AS _placeholder,   -- (metric엔 session 없음, logs와 조인 시 사용)
    sumIf(Value, MetricName = 'claude_code.session.count')      AS sessions,
    uniqExact(UserEmail)                                        AS users,
    sumIf(Value, MetricName = 'claude_code.commit.count')       AS commits,
    sumIf(Value, MetricName = 'claude_code.pull_request.count') AS prs,
    sumIf(Value, MetricName = 'claude_code.token.usage')        AS total_tokens,
    sumIf(Value, MetricName = 'claude_code.lines_of_code.count' AND TokenType = 'added') AS lines_of_code
FROM claude_code.otel_metrics_sum
WHERE $__timeFilter(TimeUnix)
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;


-- 【패널 2】토큰 사용량 시계열 (Time series, 그룹별 라인)
SELECT
    $__timeInterval(TimeUnix) AS t,
    ExperimentGroup,
    sum(Value) AS tokens
FROM claude_code.otel_metrics_sum
WHERE MetricName = 'claude_code.token.usage'
  AND $__timeFilter(TimeUnix)
GROUP BY t, ExperimentGroup
ORDER BY t;


-- 【패널 3】캐시 효율 = cacheRead / (input+cacheRead)  ← 설정 건강도 핵심 지표
-- 그룹별로 캐시 재사용률을 비교하면 A/B 교란(프롬프트 구조 차이) 진단 가능
SELECT
    ExperimentGroup,
    sumIf(Value, TokenType = 'cacheRead')                                AS cache_read,
    sumIf(Value, TokenType IN ('input','cacheRead'))                     AS input_side,
    round(cache_read / nullIf(input_side, 0), 3)                         AS cache_read_ratio
FROM claude_code.otel_metrics_sum
WHERE MetricName = 'claude_code.token.usage'
  AND $__timeFilter(TimeUnix)
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;


-- 【패널 4】토큰 정규화 생산성 = 라인 / 백만토큰  (진짜 A/B 비교 지표)
-- 비용 대신 토큰당 산출물로 비교 → Bedrock/Enterprise 요금 차이 교란 제거
SELECT
    ExperimentGroup,
    sumIf(Value, MetricName = 'claude_code.lines_of_code.count' AND TokenType = 'added') AS loc,
    sumIf(Value, MetricName = 'claude_code.token.usage')                  AS tokens,
    round(loc / nullIf(tokens, 0) * 1000000, 2)                           AS loc_per_million_tokens,
    sumIf(Value, MetricName = 'claude_code.commit.count')                 AS commits,
    round(sumIf(Value, MetricName='claude_code.commit.count')
          / nullIf(sumIf(Value, MetricName='claude_code.token.usage'),0) * 1000000, 3)
                                                                          AS commits_per_million_tokens
FROM claude_code.otel_metrics_sum
WHERE $__timeFilter(TimeUnix)
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;


-- 【패널 5】코드 수락률 = accept / (accept+reject)  (그룹별 Bar)
-- decision 값 실측 필요(accept/reject). query_source='main' 필터로 노이즈 제거는
-- decision metric엔 query_source가 없을 수 있으니 실측 후 조정.
SELECT
    ExperimentGroup,
    Decision,
    sum(Value) AS n
FROM claude_code.otel_metrics_sum
WHERE MetricName = 'claude_code.code_edit_tool.decision'
  AND $__timeFilter(TimeUnix)
GROUP BY ExperimentGroup, Decision
ORDER BY ExperimentGroup, Decision;


-- 【패널 6】모델별 토큰 분포 (그룹별로 어떤 모델을 실제 쓰는지 — 교란 점검용)
-- Enterprise가 최신 모델, Bedrock이 구모델이면 생산성 차이가 모델 차이일 수 있음
SELECT
    ExperimentGroup,
    Model,
    sum(Value) AS tokens
FROM claude_code.otel_metrics_sum
WHERE MetricName = 'claude_code.token.usage'
  AND $__timeFilter(TimeUnix)
GROUP BY ExperimentGroup, Model
ORDER BY ExperimentGroup, tokens DESC;


-- 【패널 7】skill 사용 분포 (cost.usage의 skill.name attribute 활용)
SELECT
    ExperimentGroup,
    SkillName,
    count() AS invocations,
    sum(Value) AS est_cost_usd     -- 근사치, 그룹 내 상대 비교용으로만
FROM claude_code.otel_metrics_sum
WHERE MetricName = 'claude_code.cost.usage'
  AND SkillName != ''
  AND $__timeFilter(TimeUnix)
GROUP BY ExperimentGroup, SkillName
ORDER BY ExperimentGroup, invocations DESC;


-- 【패널 8】tool use / MCP 사용 패턴 (logs 테이블) — plugin/tool 세밀 추적
SELECT
    ExperimentGroup,
    ToolName,
    McpServerName,
    countIf(Success = 'true')  AS ok,
    countIf(Success = 'false') AS fail,
    count()                    AS total
FROM claude_code.otel_logs
WHERE EventName = 'claude_code.tool_result'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, ToolName, McpServerName
ORDER BY ExperimentGroup, total DESC
LIMIT 50;


-- 【패널 9】활성 사용시간 (adoption 지표, 그룹별 시계열)
SELECT
    $__timeInterval(TimeUnix) AS t,
    ExperimentGroup,
    sum(Value) AS active_seconds
FROM claude_code.otel_metrics_gauge
WHERE MetricName = 'claude_code.active_time.total'
  AND $__timeFilter(TimeUnix)
GROUP BY t, ExperimentGroup
ORDER BY t;
-- active_time이 sum 계열로 들어오면 위 테이블명을 otel_metrics_sum 으로 교체.


-- 【패널 10】유저별 채택 편차 (그룹 내 소수가 사용량 독점하는지)
SELECT
    ExperimentGroup,
    UserEmail,
    sumIf(Value, MetricName = 'claude_code.session.count') AS sessions,
    sumIf(Value, MetricName = 'claude_code.token.usage')   AS tokens
FROM claude_code.otel_metrics_sum
WHERE $__timeFilter(TimeUnix)
  AND UserEmail != ''
GROUP BY ExperimentGroup, UserEmail
ORDER BY ExperimentGroup, tokens DESC;
