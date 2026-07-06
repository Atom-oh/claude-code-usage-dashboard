import { DataTable } from "../components/DataTable.jsx";
import { DonutBreakdown, SeriesBarChart } from "../components/GroupCharts.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";

const fmtTick = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function Cost() {
  const summary = useApi("/api/cost/summary");
  const byModel = useApi("/api/cost/by-model");
  const byModelDaily = useApi("/api/cost/by-model-daily");

  const totals = (summary.data || []).reduce(
    (acc, r) => ({
      cost: acc.cost + Number(r.total_cost),
      input: acc.input + Number(r.input_tokens),
      output: acc.output + Number(r.output_tokens),
      sessions: acc.sessions + Number(r.sessions),
    }),
    { cost: 0, input: 0, output: 0, sessions: 0 }
  );

  const modelTotals = new Map();
  for (const r of byModel.data || []) {
    const prev = modelTotals.get(r.model) || { model: r.model, cost: 0, tokens: 0 };
    prev.cost += Number(r.cost);
    prev.tokens += Number(r.tokens);
    modelTotals.set(r.model, prev);
  }
  const modelRows = [...modelTotals.values()].sort((a, b) => b.cost - a.cost);
  const totalModelCost = modelRows.reduce((s, r) => s + r.cost, 0);

  return (
    <div>
      <PageHeader
        title="Cost"
        subtitle="근사치 — A/B 그룹 간 실비용 비교에는 쓰지 않는다(Productivity 페이지의 토큰 정규화 지표가 그 역할). 여기선 얼마나 쓰는지 참고용."
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {summary.loading ? (
          <Loading />
        ) : summary.error ? (
          <ErrorBox error={summary.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label="근사 지출 (합계)" value={usd(totals.cost)} variant="accent" hint={`${summary.data.length}개 그룹`} />
            <StatTile label="입력 토큰" value={fmt(totals.input)} />
            <StatTile label="출력 토큰" value={fmt(totals.output)} />
            <StatTile label="세션" value={fmt(totals.sessions)} />
          </div>
        )}

        {byModel.loading ? (
          <Loading />
        ) : byModel.error ? (
          <ErrorBox error={byModel.error} />
        ) : (
          <DonutBreakdown title="모델별 지출 비중" data={modelRows} nameKey="model" valueKey="cost" valuePrefix="$" />
        )}

        {byModelDaily.loading ? (
          <Loading />
        ) : byModelDaily.error ? (
          <ErrorBox error={byModelDaily.error} />
        ) : (
          <SeriesBarChart title="일간 모델별 지출" rows={byModelDaily.data} xKey="day" seriesKey="model" valueKey="cost" tickFormatter={fmtTick} valuePrefix="$" />
        )}

        <DataTable
          title="모델 · 지출 & 토큰"
          subtitle="지출 기준 정렬"
          columns={[
            { key: "model", label: "모델" },
            { key: "cost", label: "지출", render: usd },
            { key: "share", label: "비중", render: (_v, r) => `${totalModelCost > 0 ? ((r.cost / totalModelCost) * 100).toFixed(1) : 0}%` },
            { key: "tokens", label: "토큰", render: fmt },
          ]}
          rows={modelRows}
          groupKey="__none__"
        />
      </div>
    </div>
  );
}
