// 생산성 점수 — whchoi98/claude-code-dashboard 공식을 차용:
//   100 × (0.30×LOC/day + 0.25×수락률 + 0.20×commits/day + 0.15×활성일비율 + 0.10×sessions/day)
// 각 /day 항목은 절대 상한으로 정규화(1.0 cap). 상한값은 실측 데이터가 없어 임의로 잡은 값이라
// 실제 분포를 본 뒤 조정 대상이다.
// ponytail: global 상수, 계정별/조직별로 다르게 하려면 여기 4개 값만 바꾸면 됨.
const LOC_PER_DAY_CAP = 300;
const COMMITS_PER_DAY_CAP = 3;
const SESSIONS_PER_DAY_CAP = 4;

export function withProductivityScore(rows, from, to) {
  const daysInRange = Math.max(1, (to - from) / 86400000);
  return rows.map((r) => {
    const locPerDay = Number(r.loc) / daysInRange;
    const commitsPerDay = Number(r.commits) / daysInRange;
    const sessionsPerDay = Number(r.sessions) / daysInRange;
    const acceptRate = r.decisions > 0 ? Number(r.accepted) / Number(r.decisions) : 0;
    const activeDayShare = Math.min(Number(r.active_days) / daysInRange, 1);

    const score =
      100 *
      (0.3 * Math.min(locPerDay / LOC_PER_DAY_CAP, 1) +
        0.25 * acceptRate +
        0.2 * Math.min(commitsPerDay / COMMITS_PER_DAY_CAP, 1) +
        0.15 * activeDayShare +
        0.1 * Math.min(sessionsPerDay / SESSIONS_PER_DAY_CAP, 1));

    return { ...r, accept_rate: Number(acceptRate.toFixed(3)), productivity_score: Number(score.toFixed(1)) };
  });
}
