import { Badge } from "../components/Badge.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { GroupAreaChart, GroupBarChart, DualLineChart, SeriesBarChart, HBarList } from "../components/GroupCharts.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { makeTickFmt } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (n) => `${(Number(n) * 100).toFixed(0)}%`;
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };

export default function Productivity() {
  const { intervalHours } = useRange();
  const fmtTick = makeTickFmt(intervalHours);
  const kpi = useApi("/api/overview/kpi");
  const norm = useApi("/api/productivity/normalized");
  const decisions = useApi("/api/productivity/decisions");
  const decisionsByTool = useApi("/api/productivity/decisions-by-tool");
  const active = useApi("/api/productivity/active-time");
  const agentic = useApi("/api/productivity/agenticness");
  const engagement = useApi("/api/productivity/engagement");
  const locTrend = useApi("/api/productivity/loc-timeseries");
  const leaderboard = useApi("/api/users/leaderboard");

  const activeHours = active.data?.map((r) => ({ ...r, active_seconds: r.active_seconds / 3600 }));

  // decisionsByTool은 group×tool×decision 원본이라 xKey="tool" 막대차트에 그대로 넣으면 전역 그룹
  // 필터가 꺼진 상태(양 그룹 모두)에서 같은 tool/decision 막대가 그룹별로 중복 렌더된다 →
  // "도구별 총량"으로 오독된다. tool+decision으로 합산해 넘긴다(필터가 켜져 한 그룹뿐이면 no-op).
  const decisionsByToolAgg = Object.values(
    (decisionsByTool.data || []).reduce((acc, r) => {
      const k = `${r.tool}|${r.decision}`;
      (acc[k] ||= { tool: r.tool, decision: r.decision, n: 0 }).n += Number(r.n);
      return acc;
    }, {})
  );

  const outcomeTotals = (kpi.data || []).reduce(
    (acc, r) => ({ prs: acc.prs + Number(r.prs), loc: acc.loc + Number(r.lines_of_code) }),
    { prs: 0, loc: 0 }
  );
  const decisionTotals = (decisions.data || []).reduce(
    (acc, r) => ({ accept: acc.accept + (r.decision === "accept" ? Number(r.n) : 0), total: acc.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = decisionTotals.total > 0 ? decisionTotals.accept / decisionTotals.total : 0;

  // leaderboard는 유저×그룹 행(userLeaderboard)이라 그대로 슬라이스하면 두 그룹을 오간
  // 유저(straddler)가 같은 이름으로 중복 노출되고 어느 그룹 점수인지 안 보인다 — 라벨에
  // 그룹을 붙여 구분한다(Users 페이지처럼 그룹별로 아예 나누는 대신, 여기는 조직 전체
  // Top 10 하나로 유지 — 아래 표에 이미 그룹 컬럼이 있는 상세 뷰가 따로 있다).
  const top10ByScore = [...(leaderboard.data || [])]
    .sort((a, b) => Number(b.productivity_score) - Number(a.productivity_score))
    .slice(0, 10)
    .map((r) => ({ ...r, label: `${r.user} (${r.group})` }));

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

        {leaderboard.loading ? (
          <Loading />
        ) : leaderboard.error ? (
          <ErrorBox error={leaderboard.error} />
        ) : (
          <HBarList
            title="사용자별 생산성 — Top 10"
            subtitle="점수 = 100 × (0.30×LOC/day + 0.25×수락률 + 0.20×commits/day + 0.15×활성일비율 + 0.10×sessions/day) — 유저×그룹별 행(두 그룹을 오간 유저는 그룹당 1행)"
            data={top10ByScore.map((r) => ({ ...r, score: Number(r.productivity_score) }))}
            labelKey="label"
            valueKey="score"
          />
        )}

        {leaderboard.loading ? null : leaderboard.error ? null : (
          <DataTable
            title="사용자별 생산성"
            subtitle="Users 페이지 리더보드와 동일 지표 — 상세 히트맵/일별 추이는 Users 페이지에서"
            columns={[
              { key: "group", label: "그룹" },
              { key: "user", label: "유저" },
              { key: "productivity_score", label: "생산성 점수", render: (v) => Number(v).toFixed(1) },
              { key: "loc", label: "추가 라인", render: fmt },
              { key: "commits", label: "커밋", render: fmt },
              { key: "prs", label: "PR", render: fmt },
              { key: "accept_rate", label: "수락률", render: pct },
              { key: "sessions", label: "세션", render: fmt },
              { key: "active_days", label: "활성일", render: fmt },
            ]}
            rows={leaderboard.data || []}
          />
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

        <div className="grid gap-4 md:grid-cols-2">
          {decisionsByTool.loading ? (
            <Loading />
          ) : decisionsByTool.error ? (
            <ErrorBox error={decisionsByTool.error} />
          ) : (
            <GroupBarChart
              title="도구별 수락/거부"
              subtitle="실측: Edit / Write (multi_edit·notebook_edit은 위 값 미확인)"
              right={
                <div className="flex gap-2">
                  <Badge tone="positive" dot>accept</Badge>
                  <Badge tone="negative" dot>reject</Badge>
                </div>
              }
              rows={decisionsByToolAgg}
              xKey="tool"
              valueKey="n"
              colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"}
            />
          )}
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
        </div>

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
