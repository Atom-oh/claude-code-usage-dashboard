-- =============================================================================
-- Grafana A/B 대시보드 쿼리 (ClickHouse 데이터소스)
-- 공통: 모든 쿼리는 ExperimentGroup 으로 분리해 bedrock vs enterprise 비교
--       $__timeFilter / $__fromTime / $__toTime 은 Grafana ClickHouse 매크로
-- 주의: cost.usage 는 근사치라 "실비용 비교" 금지 → 토큰 정규화로 대체
-- 주의: 대시보드(dashboard/server)는 2026-07-10부터 시간별 rollup(otel_metrics_sum_hourly,
--       clickhouse-schema.sql)을 읽는다. 아래 레거시 패널은 원본 테이블을 그대로 읽으며 유효
--       — 단 cumulative 이중합산 이슈(sum(Value) 직접 합산 금지)는 여기서도 동일하게 적용된다.
-- 주의(2026-08-11, 문서 확인): claude_code.internal_error는 Bedrock에서는 emit되지 않는다.
--       에러율을 그룹 간 직접 비교하는 패널을 만들 경우 이 비대칭을 반드시 감안할 것 —
--       Bedrock의 낮은 에러 건수가 "더 안정적"이 아니라 "그 카테고리 자체가 안 잡힘"일 수 있다.
-- =============================================================================


-- 【패널 1】그룹별 KPI 요약 (Stat 패널, 표 형태)
-- 세션/유저/커밋/PR/토큰/추가라인
-- agents_view는 `claude agents` 대시보드 프로세스 실행이라 대화 세션이 아니다 — 세션 카운트에
-- 섞이면 채택률이 부풀려진다(2026-08-11 STEP 1). 실측(2026-08-11)으로는 이 값이 0행이라 지금
-- 수치는 바뀌지 않지만, 향후 유입을 막는 예방 필터다.
SELECT
    ExperimentGroup,
    uniqExactIf(SessionId, false) AS _placeholder,   -- (metric엔 session 없음, logs와 조인 시 사용)
    sumIf(Value, MetricName = 'claude_code.session.count' AND StartType != 'agents_view') AS sessions,
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
-- McpServerName은 컬럼명으로 참조(인라인 Attributes['mcp_server_name']이 아님)이므로, 스키마
-- 쪽에서 그 컬럼의 MATERIALIZED 정의를 JSONExtractString(...tool_parameters...)으로 교체(2026-07)해도
-- 이 패널은 자동으로 고쳐진 값을 읽는다 — 별도 갱신 불필요(리뷰에서 확인, diff 대조).
--
-- 버그 수정(2026-08-11, 실측으로 발견): EventName은 'claude_code.tool_result'가 아니라
-- bare 'tool_result'로 들어온다 — MATERIALIZED 식이 LogAttributes['event.name']를 그대로
-- 쓰고 exporter가 이미 프리픽스 없는 이름으로 보낸다(실측: EventName 상위값 어디에도
-- 'claude_code.' 프리픽스가 붙은 게 없음). 이전 조건은 항상 0행을 반환해 이 패널이
-- 죽어 있었다.
--
-- 4-3: mcp_server.name의 의미가 v2.1.222 전후로 다르다(문서 미기재, MCP 툴 호출 이후
-- 모든 요청 → 툴 결과를 실제로 소비한 요청만). 업그레이드 전후 데이터를 한 그래프에
-- 섞으면 계단식 하락이 보일 수 있다 — AppVersion을 같이 노출해 그 경계를 의심할 수 있게
-- 한다(단정이 아니라 참고용 annotation).
SELECT
    ExperimentGroup,
    ToolName,
    McpServerName,
    AppVersion,
    countIf(Success = 'true')  AS ok,
    countIf(Success = 'false') AS fail,
    count()                    AS total
FROM claude_code.otel_logs
WHERE EventName = 'tool_result'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, ToolName, McpServerName, AppVersion
ORDER BY ExperimentGroup, total DESC
LIMIT 50;


