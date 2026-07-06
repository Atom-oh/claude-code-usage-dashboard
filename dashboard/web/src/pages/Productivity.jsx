import { Badge } from "../components/Badge.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { GroupAreaChart, GroupBarChart } from "../components/GroupCharts.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { useApi } from "../useApi.js";

const fmtTick = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };

export default function Productivity() {
  const norm = useApi("/api/productivity/normalized");
  const decisions = useApi("/api/productivity/decisions");
  const active = useApi("/api/productivity/active-time");
  const agentic = useApi("/api/productivity/agenticness");

  const activeHours = active.data?.map((r) => ({ ...r, active_seconds: r.active_seconds / 3600 }));

  return (
    <div>
      <PageHeader
        title="Productivity"
        subtitle="비용(cost.usage)은 근사치라 A/B 비교에 쓰지 않는다 — 토큰 정규화 지표로 대체"
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title="추가 라인 / 백만 토큰" rows={norm.data} valueKey="loc_per_million_tokens" />
          )}
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title="커밋 / 백만 토큰" rows={norm.data} valueKey="commits_per_million_tokens" />
          )}
        </div>

        {decisions.loading ? (
          <Loading />
        ) : decisions.error ? (
          <ErrorBox error={decisions.error} />
        ) : (
          <GroupBarChart
            title="코드 편집 수락/거부"
            subtitle="그룹별"
            right={
              <div className="flex gap-2">
                <Badge tone="positive" dot>accept</Badge>
                <Badge tone="negative" dot>reject</Badge>
              </div>
            }
            rows={decisions.data}
            xKey="group"
            valueKey="n"
            colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"}
          />
        )}

        {active.loading ? <Loading /> : active.error ? <ErrorBox error={active.error} /> : (
          <GroupAreaChart title="활성 사용 시간" subtitle="시간, 그룹별 시계열" rows={activeHours} xKey="t" valueKey="active_seconds" tickFormatter={fmtTick} />
        )}

        {agentic.loading ? (
          <Loading />
        ) : agentic.error ? (
          <ErrorBox error={agentic.error} />
        ) : (
          <GroupAreaChart
            title="에이전틱함"
            subtitle="프롬프트 1개당 평균 툴 호출 수 — 높을수록 더 많이 위임하는 것 (user_prompt 이벤트 실측 필요)"
            rows={agentic.data}
            xKey="t"
            valueKey="tool_calls_per_prompt"
            tickFormatter={fmtTick}
          />
        )}
      </div>
    </div>
  );
}
