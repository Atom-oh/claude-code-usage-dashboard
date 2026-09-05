import { query } from "./clickhouse.js";

// 텔레메트리 유입이 멈췄는지를 런타임에 감지한다. README "Telemetry Ingestion"에 기록된 실제
// 장애(collector가 일시적 DNS 타임아웃으로 죽어 ~43시간 공백이 아무 에러 없이 지나감)를 앱
// 안에서 보이게 하는 게 목적 — 그 동안 대시보드 자체는 계속 정상이었고, 데이터 창만 조용히
// 줄어들었다.
//
// 시간별 롤업(otel_metrics_sum_hourly)이 아니라 원본 otel_metrics_sum을 읽는다: 롤업은 최대
// 한 시간 늦게 채워지므로, 30초 주기로 export하는 collector가 죽은 걸 분 단위로 잡아낼 수
// 없다. 신선도 판정에서 한 시간의 눈먼 구간은 이 기능의 존재 이유를 없앤다.
//
// toUnixTimestamp64Milli로 감싸는 이유: DateTime64(9)를 문자열로 받으면 타임존 해석과 나노초
// 표기 파싱이 끼어든다. 7 DAY 상한은 파티션 프루닝용이다(PARTITION BY toYYYYMM(TimeUnix)).
// 행이 없으면 max()가 epoch 0을 주고 classifyFreshness의 unknown 경로가 처리한다
// (실측 2026-09-02: 빈 창의 반환값은 문자열 "0").
const PROBE_SQL = `
SELECT toUnixTimestamp64Milli(max(TimeUnix)) AS latest_ms
FROM claude_code.otel_metrics_sum
WHERE TimeUnix > now() - INTERVAL 7 DAY`;

const MINUTE_MS = 60_000;
const DEFAULT_STALE_AFTER_MINUTES = 360;

// PROBE_SQL 의 7 DAY 창보다 큰 임계는 판정 불가다: 최신 행이 7일보다 오래되면 창이 비어 unknown 이 되므로
// "8일 전 행, 임계 14일 → ok" 같은 설정은 영구 503 + 오알림이 된다(리뷰 지적 2026-09-05). 그래서 상한도 거부한다.
const PROBE_WINDOW_MINUTES = 7 * 24 * 60;

// 잘못된 DATA_STALE_MINUTES는 조용히 기본값으로 접지 않고 부팅을 실패시킨다 — pricing.js의
// PRICING_CACHE_WRITE_TTL과 같은 정책. 접어버리면 운영자가 임계를 바꿨다고 믿는 채로 옛
// 임계가 계속 돌고, 그걸 알아챌 방법이 없다.
function parseStaleAfterMinutes(raw) {
  if (raw === undefined || raw === "") return DEFAULT_STALE_AFTER_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= PROBE_WINDOW_MINUTES) {
    throw new Error(
      `DATA_STALE_MINUTES must be a positive number of minutes below ${PROBE_WINDOW_MINUTES} (the 7-day probe window), got "${raw}"`
    );
  }
  return n;
}

export const staleAfterMinutes = parseStaleAfterMinutes(process.env.DATA_STALE_MINUTES);

// Number() 강제 변환이 이 함수의 핵심이다: @clickhouse/client는 JSONEachRow에서 Int64를
// 문자열로 준다(실측 2026-09-02: {"latest_ms":"1788356183000"}, typeof === "string"; 빈 창은
// "0"). 그래서 `latestMs === 0` 같은 엄격 비교는 실제로 0일 때조차 절대 참이 되지 않고,
// nowMs - latestMs는 문자열 연산으로 새어 나이 계산이 조용히 깨진다. 변환을 프로브가 아니라
// 이 순수 함수에 두는 이유: 프로브 구현이 바뀌어도 계약이 남아야 하고, 단위 테스트가 실제
// 드라이버 값(문자열)로 이 지점을 고정할 수 있어야 한다.
//
// 음수 나이(서버/클러스터 시계 스큐)는 0으로 클램프하고 ok로 본다 — 미래 타임스탬프는 신선도
// 문제가 아니다.
export function classifyFreshness({ latestMs, nowMs, staleAfterMinutes }) {
  const ms = Number(latestMs);
  const now = Number(nowMs);
  if (!Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now)) {
    return { status: "unknown", latest: null, ageMinutes: null, staleAfterMinutes };
  }
  const ageMs = Math.max(0, now - ms);
  const ageMinutes = Math.floor(ageMs / MINUTE_MS);
  return {
    // ms 단위로 비교한다 — 분으로 내림한 뒤 비교하면 임계를 넘긴 뒤 최대 1분 가까이 ok 로 남는다(리뷰 지적 2026-09-05).
    // ageMinutes 는 표시용이다.
    status: ageMs > staleAfterMinutes * MINUTE_MS ? "stale" : "ok",
    latest: new Date(ms).toISOString(),
    ageMinutes,
    staleAfterMinutes,
  };
}

// 부팅/주기 실행 모두 비치명적 — 어떤 에러(권한, 네트워크, 스키마)든 null로 접는다.
// null은 classifyFreshness에서 unknown이 되고, unknown은 stale과 같은 503으로 나간다
// (index.js): 측정할 수 없을 때 조용해지면 이 기능이 막으려는 장애를 그대로 재현한다.
export async function probeLatestTelemetryMs() {
  try {
    const rows = await query(PROBE_SQL);
    if (!rows || rows.length === 0) return null;
    const raw = rows[0].latest_ms;
    return raw === undefined || raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}