-- 【패널 9】활성 사용시간 (adoption 지표, 그룹별 시계열)
-- active_time.total은 이름과 달리 gauge가 아니라 sum(counter) 테이블로 들어온다
-- (실측 2026-07-06, dashboard/server/queries.js:597) — 예전 패널은 otel_metrics_gauge를 읽어
-- 항상 빈 결과였다. 누적 카운터라 sum(Value)는 과대집계이므로 시리즈(SeriesKey)·세션 단위
-- 경계 diff로 버킷별 증가량을 만든다(대시보드 incBucketed와 같은 규칙).
SELECT t, ExperimentGroup, sum(inc) AS active_seconds
FROM (
    SELECT t, ExperimentGroup,
        if(temp = 2,
           greatest(cum - lagInFrame(cum, 1, 0) OVER (
               PARTITION BY sk, SessionId, temp, ExperimentGroup ORDER BY t
           ), 0),
           cum) AS inc
    FROM (
        SELECT $__timeInterval(TimeUnix) AS t,
               SeriesKey AS sk, SessionId, AggregationTemporality AS temp, ExperimentGroup,
               if(AggregationTemporality = 2, max(Value), sum(Value)) AS cum
        FROM claude_code.otel_metrics_sum
        WHERE MetricName = 'claude_code.active_time.total'
          AND $__timeFilter(TimeUnix)
        GROUP BY t, sk, SessionId, temp, ExperimentGroup
    )
)
GROUP BY t, ExperimentGroup
ORDER BY t;
-- 대시보드(queries.js)와 다른 점: 첫 버킷의 baseline을 조회 구간 이전 원본에서 끌어오는
-- stitch가 없어서, 구간 시작 전에 시작된 세션의 첫 버킷이 그 세션 누적값만큼 과대집계된다.
-- 패널 용도(추이 비교)에는 충분하고 정확한 총량은 대시보드를 쓴다.


-- 【패널 10】유저별 채택 편차 (그룹 내 소수가 사용량 독점하는지)
-- 4-1: Bedrock 그룹은 user.email이 없다(Claude 계정 자체가 없음, user-data.sh의 enduser.id
-- 주입 참고) — coalesce로 폴백해야 Bedrock 유저가 이 패널에서 통째로 사라지지 않는다.
SELECT
    ExperimentGroup,
    coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, '')) AS UserIdentity,
    sumIf(Value, MetricName = 'claude_code.session.count' AND StartType != 'agents_view') AS sessions,
    sumIf(Value, MetricName = 'claude_code.token.usage')   AS tokens
FROM claude_code.otel_metrics_sum
WHERE $__timeFilter(TimeUnix)
  AND coalesce(nullIf(UserEmail, ''), nullIf(EndUserId, '')) IS NOT NULL
GROUP BY ExperimentGroup, UserIdentity
ORDER BY ExperimentGroup, tokens DESC;


-- 【패널 11】권한 대기 오버헤드 (traces beta) — claude_code.tool.blocked_on_user의 DurationMs
-- p50/p95, 그룹별. 이게 크면 권한 설정이 개발자 생산성을 깎고 있다는 뜻이고, A/B에서
-- 플랫폼 차이가 아니라 설정 차이가 결과를 오염시키는 주요 원인이 될 수 있다.
-- 주의: 이 스팬은 Claude Code v2.1.214+에서만 나온다(문서 확인) — 그 이전 버전 인스턴스는
-- 이 패널에서 그냥 빈 값으로 나온다(구버전 호환은 범위 밖이라는 결정에 따름, 0으로 위장하지
-- 않도록 count()=0인 그룹은 별도로 확인할 것 — 대시보드 앱 계층은 unsupported로 구분해 낸다).
SELECT
    ExperimentGroup,
    AppVersion,
    quantile(0.5)(DurationMs)  AS p50_wait_ms,
    quantile(0.95)(DurationMs) AS p95_wait_ms,
    count() AS n
FROM claude_code.otel_traces
WHERE SpanType = 'claude_code.tool.blocked_on_user'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, AppVersion
ORDER BY ExperimentGroup, AppVersion;


