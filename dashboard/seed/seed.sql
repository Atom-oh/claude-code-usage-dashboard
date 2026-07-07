-- 로컬 검증용 샘플 데이터: bedrock 3명 / enterprise 3명, 최근 10일치
-- (기본 7일 범위 + 이전 기간 비교/주간 토글이 의미 있게 보이도록 4일보다 늘림).
-- 그룹은 대시보드가 model 패턴으로 자동판별하므로, bedrock 유저는 model에 ':'가 들어간
-- Bedrock 스타일 문자열을, enterprise 유저는 organization.id를 갖는 행을 심어둔다.
-- ClickHouse는 correlated subquery(하위 쿼리에서 바깥 컬럼 참조)를 지원하지 않으므로,
-- (ui, di, metric, extra) 는 독립적인 CROSS JOIN으로 만들고 value는 바깥 SELECT의 multiIf로 계산한다.
--
-- cumulative 운영 설정을 실제로 재현하기 위해 유저×일 단위를 "하나의 세션"(session.id = 이메일-di)
-- 으로 두고, 하루를 3번의 export 시점(frac=0.4/0.7/1.0 — 30초 간격 누적치 스냅샷)으로 쪼갠다.
-- Value = 최종값 × frac (누적 러닝토탈이라 frac=1.0일 때 원래 기대값과 같아진다). 만약 쿼리가
-- 세션별 경계 diff 대신 naive sum(Value)을 쓰면 하루치가 0.4+0.7+1.0=2.1배로 튀어나오므로,
-- 이 seed 자체가 "cumulative 경로가 실제로 쓰였는지"를 검증해준다.
INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
SELECT
    map('user.email', ['111111111111@ws', '222222222222@ws', '333333333333@ws'][ui + 1], 'team', 'fsi'),
    'claude-code',
    metric,
    mapUpdate(map(
        'model', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'session.id', concat(['111111111111@ws', '222222222222@ws', '333333333333@ws'][ui + 1], '-', toString(di))
    ), extra),
    now() - INTERVAL di DAY - INTERVAL toUInt32((1.0 - frac) * 600) SECOND,
    now() - INTERVAL di DAY - INTERVAL toUInt32((1.0 - frac) * 600) SECOND,
    frac * multiIf(
        metric = 'claude_code.session.count', toFloat64(1 + ui % 2),
        metric = 'claude_code.commit.count', toFloat64(ui + di % 3),
        metric = 'claude_code.pull_request.count', toFloat64(di % 2),
        metric = 'claude_code.token.usage' AND extra['type'] = 'input', toFloat64(1500 + ui * 300 + di * 100),
        metric = 'claude_code.token.usage' AND extra['type'] = 'output', toFloat64(800 + ui * 150),
        metric = 'claude_code.token.usage' AND extra['type'] = 'cacheRead', toFloat64(3000 + ui * 500),
        metric = 'claude_code.token.usage' AND extra['type'] = 'cacheCreation', toFloat64(600 + ui * 100),
        metric = 'claude_code.lines_of_code.count', toFloat64(60 + ui * 20 + di * 5),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'accept', toFloat64(12 + ui * 2),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'reject', toFloat64(2 + ui % 2),
        -- 토큰 실측(input/output/cacheRead/cacheCreation) × sonnet-4-5 단가(3/15/0.3/3.75 per 1M) × 1.05
        -- (Claude Code 자체 보고 비용은 실제 단가와 ~5% 드리프트가 있다는 걸 데모에서 보여주기 위한 의도적 오차)
        metric = 'claude_code.cost.usage',
            1.05 * ((1500 + ui * 300 + di * 100) * 3 + (800 + ui * 150) * 15
                    + (3000 + ui * 500) * 0.3 + (600 + ui * 100) * 3.75) / 1000000,
        0.0
    ),
    2, true
FROM (SELECT arrayJoin(range(3)) AS ui) u
CROSS JOIN (SELECT arrayJoin(range(10)) AS di) d
CROSS JOIN (SELECT arrayJoin([0.4, 0.7, 1.0]) AS frac) f
CROSS JOIN (
    SELECT 'claude_code.session.count' AS metric, map() AS extra
    UNION ALL SELECT 'claude_code.commit.count', map()
    UNION ALL SELECT 'claude_code.pull_request.count', map()
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'input')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'output')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'cacheRead')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'cacheCreation')
    UNION ALL SELECT 'claude_code.lines_of_code.count', map()
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'accept')
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'reject')
    UNION ALL SELECT 'claude_code.cost.usage', map('skill.name', 'code-review')
) m;

