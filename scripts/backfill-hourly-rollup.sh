#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# otel_metrics_sum_hourly 백필 (기존 클러스터 전용 — 신규 설치는 필요 없음)
#
# 배경: otel_metrics_sum_hourly_mv는 생성된 "이후"의 insert만 TO 테이블에 반영한다.
# 기존 클러스터에 이 MV를 새로 붙이면, MV 생성 이전에 쌓인 원본 데이터는 rollup에 없다 —
# 대시보드가 rollup만 읽으므로(queries.js incFlat/incBucketed/GROUP_CTE) 배포 직후 과거
# 구간이 조용히 비거나 부분적으로만 보인다(PR #9 리뷰에서 CRITICAL로 확인). 이 스크립트가
# 그 공백을 멱등하게 채운다.
#
# 동작: rollup에 이미 있는 가장 오래된 hour(워터마크 W)를 자동으로 찾아
#       "hour < W" 구간만 원본에서 재집계해 INSERT — MV가 이미 커버한 [W, 지금) 구간은
#       건드리지 않아 중복 카운트가 없다. rollup이 비어 있으면(첫 설치 직후 등) 아무것도
#       하지 않고 종료한다(할 일 없음, 신규 설치와 동일 상태).
#
# 재실행 안전성: W 이전 파티션에만 INSERT하므로 실패 후 재실행해도 sum_value가 중복되지
# 않는다(같은 W 이전 구간을 다시 계산해 다시 넣을 뿐 — 단, 두 번째 실행 사이에 MV가 그
# 구간에 새로 쓴 적이 없어야 한다. 이 스크립트는 MV 생성 이후 실행 전제이므로 안전).
#
# 사용법: CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
# =============================================================================

CH_HOST="${CH_HOST:?CH_HOST env var required (e.g. clickhouse-cc-ab-replicated)}"
CH_USER="${CH_USER:-otel_writer}"
CH_PASSWORD="${CH_PASSWORD:?CH_PASSWORD env var required}"

ch() {
  clickhouse-client --host "$CH_HOST" --user "$CH_USER" --password "$CH_PASSWORD" --query "$1"
}

WATERMARK=$(ch "SELECT toString(min(hour)) FROM claude_code.otel_metrics_sum_hourly")

if [ -z "$WATERMARK" ]; then
  echo "otel_metrics_sum_hourly가 비어 있음 — 백필할 게 없음(신규 설치와 동일 상태). 종료."
  exit 0
fi

echo "워터마크(rollup에 이미 있는 가장 오래된 hour): $WATERMARK"
echo "그보다 이전 구간(원본 otel_metrics_sum)을 재집계해 백필합니다..."

ch "
INSERT INTO claude_code.otel_metrics_sum_hourly
SELECT
    toStartOfHour(toDateTime(TimeUnix)) AS hour,
    MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
    Model, TokenType, Decision, SkillName,
    Attributes['tool_name'] AS ToolName,
    max(Value) AS max_value,
    sum(Value) AS sum_value,
    max(Attributes['organization.id'] != '') AS has_org
FROM claude_code.otel_metrics_sum
WHERE toDateTime(TimeUnix) < toDateTime('$WATERMARK')
GROUP BY hour, MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
         Model, TokenType, Decision, SkillName, ToolName
"

echo "백필 완료. 검증:"
ch "SELECT min(hour), max(hour), count() FROM claude_code.otel_metrics_sum_hourly"