-- 【패널 12】TTFT 비교 (traces beta) — claude_code.llm_request의 TtftMs p50/p95를
-- 그룹 × 모델로. Bedrock vs Enterprise의 체감 응답성 비교에 가장 직접적인 지표.
-- normModel(Model)은 dashboard/server/queries.js의 JS 헬퍼라 여기선 직접 호출할 수 없다 —
-- 같은 5단계 regex를 인라인으로 재현한다(normModel()과 반드시 동기 유지: [1m] 컨텍스트
-- 윈도우 접미사 → cross-region 프로파일 접두사 → bedrock provider 접두사 → bedrock 버전
-- 접미사(-v1:0 / 맨 -v1 둘 다) → 날짜 스냅샷 접미사).
SELECT
    ExperimentGroup,
    replaceRegexpOne(
        replaceRegexpOne(
            replaceRegexpOne(
                replaceRegexpOne(
                    replaceRegexpOne(Model, '\\[.*\\]$', ''),
                    '^(us|global|eu|apac)\\.', ''),
                '^anthropic\\.', ''),
            '-v\\d+(:\\d+)?$', ''),
        '-\\d{8}$', '') AS model,
    quantile(0.5)(TtftMs)  AS p50_ttft_ms,
    quantile(0.95)(TtftMs) AS p95_ttft_ms,
    count() AS n
FROM claude_code.otel_traces
WHERE SpanType = 'claude_code.llm_request'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, Model
ORDER BY ExperimentGroup, n DESC;


-- 【패널 13】서브에이전트 팬아웃 — traces beta가 아니라 otel_logs의 subagent_completed로
-- 구현한다(오늘 실데이터 745행 존재, 베타 플래그 불필요 — 문서에 없는 이벤트지만 실측 확인).
-- prompt.id(인터랙션 단위)당 subagent_completed 건수 분포.
-- total_tool_uses/total_tokens/is_built_in/agent.source는 이번 마이그레이션에서 promoted
-- 컬럼으로 승격하지 않았다(범위 밖 — 팬아웃 분포만 필요) — 필요해지면
-- toUInt64OrZero(LogAttributes['total_tool_uses']) 형태로 직접 뽑아 쓸 것.
SELECT
    ExperimentGroup,
    count() AS subagent_completions,
    uniqExact(PromptId) AS interactions,
    round(count() / nullIf(uniqExact(PromptId), 0), 2) AS avg_subagents_per_interaction
FROM claude_code.otel_logs
WHERE EventName = 'subagent_completed'
  AND $__timeFilter(Timestamp)
  AND PromptId != ''
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;


-- 【패널 14】스킬 발동 분포 (skill_activated) — skill.name × invocation_trigger 분해.
-- 워크숍에서 만든 스킬이 실제로 자동 발동하는지(claude-proactive 비율)가 핵심 지표 —
-- 실측(2026-08-11): claude-proactive 92+12+9+1=114/521 ≈ 22%, 이미 유의미한 신호.
SELECT
    ExperimentGroup,
    SkillName,
    InvocationTrigger,
    count() AS invocations
FROM claude_code.otel_logs
WHERE EventName = 'skill_activated'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, SkillName, InvocationTrigger
ORDER BY ExperimentGroup, invocations DESC;


-- 【패널 15】compaction 압박 — 세션당 발생 횟수 + 압축률(1 - post/pre), trigger별 분해.
-- 컨텍스트 압박 프록시: 압축률이 낮거나 빈도가 높으면 세션이 컨텍스트 한도에 자주 부딕힌다.
SELECT
    ExperimentGroup,
    CompactionTrigger,
    count() AS compactions,
    uniqExact(SessionId) AS sessions,
    round(count() / nullIf(uniqExact(SessionId), 0), 2) AS compactions_per_session,
    round(avg(1 - PostTokens / nullIf(PreTokens, 0)), 3) AS avg_compression_ratio
FROM claude_code.otel_logs
WHERE EventName = 'compaction'
  AND $__timeFilter(Timestamp)
  AND PreTokens > 0
GROUP BY ExperimentGroup, CompactionTrigger
ORDER BY ExperimentGroup, compactions DESC;


-- 【패널 16】refusal 율 — 그룹별. server_fallback_hop='true'는 사용자가 못 본 refusal(서버가
-- 이미 다른 모델로 재시도해 성공한 경우)이니 최종 집계에서 제외하고 별도 시리즈로 둔다.
SELECT
    ExperimentGroup,
    countIf(ServerFallbackHop != 'true') AS user_visible_refusals,
    countIf(ServerFallbackHop = 'true')  AS server_hidden_refusals   -- 별도 시리즈, 집계에 합산 금지
