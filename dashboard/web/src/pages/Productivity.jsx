import { Badge } from "../components/Badge.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { GroupAreaChart, GroupBarChart, DualLineChart, SeriesBarChart } from "../components/GroupCharts.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";

const fmtTick = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const fmt = (n) => Number(n || 0).toLocaleString();
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };

export default function Productivity() {
  const kpi = useApi("/api/overview/kpi");
  const norm = useApi("/api/productivity/normalized");
  const decisions = useApi("/api/productivity/decisions");
  const active = useApi("/api/productivity/active-time");
  const agentic = useApi("/api/productivity/agenticness");
  const engagement = useApi("/api/productivity/engagement");
  const locTrend = useApi("/api/productivity/loc-timeseries");
  const decisionsByTool = useApi("/api/productivity/decisions-by-tool");

  const activeHours = active.data?.map((r) => ({ ...r, active_seconds: r.active_seconds / 3600 }));

  const outcomeTotals = (kpi.data || []).reduce(
    (acc, r) => ({ prs: acc.prs + Number(r.prs), loc: acc.loc + Number(r.lines_of_code) }),
    { prs: 0, loc: 0 }
  );
  const decisionTotals = (decisions.data || []).reduce(
    (acc, r) => ({ accept: acc.accept + (r.decision === "accept" ? Number(r.n) : 0), total: acc.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = decisionTotals.total > 0 ? decisionTotals.accept / decisionTotals.total : 0;

  return (
    <div>
      <PageHeader
        title="Productivity"
        subtitle="비용(cost.usage)은 근사치라 A/B 비교에 쓰지 않는다 — 토큰 정규화 지표로 대체"
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {kpi.loading || decisions.loading ? (
          <Loading />
        ) : kpi.error || decisions.error ? (
          <ErrorBox error={kpi.error || decisions.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label="생성된 PR" value={fmt(outcomeTotals.prs)} variant="accent" />
            <StatTile label="작성된 라인 수" value={fmt(outcomeTotals.loc)} />
            <StatTile label="제안 수락률" value={`${(acceptRate * 100).toFixed(0)}%`} />
            <StatTile
              label="수락된 라인 수"
              value={fmt(Math.round(outcomeTotals.loc * acceptRate))}
              hint="추정치: 작성 라인 × 수락률"
            />
          </div>
        )}

        {engagement.loading ? (
          <Loading />
        ) : engagement.error ? (
          <ErrorBox error={engagement.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DualLineChart
              title="도입률"
              subtitle="사용자 수 vs 세션 수"
              rows={engagement.data}
              xKey="t"
              tickFormatter={fmtTick}
              lines={[
                { key: "users", label: "사용자", axis: "left" },
                { key: "sessions", label: "세션", axis: "right" },
              ]}
            />
            <DualLineChart
              title="사용자당 PR"
              subtitle="사용자 수 vs 사용자당 PR 수"
              rows={engagement.data}
              xKey="t"
              tickFormatter={fmtTick}
              lines={[
                { key: "users", label: "사용자", axis: "left" },
                { key: "prs_per_user", label: "사용자당 PR", axis: "right" },
              ]}
            />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title="추가 라인 / 백만 토큰" rows={norm.data} valueKey="loc_per_million_tokens" />
          )}
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title="커밋 / 백만 토큰" rows={norm.data} valueKey="commits_per_million_tokens" />
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title="추가된 라인 (일별)" rows={locTrend.data} xKey="t" valueKey="loc_added" tickFormatter={fmtTick} />
          )}
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title="제거된 라인 (일별)" rows={locTrend.data} xKey="t" valueKey="loc_removed" tickFormatter={fmtTick} />
          )}
        </div>

        {decisionsByTool.loading ? (
          <Loading />
        ) : decisionsByTool.error ? (
          <ErrorBox error={decisionsByTool.error} />
        ) : (
          <SeriesBarChart
            title="툴 별 수락/거부"
            subtitle="edit / multi_edit / write / notebook_edit — 그룹 합산"
            rows={decisionsByTool.data}
            xKey="tool"
            seriesKey="decision"
            valueKey="n"
          />
        )}

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
