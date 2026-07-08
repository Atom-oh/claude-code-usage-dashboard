// DAU/WAU/MAU 시계열 롤업 — SQL에서 날짜별로 30개의 uniqExactIf를 반복하는 대신, "일자×유저 존재"
// 원자료만 ClickHouse에서 가져오고(queries.js dailyActiveUsers) 롤링 윈도우 집계는 여기서 한다.
// adoptionLevels(스냅샷)의 시계열 버전.
function toDay(d) {
  return d.toISOString().slice(0, 10);
}

// rows: [{day: 'YYYY-MM-DD', UserEmail}] — from-29d 이전부터 to까지 조회된 것이어야 wau/mau가 맞다.
export function rollupActiveUsers(rows, from, to) {
  const usersByDay = new Map(); // 'YYYY-MM-DD' -> Set<email>
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    if (!usersByDay.has(day)) usersByDay.set(day, new Set());
    usersByDay.get(day).add(r.UserEmail);
  }

  // from을 그날 자정으로 내리면(floor) from이 정오 같은 중간 시각일 때 첫 point가 요청 range
  // 이전(자정~from) 활동까지 끌어온다. 다른 시계열 차트(incBucketed의 WHERE t >= from)와 같은
  // 절단 규칙을 쓰려면 from 이후의 첫 자정부터 시작해야 한다(from이 이미 자정이면 그대로).
  const DAY = 86400000;
  const days = [];
  for (let t = Math.ceil(from.getTime() / DAY) * DAY; t < to.getTime(); t += DAY) {
    days.push(toDay(new Date(t)));
  }

  const unionSince = (day, windowDays) => {
    const end = new Date(`${day}T00:00:00Z`);
    const start = new Date(end.getTime() - windowDays * 86400000);
    const set = new Set();
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const s = usersByDay.get(toDay(d));
      if (s) for (const email of s) set.add(email);
    }
    return set.size;
  };

  return days.map((day) => ({
    t: day,
    dau: usersByDay.get(day)?.size || 0,
    wau: unionSince(day, 6),
    mau: unionSince(day, 29),
  }));
}