-- ── enterprise: 동일 지표, model/organization.id만 다름 ────────────────────
INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
SELECT
    map('user.email', ['alice@example.com', 'bob@example.com', 'carol@example.com'][ui + 1], 'team', 'fsi'),
    'claude-code',
    metric,
    -- organization.id는 grouping.js GROUP_CTE의 실측대로 datapoint Attributes에 심는다
    -- (ResourceAttributes에 있으면 GROUP_CTE가 못 찾아 enterprise 유저가 전부 'unknown'으로 샌다).
    mapUpdate(map(
        'model', 'claude-sonnet-4-5-20250929', 'organization.id', 'org-abc123',
        'session.id', concat(['alice@example.com', 'bob@example.com', 'carol@example.com'][ui + 1], '-', toString(di))
    ), extra),
    now() - INTERVAL di DAY - INTERVAL toUInt32((1.0 - frac) * 600) SECOND,
    now() - INTERVAL di DAY - INTERVAL toUInt32((1.0 - frac) * 600) SECOND,
    frac * multiIf(
        metric = 'claude_code.session.count', toFloat64(1 + ui % 2),
        metric = 'claude_code.commit.count', toFloat64(1 + ui + di % 2),
        metric = 'claude_code.pull_request.count', toFloat64((di + 1) % 2),
        metric = 'claude_code.token.usage' AND extra['type'] = 'input', toFloat64(1200 + ui * 250 + di * 80),
        metric = 'claude_code.token.usage' AND extra['type'] = 'output', toFloat64(700 + ui * 120),
        metric = 'claude_code.token.usage' AND extra['type'] = 'cacheRead', toFloat64(2200 + ui * 400),
        metric = 'claude_code.token.usage' AND extra['type'] = 'cacheCreation', toFloat64(500 + ui * 80),
        metric = 'claude_code.lines_of_code.count', toFloat64(90 + ui * 30 + di * 8),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'accept', toFloat64(15 + ui * 3),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'reject', toFloat64(1 + ui % 2),
        -- 토큰 실측(input/output/cacheRead/cacheCreation) × sonnet-4-5 단가(3/15/0.3/3.75 per 1M) × 1.05
        metric = 'claude_code.cost.usage',
            1.05 * ((1200 + ui * 250 + di * 80) * 3 + (700 + ui * 120) * 15
                    + (2200 + ui * 400) * 0.3 + (500 + ui * 80) * 3.75) / 1000000,
        0.0
    ),
    2, true
FROM (SELECT arrayJoin(range(3)) AS ui) u
CROSS JOIN (SELECT arrayJoin(range(10)) AS di) d
CROSS JOIN (SELECT arrayJoin([0.4, 0.7, 1.0]) AS frac) f
CROSS JOIN (
    SELECT 'claude_code.session.count' AS metric, map() AS extra
    UNION ALL SELECT 'claude_code.commit.count', map()
    UNION ALL SELECT 'claude_code.pull_request.count', map()
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'input')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'output')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'cacheRead')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'cacheCreation')
    UNION ALL SELECT 'claude_code.lines_of_code.count', map()
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'accept')
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'reject')
    UNION ALL SELECT 'claude_code.cost.usage', map('skill.name', 'brainstorming')
) m;

-- ── 활성 사용시간 ────────────────────────────────────────────────────────
-- 실측 확인(queries.js activeTimeSeries 주석 참고): active_time.total은 gauge가 아니라
-- sum 테이블로 들어온다. seed도 여기 맞춰 otel_metrics_sum에 심는다(gauge 테이블은 미사용).
INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
SELECT
    map('user.email', ['111111111111@ws', '222222222222@ws', '333333333333@ws'][ui + 1]),
    'claude-code', 'claude_code.active_time.total', map('model', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    now() - INTERVAL di DAY, now() - INTERVAL di DAY, toFloat64(1800 + ui * 600 + di * 100), 1, true
FROM (SELECT arrayJoin(range(3)) AS ui) u CROSS JOIN (SELECT arrayJoin(range(10)) AS di) d;

INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
SELECT
    map('user.email', ['alice@example.com', 'bob@example.com', 'carol@example.com'][ui + 1]),
    'claude-code', 'claude_code.active_time.total', map('model', 'claude-sonnet-4-5-20250929'),
    now() - INTERVAL di DAY, now() - INTERVAL di DAY, toFloat64(1500 + ui * 500 + di * 90), 1, true
FROM (SELECT arrayJoin(range(3)) AS ui) u CROSS JOIN (SELECT arrayJoin(range(10)) AS di) d;

-- ── tool/MCP 사용 로그 ──────────────────────────────────────────────────
INSERT INTO claude_code.otel_logs
(Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName, Body, ResourceAttributes, LogAttributes)
SELECT now() - INTERVAL di DAY, '', '', 'INFO', 9, 'claude-code', '', map('user.email', email),
       map('event.name', 'tool_result', 'tool_name', tool, 'mcp_server_name', mcp, 'success', succ)
FROM (SELECT arrayJoin(range(10)) AS di) d
CROSS JOIN (
    SELECT '111111111111@ws' AS email, 'Bash' AS tool, '' AS mcp, 'true' AS succ
    UNION ALL SELECT '222222222222@ws', 'Read', '', 'true'
    UNION ALL SELECT '333333333333@ws', 'mcp__playwright__browser_click', 'playwright', 'false'
    UNION ALL SELECT 'alice@example.com', 'Edit', '', 'true'
    UNION ALL SELECT 'bob@example.com', 'Bash', '', 'true'
    UNION ALL SELECT 'carol@example.com', 'mcp__notion__search', 'notion', 'true'
) r;

-- "에이전틱함" 지표(프롬프트당 툴호출수)용 user_prompt 이벤트 — 실제 이벤트명 실측 전 임시.
INSERT INTO claude_code.otel_logs
(Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName, Body, ResourceAttributes, LogAttributes)
SELECT now() - INTERVAL di DAY, '', '', 'INFO', 9, 'claude-code', '', map('user.email', email),
       map('event.name', 'user_prompt')
FROM (SELECT arrayJoin(range(10)) AS di) d
CROSS JOIN (
    SELECT '111111111111@ws' AS email UNION ALL SELECT '111111111111@ws'
    UNION ALL SELECT '222222222222@ws' UNION ALL SELECT 'alice@example.com'
    UNION ALL SELECT 'bob@example.com' UNION ALL SELECT 'carol@example.com'
) r;