FROM claude_code.otel_logs
WHERE EventName = 'api_refusal'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;


-- 【패널 17】재시도 소진 — 그룹별 건수 + 총 시도/재시도 시간. Bedrock 쿼터 병목 탐지에 직결
-- (Bedrock은 온디맨드 처리량 쿼터가 있어 이 이벤트가 그룹 간 비대칭이면 강한 신호).
SELECT
    ExperimentGroup,
    count() AS exhausted_retries,
    round(avg(TotalAttempts), 1)          AS avg_total_attempts,
    round(avg(TotalRetryDurationMs), 0)   AS avg_retry_duration_ms
FROM claude_code.otel_logs
WHERE EventName = 'api_retries_exhausted'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;


-- 【패널 18】플러그인 인벤토리 — 플릿 전체에서 어떤 플러그인이 활성인지(세션 시작마다 발생).
SELECT
    PluginName,
    MarketplaceName,
    count() AS session_loads,
    uniqExact(SessionId) AS sessions
FROM claude_code.otel_logs
WHERE EventName = 'plugin_loaded'
  AND $__timeFilter(Timestamp)
  AND PluginName != ''
GROUP BY PluginName, MarketplaceName
ORDER BY session_loads DESC;
-- 중간 우선순위 이벤트(permission_mode_changed/hook_registered/hook_execution_complete/
-- assistant_response/at_mention/auth/mcp_server_connection)는 전부 이미 수집되고 있다
-- (실측 확인, 2026-08-11) — 패널은 아직 만들지 않음.


-- 【패널 19】Claude Code 버전 혼재 검증 — 4-2. 두 그룹이 같은 버전을 쓰는지 확인.
-- 실측(2026-08-11): 이 플릿은 2.1.202~2.1.226 20개 버전이 혼재해 있었다 — 이 패널은 그
-- 상태에서 즉시 붉은 신호를 낸다. user-data.sh의 CLAUDE_CODE_VERSION 핀이 적용된 뒤에는
-- 각 그룹이 단일(또는 소수) 버전으로 모이는지 이 패널로 확인할 것.
SELECT
    ExperimentGroup,
    AppVersion,
    uniqExact(SessionId) AS sessions
FROM claude_code.otel_metrics_sum
WHERE $__timeFilter(TimeUnix)
  AND AppVersion != ''
GROUP BY ExperimentGroup, AppVersion
ORDER BY ExperimentGroup, sessions DESC;


-- 【패널 20】버전 코호트별 이중계상 실측 — 4-2. v2.1.214 이전엔 게이트웨이/프록시가 usage를
-- 여러 프레임으로 스트리밍하면 cost.usage/token.usage가 프레임당 중복 집계됐다는 게 문서에
-- 없는 주장이므로, 코호트를 나눠 실측으로 검증한다. 비율이 코호트 간 유의하게 다르면(예:
-- pre-2.1.214가 몇 배 높음) 이 버그가 실재했다는 증거 — clickhouse-schema.sql 상단에
-- 실측 결과를 `실측 확인: ...`로 기록할 것.
-- 버전을 문자열로 직접 비교(`AppVersion < '2.1.214'`)하면 사전순 비교라 틀린다 —
-- 예: '2.1.30' < '2.1.214'는 사전순으로 false('3' > '2')지만 실제로는 30 < 214라 true여야
-- 한다(실측 확인). major/minor/patch를 각각 정수로 쪼개 튜플로 비교해야 자릿수와 무관하게
-- 정확하다 — 지금 관측된 버전(2.1.202~2.1.226)은 전부 세 자리라 우연히 틀리지 않았을
-- 뿐이다.
SELECT
    ExperimentGroup,
    if(
        (toUInt32OrZero(splitByChar('.', AppVersion)[1]),
         toUInt32OrZero(splitByChar('.', AppVersion)[2]),
         toUInt32OrZero(splitByChar('.', AppVersion)[3])) < (2, 1, 214),
        'pre-2.1.214', '>=2.1.214'
    ) AS version_cohort,
    sumIf(Value, MetricName = 'claude_code.cost.usage')  AS cost_usd,
    sumIf(Value, MetricName = 'claude_code.token.usage') AS tokens,
    round(sumIf(Value, MetricName = 'claude_code.cost.usage')
          / nullIf(sumIf(Value, MetricName = 'claude_code.token.usage'), 0) * 1000000, 4)
                                                          AS usd_per_million_tokens
