import { query } from "./clickhouse.js";

// SeriesKey가 세그먼트 인식 정의(clickhouse-migration-003.sql / ADR-003)로 바뀌었는지를
// 런타임에 감지한다. 마이그레이션 적용 여부를 코드가 가정하지 않게 하려는 것 — 미적용
// 클러스터에서도 대시보드가 동작해야 한다.
//
// 대상은 claude_code.cost.usage다. session.count는 설계상 키 정의가 바뀌지 않으므로
// (프로세스당 1이라 세그먼트 키를 쓰면 resume마다 새 세션이 된다 — ADR-003의 예외)
// 어떤 클러스터에서도 legacy 쪽에만 매칭돼 판별에 쓸 수 없다.
//
// system.* 테이블을 읽지 않는다 — otel_reader에는 system.mutations/system.columns 권한이
// 없다(실측 2026-09-02). MATERIALIZED 컬럼은 INSERT 시점에 계산되므로 "가장 최근 행"이
// 곧 현재 정의이고, MODIFY COLUMN이 실행된 직후부터 신규 행이 새 키를 갖는다(실측 확인).
const PROBE_SQL = `
SELECT
    countIf(SeriesKey = cityHash64(toString(Attributes), toUnixTimestamp64Nano(StartTimeUnix))) AS seg,
    countIf(SeriesKey = cityHash64(toString(Attributes))) AS legacy
FROM (
    SELECT SeriesKey, Attributes, StartTimeUnix
    FROM claude_code.otel_metrics_sum
    WHERE MetricName = 'claude_code.cost.usage'
      AND TimeUnix >= now() - INTERVAL 24 HOUR
    ORDER BY TimeUnix DESC
    LIMIT 2000
)`;

// seg만 잡히면 적용됨(true), legacy만 잡히면 미적용(false), 섞여 있거나(MATERIALIZE COLUMN
// 진행 중) 행이 없으면 판단 보류(null) — null은 fail-safe로 경고 문구를 유지시킨다.
//
// Number() 강제 변환이 이 함수의 핵심이다: @clickhouse/client는 JSONEachRow에서 UInt64를
// 문자열로 준다(실측 2026-09-02: {"seg":"0","legacy":"7"}, typeof === "string"). 그래서
// `legacy === 0` 같은 엄격 비교는 legacy가 실제로 0일 때조차 절대 참이 되지 않고, 이 함수는
// 영구히 null만 반환해 기능이 조용히 죽는다. 이 파일에서 유일하게 실측으로만 알 수 있는 지점.
export function classifySeriesKeyProbe({ seg, legacy }) {
  const s = Number(seg);
  const l = Number(legacy);
  if (!Number.isFinite(s) || !Number.isFinite(l)) return null;
  if (s > 0 && l === 0) return true;
  if (l > 0 && s === 0) return false;
  return null;
}

// 부팅/주기 실행 모두 비치명적 — 어떤 에러(권한, 네트워크, 스키마)든 null로 접는다.
export async function probeSegmentAwareSeriesKey() {
  try {
    const rows = await query(PROBE_SQL);
    if (!rows || rows.length === 0) return null;
    return classifySeriesKeyProbe(rows[0]);
  } catch {
    return null;
  }
}

// 어느 마이그레이션이 적용됐는지는 이제 클러스터가 직접 기록한다
// (clickhouse-migration-004.sql의 claude_code.schema_migrations). system.columns를 뒤지지
// 않아도 되고, 원장 테이블은 claude_code.* 안이라 otel_reader의 GRANT SELECT로 읽힌다.
const MIGRATIONS_SQL = `SELECT version FROM claude_code.schema_migrations ORDER BY version`;

// 순수 함수 — 드라이버가 준 행 배열을 정렬된 유일 버전 배열로 접는다.
// version은 UInt16이라 @clickhouse/client가 JSON 숫자로 준다(실측 2026-09-03:
// {"version":2}, typeof === "number"). 문자열도 받아들이는 건 방어적 조치다 — 같은 파일의
// classifySeriesKeyProbe의 Number() 강제 변환과 달리 실측된 동작을 고치는 게 아니다
// (그쪽은 count() 집계라 UInt64이고, 실제로 문자열로 온다).
// 배열이 아니면(undefined/null/에러) null — "확인되지 않음"과 "빈 목록"은 다른 상태다.
export function classifyMigrations(rows) {
  if (!Array.isArray(rows)) return null;
  const versions = rows
    .map((r) => Number(r?.version))
    .filter((v) => Number.isFinite(v));
  return [...new Set(versions)].sort((a, b) => a - b);
}

// 부팅/주기 실행 모두 비치명적 — 어떤 에러든 null로 접는다. 004 이전 클러스터에서는
// 원장 테이블이 없어 UNKNOWN_TABLE(code 60)이 오는데, 그것도 "확인되지 않음"이다.
export async function probeMigrations() {
  try {
    return classifyMigrations(await query(MIGRATIONS_SQL));
  } catch {
    return null;
  }
}

// 005 컬럼(ProjectName/Entrypoint, clickhouse-migration-005.sql)이 적용된 클러스터인지
// 감지한다. 위 두 프로브와 같은 이유로 system.columns를 읽지 않는다 — otel_reader에 그 권한이
// 없다. LIMIT 0이라 데이터는 읽지 않고 컬럼 해석만 시킨다: 쿼리가 성공하면 컬럼이 있다는
// 뜻이고, 행이 0개인 것은 판정과 무관하다(segmentAwareSeriesKey 프로브와 달리 "행이 없으면
// 보류"가 아니다 — 여기서는 성공 자체가 증거다).
const PROJECT_COLUMNS_SQL = `SELECT ProjectName, Entrypoint FROM claude_code.otel_logs LIMIT 0`;

// 에러를 세 상태로 가른다. 실측(2026-09-09, @clickhouse/client + clickhouse-server 24.8.14.39):
//   - 컬럼 없음: ClickHouseError, code = '47'(문자열), type = 'UNKNOWN_IDENTIFIER'
//   - 접속 불가: 평범한 Error, code = 'ECONNREFUSED', type = undefined
// 즉 code가 전부 숫자면 "서버가 SQL을 이해하고 거절했다"(= 컬럼이 없다 → false)이고, 숫자가
// 아니면 전송 계층 실패(= 확인하지 못했다 → null)다. type이 아니라 code로 판정하는 이유는
// 드라이버가 type을 채우지 않게 바뀌어도 규칙이 남아 있어야 해서다.
// 권한 에러(ACCESS_DENIED)도 숫자 코드라 false로 접히는데, 소비자(라우트 게이팅, 필터 무시,
// 입력창 숨김)는 false와 null을 똑같이 "true 아님"으로 다루므로 동작 차이가 없다 — 운영자에게
// 보이는 값만 달라진다.
export function classifyProjectColumnsProbe(err) {
  if (!err) return true;
  const code = err.code === undefined || err.code === null ? "" : String(err.code);
  return /^\d+$/.test(code) ? false : null;
}

// 부팅/주기 실행 모두 비치명적 — 같은 파일의 다른 프로브들과 동일 규약.
export async function probeProjectColumns() {
  try {
    await query(PROJECT_COLUMNS_SQL);
    return classifyProjectColumnsProbe(null);
  } catch (err) {
    return classifyProjectColumnsProbe(err);
  }
}
