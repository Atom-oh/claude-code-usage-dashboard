// 서버가 내려주는 t 값은 ClickHouse DateTime을 그대로 문자열화한 "YYYY-MM-DD HH:MM:SS"
// (또는 toDate 계열은 "YYYY-MM-DD") — 타임존 표기가 없다. new Date(그 문자열)로 바로 파싱하면
// 브라우저가 "로컬 타임"으로 해석하는데, ClickHouse 값은 UTC 기준이라 non-UTC 브라우저에서
// 드래그 줌 경계(GroupCharts.jsx parseUtc가 이미 이 함수를 씀)뿐 아니라 틱 라벨/툴팁 표시
// 시각도 tz offset만큼 어긋난다(리뷰에서 MAJOR로 확인 — 표시만 밀리고 실제 쿼리 경계는
// parseUtc 덕에 정확했지만, 그 정확한 경계와 화면에 찍히는 라벨이 서로 다른 시각을
// 가리키는 게 더 혼란스럽다). "Z"를 붙여 명시적으로 UTC로 파싱한다.
export function parseUtc(label) {
  const s = String(label);
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : `${s.replace(" ", "T")}Z`);
}

// 버킷 크기에 맞춰 라벨 세밀도를 바꾼다 — 안 그러면 같은 값이 반복 표시돼 구분이 안 된다.
// 분 버킷(<1h, 드래그 줌)일 땐 분까지, 시간 버킷(<24h)일 땐 시각까지, 일/주 버킷일 땐 날짜만.
export const makeTickFmt = (intervalHours) => (t) =>
  intervalHours < 1
    ? parseUtc(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : intervalHours < 24
      ? parseUtc(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric" })
      : parseUtc(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