FROM claude_code.otel_metrics_sum
WHERE $__timeFilter(TimeUnix)
  AND AppVersion != ''
GROUP BY ExperimentGroup, version_cohort
ORDER BY ExperimentGroup, version_cohort;
-- 주의: 이 비율은 sum(Value)를 코호트 스냅샷으로 직접 쓴다 — 세션이 코호트 경계를 걸쳐
-- 버전업하면(드묾) 그 세션의 cumulative 누적값이 어느 코호트에도 깨끗하게 안 떨어질 수
-- 있다. 패널 4(토큰 정규화 생산성)와 동일한 근사 수준으로 충분하다(실비용 비교 아님).


-- 【패널 21】API 에러율 — 그룹 × 모델. api_error / (api_request + api_error). Bedrock 스로틀링·
-- 검증 오류의 조기 신호로, 에러가 한쪽 그룹에만 몰리면 그 그룹의 생산성 하락은 플랫폼 특성이
-- 아니라 장애다. 파일 상단 주의사항(claude_code.internal_error는 Bedrock에서 emit되지 않음)과
-- 달리 api_error는 양쪽 모두에서 나온다.
-- 분모를 합집합(api_request + api_error)으로 쓴 이유: api_request가 실패 요청까지 포함하는지
-- (api_error가 부분집합인지)가 문서에도 실측에도 없다. 실측 2026-08-31: api_request 176,597행 /
-- api_error 580행이라 두 해석의 상대 차이는 0.33%이고, 합집합 분모는 어느 해석에서도 값이
-- [0,1]을 벗어나지 않는다(disjoint일 때 errors/requests는 1을 넘을 수 있다).
-- otel_logs엔 Model 승격 컬럼이 없어 LogAttributes['model']을 쓴다. normModel()은 JS 헬퍼라
-- 여기선 못 부르므로 패널 12와 동일한 5단계 regex를 인라인 재현한다(반드시 동기 유지).
SELECT
    ExperimentGroup,
    replaceRegexpOne(
        replaceRegexpOne(
            replaceRegexpOne(
                replaceRegexpOne(
                    replaceRegexpOne(LogAttributes['model'], '\\[.*\\]$', ''),
                    '^(us|global|eu|apac)\\.', ''),
                '^anthropic\\.', ''),
            '-v\\d+(:\\d+)?$', ''),
        '-\\d{8}$', '') AS model,
    countIf(EventName = 'api_request') AS requests,
    countIf(EventName = 'api_error')   AS errors,
    count()                            AS total,
    round(errors / nullIf(total, 0), 4) AS error_rate
FROM claude_code.otel_logs
WHERE EventName IN ('api_request', 'api_error')
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, model
ORDER BY ExperimentGroup, total DESC;

-- 【패널 21b】API 에러 상태코드 분포 — status_code가 빈 문자열인 에러(실측 2026-08-31: 580건 중
-- 35건)는 HTTP 상태가 아예 없는 전송 계층 실패(예: Stream idle timeout)다. 집계에서 버리면 가장
-- 중요한 케이스가 사라지므로 'no-http-status' 센티널로 따로 남긴다.
SELECT
    ExperimentGroup,
    if(LogAttributes['status_code'] = '', 'no-http-status', LogAttributes['status_code']) AS status_code,
    count() AS errors
FROM claude_code.otel_logs
WHERE EventName = 'api_error'
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, status_code
ORDER BY ExperimentGroup, errors DESC;


