// Cost 페이지 "$/LOC, $/커밋 효율" 테이블 — 이미 있는 두 쿼리(userLeaderboard의 loc/commits,
// costByUserModel의 모델별 계산비용)를 새 SQL 없이 유저 단위로 합치기만 하면 된다.
export function userCostEfficiency(leaderboardRows, costByUserModelRows) {
  const costByUser = new Map();
  for (const r of costByUserModelRows) {
    if (r.cost == null) continue; // 미산정 모델은 그 유저의 계산비용에서 제외(withComputedCost 정책과 동일)
    costByUser.set(r.user, (costByUser.get(r.user) || 0) + Number(r.cost));
  }
  return leaderboardRows.map((u) => {
    const cost = costByUser.get(u.user) || 0;
    const loc = Number(u.loc);
    const commits = Number(u.commits);
    return {
      user: u.user,
      group: u.group,
      cost,
      loc,
      commits,
      cost_per_loc: loc > 0 ? cost / loc : null,
      cost_per_commit: commits > 0 ? cost / commits : null,
    };
  });
}
