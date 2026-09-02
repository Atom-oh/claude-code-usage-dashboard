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
# 두 가지 모드:
#   - 워터마크 모드(기본, RANGE_TO 미설정): rollup에 이미 있는 가장 오래된 hour(워터마크 W)를
#     자동으로 찾아 "hour < W" 구간만 원본에서 재집계해 라이브 rollup 테이블에 INSERT — MV가
#     이미 커버한 [W, 지금) 구간은 건드리지 않아 중복 카운트가 없다. rollup이 비어 있으면
#     (첫 설치 직후 등) 아무것도 하지 않고 종료한다(할 일 없음, 신규 설치와 동일 상태).
#   - range 모드(RANGE_TO 설정 시): [RANGE_FROM, RANGE_TO) 구간을 $TARGET_TABLE로 재집계.
#     clickhouse-migration-003.sql §4(그림자 테이블 _v2로 과거 구간 채우기)와 §6(EXCHANGE
#     이후 라이브 이름으로 갭 채우기)가 이 모드를 사용한다. RANGE_FROM을 비워두면 원본
#     테이블의 min(TimeUnix)부터 시작한다.
#
# 재실행 안전성: 두 모드 모두 MV가 이미 쓴 구간과 겹치지 않는 것을 전제로 한다. 겹쳐 다시
# 실행해도 max_value/has_org는 max 병합이라 멱등하고, sum_value는 실측(2026-09-02 prod)상 존재하는
# 단 2개의 delta 행에서만 두 배가 된다(AggregationTemporality=1인 행은 rollup 전체에서 2건
# 뿐이라 사실상 미사용).
#
# 주의: MV가 아직 첫 insert를 쓰기 전에 워터마크 모드를 돌리면 rollup이 비어 있어 워터마크를
# 못 찾고 조용히 no-op 종료한다 — 그러면 과거 데이터가 영구히 채워지지 않는다(리뷰에서
# 지적됨). 텔레메트리가 초 단위로 유입되면 실무상 이 창은 매우 짧지만, MV 생성 직후 바로
# 이 스크립트를 실행하지 말고 최소 몇 분 기다려 rollup에 최소 1행이 쓰인 뒤 실행할 것.
#
# day-chunked 집계: 57일치를 한 번의 GROUP BY로 묻으면 3.73 GiB reader 메모리 제한을 실측
# OOM으로 넘겼다 — hour 버킷은 day 경계를 절대 넘지 않으므로(toStartOfHour는 하루 안에서만
# 움직인다) 하루 단위 GROUP BY로 쪼개도 근사가 아니라 정확히 같은 결과가 나온다.
#
# clickhouse-migration-003.sql §4/§6이 range 모드를 구동하는 절차와, 롤업 재구축 전체
# 절차는 docs/runbooks/rollup-rebuild-segment-key.md를 참고할 것.
#
# 사용법:
#   워터마크 모드: CH_HOST=<host> CH_PASSWORD=<pw> ./scripts/backfill-hourly-rollup.sh
#   range 모드:    TARGET_TABLE=claude_code.otel_metrics_sum_hourly_v2 \
#                    RANGE_TO='2026-09-02 00:00:00' CH_HOST=<host> CH_PASSWORD=<pw> \
#                    ./scripts/backfill-hourly-rollup.sh
# =============================================================================

CH_HOST="${CH_HOST:?CH_HOST env var required (e.g. clickhouse-cc-ab-replicated)}"
CH_PORT="${CH_PORT:-9000}"
CH_USER="${CH_USER:-otel_writer}"
CH_PASSWORD="${CH_PASSWORD:?CH_PASSWORD env var required}"
TARGET_TABLE="${TARGET_TABLE:-claude_code.otel_metrics_sum_hourly}"
RANGE_FROM="${RANGE_FROM:-}"
RANGE_TO="${RANGE_TO:-}"

