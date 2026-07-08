// Cost 페이지 "$/LOC, $/커밋 효율" 테이블 — 이미 있는 두 쿼리(userLeaderboard의 loc_added/commits,
// costByUserModel의 모델별 계산비용)를 새 SQL 없이 유저 단위로 합치기만 하면 된다.
export function userCostEfficiency(leaderboardRows, costByUserModelRows) {
  const costByUser = new Map();
  const unpricedUsers = new Set();
  for (const r of costByUserModelRows) {
    // 미산정 모델을 쓴 유저는 cost가 실제보다 낮게(또는 0으로) 잡혀 "가장 효율적"으로 잘못
    // 보일 수 있다 — 계산비용에서 제외하는 것과 별개로 unpriced 플래그를 남겨 UI에서 구분한다.
    if (r.cost == null) {
      unpricedUsers.add(r.user);
      continue;
    }
    costByUser.set(r.user, (costByUser.get(r.user) || 0) + Number(r.cost));
  }
  return leaderboardRows.map((u) => {
    const unpriced = unpricedUsers.has(u.user);
    const cost = costByUser.get(u.user) || 0;
    const loc = Number(u.loc_added); // added만 — removed까지 합치면 $/LOC가 실제보다 낮게 나온다
    const commits = Number(u.commits);
    return {
      user: u.user,
      group: u.group,
      cost,
      unpriced,
      loc,
      commits,
      cost_per_loc: !unpriced && loc > 0 ? cost / loc : null,
      cost_per_commit: !unpriced && commits > 0 ? cost / commits : null,
    };
  });
}
