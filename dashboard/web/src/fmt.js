// 버킷 크기에 맞춰 라벨 세밀도를 바꾼다 — 안 그러면 같은 값이 반복 표시돼 구분이 안 된다.
// 분 버킷(<1h, 드래그 줌)일 땐 분까지, 시간 버킷(<24h)일 땐 시각까지, 일/주 버킷일 땐 날짜만.
export const makeTickFmt = (intervalHours) => (t) =>
  intervalHours < 1
    ? new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : intervalHours < 24
      ? new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric" })
      : new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
