// Cost 페이지 "$/LOC, $/커밋 효율" 테이블 — 이미 있는 두 쿼리(userLeaderboard의 loc(added만)/commits,
// costByUserModel의 모델별 계산비용)를 새 SQL 없이 유저×그룹 단위로 합치기만 하면 된다. 둘 다
// group이 세션 단위 실제 값(다수결 아님)이라 user만으로 조인하면 두 그룹을 오간 유저의 전체
// 비용이 양쪽 그룹 행에 중복으로 붙는다 — 조인 키를 user+group으로 넓혀야 한다.
export function userCostEfficiency(leaderboardRows, costByUserModelRows) {
  const key = (user, group) => `${user}|${group}`;
  const costByUserGroup = new Map();
  const unpricedUserGroups = new Set();
  const reportedByUserGroup = new Map();
  const reportedUnpricedGroups = new Set();
  for (const r of costByUserModelRows) {
    const k = key(r.user, r.group);
    const raw = r.reported_cost;
    const reported = Number(raw);
    const valid = (typeof raw === "number" || (typeof raw === "string" && raw.trim() !== ""))
      && Number.isFinite(reported) && reported >= 0;
    const hasTokens = ["tokens", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
      .some((field) => Number(r[field]) > 0);
    if (!valid || (reported === 0 && hasTokens)) reportedUnpricedGroups.add(k);
    reportedByUserGroup.set(k, (reportedByUserGroup.get(k) || 0) + (valid ? reported : 0));
    // 미산정 모델을 쓴 유저는 cost가 실제보다 낮게(또는 0으로) 잡혀 "가장 효율적"으로 잘못
    // 보일 수 있다 — 계산비용에서 제외하는 것과 별개로 unpriced 플래그를 남겨 UI에서 구분한다.
    if (r.cost == null) {
      unpricedUserGroups.add(k);
      continue;
    }
    costByUserGroup.set(k, (costByUserGroup.get(k) || 0) + Number(r.cost));
  }
  return leaderboardRows.map((u) => {
    const k = key(u.user, u.group);
    const unpriced = unpricedUserGroups.has(k);
    const cost = costByUserGroup.get(k) || 0;
    const reported_cost = reportedByUserGroup.get(k) ?? 0;
    const reported_unpriced = !reportedByUserGroup.has(k) || reportedUnpricedGroups.has(k) || !Number.isFinite(reported_cost);
    const loc = Number(u.loc); // userLeaderboard가 이미 TokenType='added'로 필터한 값
    const commits = Number(u.commits);
    return {
      user: u.user,
      group: u.group,
      cost,
      unpriced,
      reported_cost,
      reported_unpriced,
      loc,
      commits,
      cost_per_loc: !reported_unpriced && loc > 0 ? reported_cost / loc : null,
      cost_per_commit: !reported_unpriced && commits > 0 ? reported_cost / commits : null,
    };
  });
}
