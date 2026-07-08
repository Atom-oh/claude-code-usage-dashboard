import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { DualLineChart } from "../components/GroupCharts.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";

const fmtDate = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });

export default function Trends() {
  const ts = useApi("/api/adoption/timeseries");
  const levels = useApi("/api/adoption/levels");
  // DAU/WAU/MAU는 session.count에 Model attribute가 없어 model 필터가 안 걸린다 —
  // Cost/Productivity 페이지는 필터되는데 이 페이지만 전체-모델 기준이라는 침묵 불일치를 배지로 알린다.
  const { model } = useFilters();

  const last = (ts.data || [])[ts.data?.length - 1];
  const prev = (ts.data || [])[ts.data?.length - 2];
  const dauTrend = last && prev && prev.dau > 0 ? ((last.dau - prev.dau) / prev.dau) * 100 : null;

  return (
    <div>
      <PageHeader
        title="Trends"
        subtitle={
          model
            ? "일간/주간/월간 활성 유저 추이 — WAU/MAU는 각 시점 기준 롤링 7일/30일. ⚠ model 필터는 이 페이지에 적용되지 않습니다(전체 모델 기준)."
            : "일간/주간/월간 활성 유저 추이 — WAU/MAU는 각 시점 기준 롤링 7일/30일"
        }
        live
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {levels.loading ? (
          <Loading />
        ) : levels.error ? (
          <ErrorBox error={levels.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="DAU"
              value={last?.dau ?? levels.data.dau}
              variant="accent"
              trend={dauTrend !== null ? `${dauTrend >= 0 ? "↑" : "↓"} ${Math.abs(dauTrend).toFixed(0)}%` : undefined}
              hint="전일 대비"
            />
            <StatTile label="WAU" value={last?.wau ?? levels.data.wau} hint="롤링 7일" />
            <StatTile label="MAU" value={last?.mau ?? levels.data.mau} hint="롤링 30일" />
            <StatTile label="DAU/MAU 고착도" value={last ? `${last.stickiness}%` : "—"} hint="일간 ÷ 월간 활성" />
          </div>
        )}

        {ts.loading ? (
          <Loading />
        ) : ts.error ? (
          <ErrorBox error={ts.error} />
        ) : (
          <>
            <DualLineChart
              title="활성 유저 (DAU · WAU · MAU)"
              rows={ts.data}
              xKey="t"
              height={300}
              tickFormatter={fmtDate}
              lines={[
                { key: "dau", label: "DAU", axis: "left" },
                { key: "wau", label: "WAU", axis: "left" },
                { key: "mau", label: "MAU", axis: "left" },
              ]}
            />
            <DualLineChart
              title="DAU/MAU 고착도"
              subtitle="% — 높을수록 매일 돌아오는 유저 비중이 큼"
              rows={ts.data}
              xKey="t"
              tickFormatter={fmtDate}
              lines={[{ key: "stickiness", label: "고착도 %", axis: "left" }]}
            />
          </>
        )}
      </div>
    </div>
  );
}
