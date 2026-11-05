import { useMemo } from "react";
import { Badge } from "./Badge.jsx";
import { Card, ErrorBox, Loading } from "./Card.jsx";
import { DataTable } from "./DataTable.jsx";
import { SeriesBarChart } from "./GroupCharts.jsx";
import { ModelCostTrend } from "./ModelCostTrend.jsx";
import { SegmentedControl } from "./SegmentedControl.jsx";
import { StatTile } from "./StatTile.jsx";
import { useApi } from "../useApi.js";
import { fromByModelDaily } from "../modelCostTrend.js";
import { SPEND_HELP } from "../spend.js";

// /api/cost/by-team(-daily): Claude reported spend per session team. A total metric: the
// unknown channel is included, so team rows plus 팀 없음 equal the 총 비용 tile.
export const NO_TEAM = "팀 없음";
const isNoTeam = (row) => row.team === null;
const BASIS = "Claude 보고 비용 · 총 비용과 같은 기준(미분류 채널 포함) · 세션별 팀 귀속";
const HELP = `${SPEND_HELP} 각 세션의 비용은 그 세션이 보낸 OTel team 값에 붙습니다. ${NO_TEAM}은 team 값을 보내지 않았거나 로그 보존 기간이 지나 팀을 확인할 수 없는 세션입니다. 세션은 기간 안에 사용 기록이 있는 세션 수라 상단 세션 타일과 다를 수 있습니다.`;

const usd = (n) => n == null || !Number.isFinite(Number(n)) ? "확인 필요"
  : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const num = (n) => Number(n || 0).toLocaleString();
const pct = (v) => v === null ? "" : `${v.toFixed(1)}%`;

// Rows keep the server order (known teams by spend, 팀 없음 last) and gain a display share of
// the known total; an all-unknown team has no share.
export function teamTableRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.reduce((s, r) => s + (r.known_reported_cost ?? 0), 0);
  return list.map((r) => ({ ...r, label: r.team ?? NO_TEAM, cost: r.known_reported_cost,
    cost_partial: r.reported_partial === true,
    share: r.known_reported_cost === null || total <= 0 ? null : (r.known_reported_cost / total) * 100 }));
}

export const TEAM_COLUMNS = [
  { key: "label", label: "팀", toText: (v) => v },
  { key: "cost", label: "비용", render: (v, r) => r.cost_partial
    ? <span className="inline-flex items-center gap-1.5">{usd(v)}<Badge tone="warning">부분합</Badge></span> : usd(v),
    toText: (v) => v ?? "" },
  { key: "share", label: "전체 대비", render: (v) => v === null ? "확인 필요" : pct(v), toText: pct },
  { key: "tokens", label: "토큰", render: num },
  { key: "requests", label: "요청", render: num },
  { key: "users", label: "활성 사용자", render: num },
  { key: "sessions", label: "세션", render: num },
];

export function TeamCostView({ table, trend, intervalHours, onIntervalHours }) {
  const rows = useMemo(() => teamTableRows(table.data), [table.data]);
  const cells = useMemo(() => fromByModelDaily(trend.data, { dimension: "team" }), [trend.data]);
  const known = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
  const teamed = rows.filter((r) => r.team !== null).reduce((s, r) => s + (r.cost ?? 0), 0);
  const activeTeams = rows.filter((r) => r.team !== null).length;
  return (
    <section className="flex flex-col gap-4" aria-label="팀별 비용">
      <h2 className="text-base font-semibold text-ink-800">팀별 비용</h2>
      {table.loading ? <Loading /> : table.error ? <ErrorBox error={table.error} /> : <>
        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile label="활성 팀" value={num(activeTeams)} help={`비용 기록이 있는 팀 수 · ${NO_TEAM} 제외`} />
          <StatTile label="팀이 확인된 비용 비중" value={known > 0 ? pct((teamed / known) * 100) : "—"}
            help={`알려진 보고 비용 중 팀이 확인된 몫 · 확인 필요 팀의 비용은 분자·분모에서 제외`} />
        </div>
        {/* Known spend only: an all-unknown team has no bar (its table cell reads 확인 필요). */}
        <SeriesBarChart title="팀별 비용 분포" subtitle={`기간 합계 · ${BASIS}`} help={HELP}
          rows={rows.filter((r) => r.cost !== null).map((r) => ({ team: r.label, part: "보고 비용", value: r.cost }))}
          xKey="team" seriesKey="part" valueKey="value" valuePrefix="$" horizontal />
        <DataTable title="팀별 비용과 사용량" subtitle={BASIS} help={HELP} columns={TEAM_COLUMNS} rows={rows}
          groupKey={null} exportName="team-cost" stale={table.stale || trend.stale} pinLast={isNoTeam} />
      </>}
      {trend.loading ? <Loading /> : trend.error ? <ErrorBox error={trend.error} /> : (
        <ModelCostTrend title="팀별 비용 추이" subtitle={`상위 8개 팀 · ${BASIS}`} cells={cells} help={HELP} top={8}
          basis="Claude 보고 비용" xKey="t" dimension="team" bucketHours={intervalHours} zoomDisabled={trend.stale}
          right={onIntervalHours ? <SegmentedControl options={[{ value: "1", label: "시간별" },
            { value: "24", label: "일간" }, { value: "168", label: "주간" }]} value={String(intervalHours)}
            onChange={(v) => onIntervalHours(Number(v))} /> : undefined} />
      )}
    </section>
  );
}

// intervalHours is the Cost page's bucket, shared with "모델별 비용 추이".
export function TeamCostSection({ intervalHours }) {
  const table = useApi("/api/cost/by-team");
  const trend = useApi("/api/cost/by-team-daily", { intervalHours });
  return <TeamCostView table={table} trend={trend} intervalHours={intervalHours} />;
}
