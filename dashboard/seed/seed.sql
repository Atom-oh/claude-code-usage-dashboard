-- 로컬 검증용 샘플 데이터: bedrock 3명 / enterprise 3명, 최근 4일치.
-- 그룹은 대시보드가 model 패턴으로 자동판별하므로, bedrock 유저는 model에 ':'가 들어간
-- Bedrock 스타일 문자열을, enterprise 유저는 organization.id를 갖는 행을 심어둔다.
-- ClickHouse는 correlated subquery(하위 쿼리에서 바깥 컬럼 참조)를 지원하지 않으므로,
-- (ui, di, metric, extra) 는 독립적인 CROSS JOIN으로 만들고 value는 바깥 SELECT의 multiIf로 계산한다.

-- ── bedrock: session/commit/pr/tokens/loc/decisions/cost ──────────────────
INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
SELECT
    map('user.email', ['111111111111@ws', '222222222222@ws', '333333333333@ws'][ui + 1], 'team', 'fsi'),
    'claude-code',
    metric,
    mapUpdate(map('model', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'), extra),
    now() - INTERVAL di DAY,
    now() - INTERVAL di DAY,
    multiIf(
        metric = 'claude_code.session.count', toFloat64(1 + ui % 2),
        metric = 'claude_code.commit.count', toFloat64(ui + di % 3),
        metric = 'claude_code.pull_request.count', toFloat64(di % 2),
        metric = 'claude_code.token.usage' AND extra['type'] = 'input', toFloat64(1500 + ui * 300 + di * 100),
        metric = 'claude_code.token.usage' AND extra['type'] = 'output', toFloat64(800 + ui * 150),
        metric = 'claude_code.token.usage' AND extra['type'] = 'cacheRead', toFloat64(3000 + ui * 500),
        metric = 'claude_code.lines_of_code.count', toFloat64(60 + ui * 20 + di * 5),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'accept', toFloat64(12 + ui * 2),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'reject', toFloat64(2 + ui % 2),
        metric = 'claude_code.cost.usage', 0.4 + ui * 0.1,
        0.0
    ),
    1, true
FROM (SELECT arrayJoin(range(3)) AS ui) u
CROSS JOIN (SELECT arrayJoin(range(4)) AS di) d
CROSS JOIN (
    SELECT 'claude_code.session.count' AS metric, map() AS extra
    UNION ALL SELECT 'claude_code.commit.count', map()
    UNION ALL SELECT 'claude_code.pull_request.count', map()
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'input')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'output')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'cacheRead')
    UNION ALL SELECT 'claude_code.lines_of_code.count', map()
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'accept')
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'reject')
    UNION ALL SELECT 'claude_code.cost.usage', map('skill.name', 'code-review')
) m;

-- ── enterprise: 동일 지표, model/organization.id만 다름 ────────────────────
INSERT INTO claude_code.otel_metrics_sum
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
SELECT
    map('user.email', ['alice@example.com', 'bob@example.com', 'carol@example.com'][ui + 1],
        'team', 'fsi', 'organization.id', 'org-abc123'),
    'claude-code',
    metric,
    mapUpdate(map('model', 'claude-sonnet-4-5-20250929'), extra),
    now() - INTERVAL di DAY,
    now() - INTERVAL di DAY,
    multiIf(
        metric = 'claude_code.session.count', toFloat64(1 + ui % 2),
        metric = 'claude_code.commit.count', toFloat64(1 + ui + di % 2),
        metric = 'claude_code.pull_request.count', toFloat64((di + 1) % 2),
        metric = 'claude_code.token.usage' AND extra['type'] = 'input', toFloat64(1200 + ui * 250 + di * 80),
        metric = 'claude_code.token.usage' AND extra['type'] = 'output', toFloat64(700 + ui * 120),
        metric = 'claude_code.token.usage' AND extra['type'] = 'cacheRead', toFloat64(2200 + ui * 400),
        metric = 'claude_code.lines_of_code.count', toFloat64(90 + ui * 30 + di * 8),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'accept', toFloat64(15 + ui * 3),
        metric = 'claude_code.code_edit_tool.decision' AND extra['decision'] = 'reject', toFloat64(1 + ui % 2),
        metric = 'claude_code.cost.usage', 0.3 + ui * 0.08,
        0.0
    ),
    1, true
FROM (SELECT arrayJoin(range(3)) AS ui) u
CROSS JOIN (SELECT arrayJoin(range(4)) AS di) d
CROSS JOIN (
    SELECT 'claude_code.session.count' AS metric, map() AS extra
    UNION ALL SELECT 'claude_code.commit.count', map()
    UNION ALL SELECT 'claude_code.pull_request.count', map()
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'input')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'output')
    UNION ALL SELECT 'claude_code.token.usage', map('type', 'cacheRead')
    UNION ALL SELECT 'claude_code.lines_of_code.count', map()
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'accept')
    UNION ALL SELECT 'claude_code.code_edit_tool.decision', map('decision', 'reject')
    UNION ALL SELECT 'claude_code.cost.usage', map('skill.name', 'brainstorming')
) m;

-- ── 활성 사용시간 (gauge) ───────────────────────────────────────────────
INSERT INTO claude_code.otel_metrics_gauge
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value)
SELECT
    map('user.email', ['111111111111@ws', '222222222222@ws', '333333333333@ws'][ui + 1]),
    'claude-code', 'claude_code.active_time.total', map('model', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'),
    now() - INTERVAL di DAY, now() - INTERVAL di DAY, toFloat64(1800 + ui * 600 + di * 100)
FROM (SELECT arrayJoin(range(3)) AS ui) u CROSS JOIN (SELECT arrayJoin(range(4)) AS di) d;

INSERT INTO claude_code.otel_metrics_gauge
(ResourceAttributes, ScopeName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value)
SELECT
    map('user.email', ['alice@example.com', 'bob@example.com', 'carol@example.com'][ui + 1]),
    'claude-code', 'claude_code.active_time.total', map('model', 'claude-sonnet-4-5-20250929'),
    now() - INTERVAL di DAY, now() - INTERVAL di DAY, toFloat64(1500 + ui * 500 + di * 90)
FROM (SELECT arrayJoin(range(3)) AS ui) u CROSS JOIN (SELECT arrayJoin(range(4)) AS di) d;

-- ── tool/MCP 사용 로그 ──────────────────────────────────────────────────
INSERT INTO claude_code.otel_logs
(Timestamp, TraceId, SpanId, SeverityText, SeverityNumber, ServiceName, Body, ResourceAttributes, LogAttributes)
SELECT now() - INTERVAL di DAY, '', '', 'INFO', 9, 'claude-code', '', map('user.email', email),
       map('event.name', 'claude_code.tool_result', 'tool_name', tool, 'mcp_server_name', mcp, 'success', succ)
FROM (SELECT arrayJoin(range(4)) AS di) d
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
       map('event.name', 'claude_code.user_prompt')
FROM (SELECT arrayJoin(range(4)) AS di) d
CROSS JOIN (
    SELECT '111111111111@ws' AS email UNION ALL SELECT '111111111111@ws'
    UNION ALL SELECT '222222222222@ws' UNION ALL SELECT 'alice@example.com'
    UNION ALL SELECT 'bob@example.com' UNION ALL SELECT 'carol@example.com'
) r;