# --password를 argv로 넘기면 다른 사용자가 ps/프로세스 목록으로 비밀번호를 볼 수 있다
# (리뷰에서 MINOR로 확인) — 임시 클라이언트 설정 파일에 비밀번호를 넣고 --config-file로
# 전달한다. 파일은 스크립트 종료 시(정상/에러 무관) 항상 삭제한다.
CH_CONF=$(mktemp)
trap 'rm -f "$CH_CONF"' EXIT
printf '<config><password>%s</password></config>\n' "$CH_PASSWORD" > "$CH_CONF"

# --port: 9000은 네이티브 프로토콜 포트이자 clickhouse-client 자체의 기본값이라 평소엔
# 이 옵션이 no-op이다 — kubectl port-forward svc/clickhouse-cc-ab 9000:9000을 거칠 때만
# 값이 달라질 수 있어서 존재한다.
ch() {
  clickhouse-client --host "$CH_HOST" --port "$CH_PORT" --user "$CH_USER" \
    --config-file "$CH_CONF" --query "$1"
}

if [ -n "$RANGE_TO" ]; then
  # range 모드: 원본 테이블이 비어 있으면 집계할 게 없다.
  RAW_ROW_COUNT=$(ch "SELECT count() FROM claude_code.otel_metrics_sum")
  if [ "$RAW_ROW_COUNT" = "0" ]; then
    echo "otel_metrics_sum(원본)이 비어 있음 — 백필할 게 없음."
    exit 0
  fi

  if [ -z "$RANGE_FROM" ]; then
    # toDateTime()으로 먼저 내린 뒤 문자열화한다 — TimeUnix는 DateTime64(9)라
    # toString(min(TimeUnix))가 '2026-07-07 00:00:00.000000000'을 주고, 그 문자열은
    # toDateTime()이 파싱하지 못한다(실측 2026-09-02: Code 6 CANNOT_PARSE_TEXT,
    # position 19). set -e라 그대로 두면 아래 START 계산에서 스크립트가 죽는다.
    RANGE_FROM=$(ch "SELECT toString(toDateTime(min(TimeUnix))) FROM claude_code.otel_metrics_sum")
  fi

  echo "range 모드: [$RANGE_FROM, $RANGE_TO) 구간을 $TARGET_TABLE 로 백필합니다..."
else
  # ClickHouse의 min(DateTime)은 빈 테이블에서 빈 문자열이 아니라 기본값 '1970-01-01 00:00:00'을
  # 반환한다(실측 확인) — 예전엔 이를 몰라 `[ -z "$WATERMARK" ]`로 empty를 판정했는데, 이 조건이
  # 절대 걸리지 않아 MV가 첫 insert를 쓰기도 전에 스크립트를 돌리면 WHERE TimeUnix < '1970-...'로
  # 아무것도 INSERT하지 않고도 "백필 완료"를 출력해 운영자가 필수 백필을 완료했다고 오인하게 만드는
  # CRITICAL이었다(리뷰에서 확인). count()로 명확하게 empty를 판정한다.
  ROW_COUNT=$(ch "SELECT count() FROM claude_code.otel_metrics_sum_hourly")

  if [ "$ROW_COUNT" = "0" ]; then
    echo "otel_metrics_sum_hourly가 비어 있음 — 백필할 게 없음(신규 설치와 동일 상태)."
    echo "주의: MV가 아직 한 번도 insert를 쓰지 않았다면(생성 직후) 이건 아직 데이터 없음이지"
    echo "백필 불필요가 아니다 — 몇 분 뒤 rollup에 최소 1행이 쓰인 걸 확인하고 재실행할 것."
    exit 0
  fi

  WATERMARK=$(ch "SELECT toString(min(hour)) FROM claude_code.otel_metrics_sum_hourly")
  # range 모드와 같은 이유로 toDateTime()을 먼저 씌운다(위 주석 참고 — DateTime64(9)의
  # 문자열은 toDateTime()이 파싱하지 못한다). min(hour)는 DateTime이라 그럴 필요가 없다.
  RANGE_FROM=$(ch "SELECT toString(toDateTime(min(TimeUnix))) FROM claude_code.otel_metrics_sum")
  RANGE_TO="$WATERMARK"

  echo "워터마크(rollup에 이미 있는 가장 오래된 hour): $WATERMARK"
  echo "그보다 이전 구간(원본 otel_metrics_sum)을 재집계해 백필합니다..."
