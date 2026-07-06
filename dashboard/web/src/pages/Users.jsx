import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { SimpleTable } from "../components/SimpleTable.jsx";
import { useApi } from "../useApi.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (n) => `${(Number(n) * 100).toFixed(0)}%`;

export default function Users() {
  const leaderboard = useApi("/api/users/leaderboard");

  return (
    <div className="grid gap-4">
      <Card title="유저별 생산성 리더보드">
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          점수 = 100 × (0.30×LOC/day + 0.25×수락률 + 0.20×commits/day + 0.15×활성일비율 + 0.10×sessions/day),
          각 /day 항목은 절대 상한(캡)으로 정규화 — 캡 값은 초기 추정치이며 실측 후 조정 대상.
        </p>
        {leaderboard.loading ? (
          <Loading />
        ) : leaderboard.error ? (
          <ErrorBox error={leaderboard.error} />
        ) : (
          <SimpleTable
            columns={[
              { key: "group", label: "그룹" },
              { key: "user", label: "유저" },
              { key: "productivity_score", label: "생산성 점수", render: (v) => v.toFixed(1) },
              { key: "sessions", label: "세션", render: fmt },
              { key: "tokens", label: "토큰", render: fmt },
              { key: "loc", label: "추가 라인", render: fmt },
              { key: "commits", label: "커밋", render: fmt },
              { key: "accept_rate", label: "수락률", render: pct },
              { key: "active_days", label: "활성일", render: fmt },
            ]}
            rows={leaderboard.data}
          />
        )}
      </Card>
    </div>
  );
}
