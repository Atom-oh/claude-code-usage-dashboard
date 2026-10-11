// userLeaderboard의 유저×그룹 행을 유저 단위로 접고 생산성 점수를 재계산한다 — Executive의
// 조직 종합 점수와 Productivity의 사용자별 테이블이 같은 폴드를 써야 두 화면의 점수가 어긋나지
// 않는다. 두 그룹을 오간 유저(straddler)의 그룹별 productivity_score를 그냥 평균 내면 안 된다:
// 점수 공식(서버 productivity.js)이 항별 상한(Math.min(x/cap,1))으로 캡되고 수락률도 decision
// 수로 가중되는 비선형 공식이라 "그룹별 점수 평균" ≠ "유저 전체 raw 지표 합산 후 재계산"이다
// (리뷰에서 MAJOR로 확인). 상수/가중치는 서버 productivity.js와 반드시 동기.
const LOC_PER_DAY_CAP = 300;
const COMMITS_PER_DAY_CAP = 3;
const SESSIONS_PER_DAY_CAP = 4;

export const APPROVAL_HELP = "코드 편집 권한 결정 중 허용된 비율입니다. 자동 허용을 포함하며, 사람이 코드를 검토하거나 품질을 인정한 비율이 아닙니다.";
export const ACTIVITY_SCORE_HELP = "추가 코드 라인 30%, 권한 허용률 25%, 커밋 20%, 활성일 비율 15%, 세션 10%를 합산한 활동 지수입니다. 하루 코드 300라인·커밋 3회·세션 4회에서 각 항목을 상한 처리하며, 1일 미만 구간도 1일 기준으로 계산합니다. 권한 결정이 없으면 지수는 미확인이며, 평균은 모든 대상 사용자에게 지수가 있을 때만 제공합니다. 가중치와 상한은 임의 기준으로, 검증된 생산성·코드 품질·개인 역량 점수가 아닙니다. 권한 허용에는 자동 허용도 포함됩니다.";

export const formatActivityScore = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(1);
export function averageActivityScore(rows) {
  if (!rows?.length || rows.some((row) => row.productivity_score == null
    || !Number.isFinite(Number(row.productivity_score)))) return null;
  return rows.reduce((sum, row) => sum + Number(row.productivity_score), 0) / rows.length;
}

// scoreDays는 서버 공식과 같은 하한 1일(Math.max(1, ...))을 쓴 값이어야 한다 — sub-day 드래그
// 줌 구간(예: 10분)의 1/1440일 하한을 그대로 넘기면 per-day 항들이 최대 1440배 부풀어 사실상
// 만점이 된다(리뷰에서 MAJOR로 확인). 호출부: Math.max(1, (to - from) / 86400000).
export function foldLeaderboardByUser(rows, scoreDays) {
  const byUser = new Map();
  for (const r of rows || []) {
    const prev = byUser.get(r.user) || { user: r.user, loc: 0, commits: 0, prs: 0, sessions: 0, accepted: 0, decisions: 0, active_days: 0 };
    byUser.set(r.user, {
      ...prev,
      loc: prev.loc + Number(r.loc),
      commits: prev.commits + Number(r.commits),
      prs: prev.prs + Number(r.prs || 0),
      sessions: prev.sessions + Number(r.sessions),
      accepted: prev.accepted + Number(r.accepted),
      decisions: prev.decisions + Number(r.decisions),
      // active_days는 그룹별 값(r.active_days)을 합산하지 않는다 — 같은 날 두 그룹 모두 활동한
      // straddler는 그 날이 이중 계상된다. userLeaderboard가 유저 단위 distinct 활성일을
      // user_active_days로 따로 내려주므로 그 값을 그대로 쓴다(그룹 행마다 동일한 값).
      active_days: Number(r.user_active_days),
    });
  }
  return [...byUser.values()].map((u) => {
    const acceptRate = u.decisions > 0 ? u.accepted / u.decisions : null;
    const score = acceptRate === null ? null :
      100 *
      (0.3 * Math.min(u.loc / scoreDays / LOC_PER_DAY_CAP, 1) +
        0.25 * acceptRate +
        0.2 * Math.min(u.commits / scoreDays / COMMITS_PER_DAY_CAP, 1) +
        0.15 * Math.min(u.active_days / scoreDays, 1) +
        0.1 * Math.min(u.sessions / scoreDays / SESSIONS_PER_DAY_CAP, 1));
    return { ...u, accept_rate: acceptRate, productivity_score: score };
  });
}
