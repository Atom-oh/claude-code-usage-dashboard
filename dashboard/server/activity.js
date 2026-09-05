// DAU/WAU/MAU + 고착도 롤업 — /api/adoption/timeseries의 실제 집계다. SQL에서 날짜별로 30개의
// uniqExactIf를 반복하는 대신 "일자 × 유저 집합" 원자료만 ClickHouse에서 가져오고(queries.js의
// adoptionTimeseries) 롤링 윈도우는 여기서 접는다 — 유저 수가 수백 명 수준이라 집합 union이
// 싸고 SQL 셀프조인보다 단순하다.
//
// 창 정의: 당일 포함 trailing 30일(mau) / 당일 포함 trailing 7일(wau). union(N)이 i=0..N-1로
// 당일부터 거꾸로 세므로 N이 곧 일수다. 고착도 = dau/mau*100 소수 1자리, mau가 0이면 0.
// 날짜 키는 toISOString()(UTC)로 고정 — queries.js가 toDate(..., 'UTC')로 뽑으므로 서버 TZ가
// UTC가 아니어도 하루 어긋나지 않는다.
//
// from이 자정이 아니면(예: RangeContext의 "지금 - N일") Math.ceil로 다음 자정부터 시작해 그
// 부분 day를 통째로 버린다 — 요청 range 이전(자정~from) 활동이 첫 point에 섞이지 않게 하는
// 의도된 트레이드오프이고, range가 짧을수록 눈에 띈다.
export function rollupAdoption(rows, from, to) {
  const byDay = new Map(rows.map((r) => [r.d, r.users]));
  const DAY = 86400000;
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const out = [];
  for (let t = Math.ceil(from.getTime() / DAY) * DAY; t < to.getTime(); t += DAY) {
    const union = (days) => {
      const s = new Set();
      for (let i = 0; i < days; i++) for (const u of byDay.get(dayKey(t - i * DAY)) || []) s.add(u);
      return s.size;
    };
    const dau = union(1), mau = union(30);
    out.push({ t: dayKey(t), dau, wau: union(7), mau, stickiness: mau > 0 ? Number(((dau / mau) * 100).toFixed(1)) : 0 });
  }
  return out;
}