fi

# day-chunk 경계는 date -u가 아니라 ClickHouse 자신으로 계산한다 — date -u는 입력 파싱에서
# TZ를 무시하고 덮어써 이 저장소에서 실제로 틀린 fixture를 만든 적이 있다. 같은 엔진이
# 리터럴을 해석할 엔진이기도 하므로 이 방식은 그런 종류의 불일치를 원천적으로 없앤다.
# parseDateTimeBestEffort: 운영자가 RANGE_FROM에 소수점 초가 붙은 값을 붙여넣어도
# 죽지 않게 한다(toDateTime은 '...00:00:00.000000000'을 거부한다 — 위 주석의 실측).
START=$(ch "SELECT toString(toStartOfDay(parseDateTimeBestEffort('$RANGE_FROM')))")
END="$RANGE_TO"

D="$START"
while [ "$(ch "SELECT toDateTime('$D') < toDateTime('$END')")" = "1" ]; do
  NEXT=$(ch "SELECT toString(least(toDateTime('$D') + INTERVAL 1 DAY, toDateTime('$END')))")
  echo "  [$D, $NEXT) 집계 중..."

  # 컬럼 목록을 명시한다 — 2026-08-11 migration-002가 StartType/AppVersion을 ADD COLUMN AFTER
  # ToolName으로 끼워 넣어 롤업이 16열이 됐고, 예전의 14열 positional INSERT는 실측(2026-09-02
  # prod 스키마 대조)상 현재 테이블에 그대로 실패한다.
  #
  # SeriesKey는 컬럼을 읽지 않고 매번 직접 계산한다 — clickhouse-migration-003.sql의
  # MATERIALIZED 정의(CANON, 여기서 문자 그대로 복사)와 동일한 식이며, 이렇게 하면 라이브
  # 클러스터의 MATERIALIZE COLUMN 뮤테이션이 끝났는지와 무관하게 백필이 항상 올바른 값을
  # 쓴다 — 두 값이 실제로 일치한다는 것은 migration-003의 검증 쿼리 (b)가 증명한다(실측:
  # mismatch 0). GROUP BY의 SeriesKey는 이 SELECT의 별칭을 가리키므로, 식은 한 statement당
  # 한 번만 쓴다.
  ch "
INSERT INTO $TARGET_TABLE
    (hour, MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
     Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion,
     max_value, sum_value, has_org)
SELECT
    toStartOfHour(toDateTime(TimeUnix)) AS hour,
    MetricName, SessionId,
    if(MetricName = 'claude_code.session.count',
       cityHash64(toString(Attributes)),
       cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix))) AS SeriesKey,
    UserEmail, AggregationTemporality,
    Model, TokenType, Decision, SkillName,
    Attributes['tool_name'] AS ToolName,
    Attributes['start_type'] AS StartType,
    ResourceAttributes['service.version'] AS AppVersion,
    max(Value) AS max_value,
    sum(Value) AS sum_value,
    max(Attributes['organization.id'] != '') AS has_org
FROM claude_code.otel_metrics_sum
WHERE TimeUnix >= toDateTime64('$D', 9) AND TimeUnix < toDateTime64('$NEXT', 9)
GROUP BY hour, MetricName, SessionId, SeriesKey, UserEmail, AggregationTemporality,
         Model, TokenType, Decision, SkillName, ToolName, StartType, AppVersion
"
  D="$NEXT"
done

echo "백필 완료. 검증:"
ch "SELECT min(hour), max(hour), count() FROM $TARGET_TABLE"