-- 【패널 22】툴 권한 결정 퍼널 — tool_decision을 툴 × 허용 출처(source) × 수락/거부로 분해.
-- source가 핵심 지표다: config는 사전 허용(개발자를 안 멈춤), user_temporary는 매번 물어봤다는
-- 뜻(권한 대기로 생산성이 깎임), user_permanent는 사용자가 직접 허용목록에 넣은 것.
-- 실측 2026-08-31: tool_decision 169,862행, tool_name/decision/source 키 전부 100%.
-- decision을 행 차원이 아니라 countIf 컬럼으로 펴서 accept_rate가 행마다 나오게 한다(패널 16과
-- 같은 스타일). n != accepts + rejects인 행은 accept/reject 외의 decision 값이 생겼다는 신호.
-- 상위 20개 툴 서브쿼리는 그룹을 안 나눈다 — 그룹별 상위 20개면 두 그룹의 툴 집합이 달라져
-- A/B 비교가 성립하지 않는다.
SELECT
    ExperimentGroup,
    ToolName AS tool,
    LogAttributes['source'] AS source,
    countIf(LogAttributes['decision'] = 'accept') AS accepts,
    countIf(LogAttributes['decision'] = 'reject') AS rejects,
    count() AS n,
    round(accepts / nullIf(accepts + rejects, 0), 3) AS accept_rate
FROM claude_code.otel_logs
WHERE EventName = 'tool_decision'
  AND ToolName != ''
  AND ToolName IN (
      SELECT ToolName FROM claude_code.otel_logs
      WHERE EventName = 'tool_decision' AND ToolName != ''
        AND $__timeFilter(Timestamp)
      GROUP BY ToolName ORDER BY count() DESC LIMIT 20
  )
  AND $__timeFilter(Timestamp)
GROUP BY ExperimentGroup, tool, source
ORDER BY ExperimentGroup, n DESC;


-- 【패널 23】인터랙션 시간 분해 (traces beta) — claude_code.interaction 스팬의 DurationMs p50/p95와,
-- 그 시간 중 자식 스팬(llm_request / tool.execution / tool.blocked_on_user)이 차지한 비중.
-- "느린 게 모델 때문인가, 툴 실행 때문인가, 권한 대기 때문인가"를 한 표로 가른다.
-- 자식은 TraceId로 붙인다(한 인터랙션의 스팬들이 TraceId를 공유하고 interaction 스팬이 루트).
-- 자식을 TraceId 단위로 먼저 접어 1:1로 조인하는 게 필수 — SpanType별 자식 행을 그대로 조인하면
-- interaction 행이 자식 종류 수만큼 복제돼 quantile과 분모가 그 배수로 뻥튀기된다.
-- 비중 합계는 1을 넘을 수 있다(자식 스팬 동시 실행 + tool 스팬 duration_ms가 대기 + 실행 포함) —
-- 구성비가 아니라 "인터랙션 총 시간 대비 각 종류가 쓴 시간의 배수"로 읽을 것.
-- 주의: otel_traces는 실측 2026-08-31 기준 0행이다 — 이 패널이 비어 있으면 "대기 0"이 아니라
-- traces beta 미배포다(패널 11/12와 동일. 대시보드 앱 계층은 unsupported로 구분해 낸다).
SELECT
    i.ExperimentGroup AS ExperimentGroup,
    count() AS interactions,
    quantile(0.5)(i.DurationMs)  AS p50_interaction_ms,
    quantile(0.95)(i.DurationMs) AS p95_interaction_ms,
    round(sum(c.llm_ms)       / nullIf(sum(i.DurationMs), 0), 3) AS llm_share,
    round(sum(c.tool_exec_ms) / nullIf(sum(i.DurationMs), 0), 3) AS tool_exec_share,
    round(sum(c.blocked_ms)   / nullIf(sum(i.DurationMs), 0), 3) AS blocked_share
FROM (
    SELECT TraceId, ExperimentGroup, DurationMs
    FROM claude_code.otel_traces
    WHERE SpanType = 'claude_code.interaction'
      AND $__timeFilter(Timestamp)
) i
LEFT JOIN (
    SELECT TraceId,
        sumIf(DurationMs, SpanType = 'claude_code.llm_request')          AS llm_ms,
        sumIf(DurationMs, SpanType = 'claude_code.tool.execution')       AS tool_exec_ms,
        sumIf(DurationMs, SpanType = 'claude_code.tool.blocked_on_user') AS blocked_ms
    FROM claude_code.otel_traces
    WHERE SpanType IN ('claude_code.llm_request', 'claude_code.tool.execution', 'claude_code.tool.blocked_on_user')
      AND $__timeFilter(Timestamp)
    GROUP BY TraceId
) c ON i.TraceId = c.TraceId
GROUP BY ExperimentGroup
ORDER BY ExperimentGroup;
