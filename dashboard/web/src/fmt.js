// 시간 버킷(<24h)일 때는 시각까지, 일/주 버킷일 때는 날짜만 표시 — 안 그러면 시간별 데이터가
// 와도 x축 라벨이 전부 같은 "M/D"로 찍혀 구분이 안 된다.
export const makeTickFmt = (intervalHours) => (t) =>
  intervalHours < 24
    ? new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric" })
    : new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
