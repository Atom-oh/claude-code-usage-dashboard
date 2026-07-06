import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { GroupBarChart, GroupLineChart } from "../components/GroupCharts.jsx";
import { useApi } from "../useApi.js";

const fmtTick = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const STATUS_COLOR = { accept: "var(--status-good)", reject: "var(--status-critical)" };

export default function Productivity() {
  const norm = useApi("/api/productivity/normalized");
  const decisions = useApi("/api/productivity/decisions");
  const active = useApi("/api/productivity/active-time");

  // active_seconds → hours, 사람이 읽기 쉬운 단위로.
  const activeHours = active.data?.map((r) => ({ ...r, active_seconds: r.active_seconds / 3600 }));

  return (
    <div className="grid gap-4">
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        비용(cost.usage)은 근사치라 A/B 비교에 쓰지 않는다 — 토큰 정규화 지표로 대체.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="추가 라인 / 백만 토큰">
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart rows={norm.data} valueKey="loc_per_million_tokens" />
          )}
        </Card>
        <Card title="커밋 / 백만 토큰">
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart rows={norm.data} valueKey="commits_per_million_tokens" />
          )}
        </Card>
      </div>

      <Card title="코드 편집 수락/거부 (그룹별)">
        <div className="mb-2 flex gap-4 text-xs" style={{ color: "var(--text-secondary)" }}>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--status-good)" }} />
            accept
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--status-critical)" }} />
            reject
          </span>
        </div>
        {decisions.loading ? (
          <Loading />
        ) : decisions.error ? (
          <ErrorBox error={decisions.error} />
        ) : (
          <GroupBarChart
            rows={decisions.data}
            xKey="group"
            valueKey="n"
            colorFn={(r) => STATUS_COLOR[r.decision] || "var(--text-muted)"}
          />
        )}
      </Card>

      <Card title="활성 사용 시간 (시간, 그룹별 시계열)">
        {active.loading ? <Loading /> : active.error ? <ErrorBox error={active.error} /> : (
          <GroupLineChart rows={activeHours} xKey="t" valueKey="active_seconds" tickFormatter={fmtTick} />
        )}
      </Card>
    </div>
  );
}
