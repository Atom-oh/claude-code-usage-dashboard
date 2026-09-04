import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { DualLineChart } from "../components/GroupCharts.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";
import { parseUtc } from "../fmt.js";

const fmtDate = (t) => parseUtc(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });

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
            ? "일간·주간·월간 활성 사용자 추이 · 모델 필터 미적용"
            : "일간·주간·월간 활성 사용자 추이"
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
              spark={(ts.data || []).map((r) => r.dau)}
            />
            <StatTile label="WAU" value={last?.wau ?? levels.data.wau} hint="최근 7일" spark={(ts.data || []).map((r) => r.wau)} />
            <StatTile label="MAU" value={last?.mau ?? levels.data.mau} hint="최근 30일" spark={(ts.data || []).map((r) => r.mau)} />
            <StatTile label="DAU/MAU 고착도" value={last ? `${last.stickiness}%` : "—"} hint="일간 활성 ÷ 월간 활성" spark={(ts.data || []).map((r) => r.stickiness)} />
          </div>
        )}

        {ts.loading ? (
          <Loading />
        ) : ts.error ? (
          <ErrorBox error={ts.error} />
        ) : (
          <>
            {/* adoption/timeseries는 항상 일 단위(24h) 버킷 — 전역 intervalHours(1~24h)와
                무관하므로 드래그 줌 우측 보정에 실제 버킷 크기를 명시해야 한다(리뷰에서 MAJOR로
                확인: 안 넘기면 전역이 시간 단위일 때 우측 끝 날짜의 대부분이 잘려나간다). */}
            <DualLineChart
              title="활성 사용자 (DAU · WAU · MAU)"
              help={
                model
                  ? "주간·월간 활성 사용자는 각 날짜 기준 최근 7일과 30일 안에 세션이 있었던 사용자입니다. 이 페이지의 지표는 모델 필터와 무관하게 전체 모델 기준입니다."
                  : "주간·월간 활성 사용자는 각 날짜 기준 최근 7일과 30일 안에 세션이 있었던 사용자입니다."
              }
              rows={ts.data}
              xKey="t"
              height={300}
              tickFormatter={fmtDate}
              bucketHours={24}
              lines={[
                { key: "dau", label: "DAU", axis: "left" },
                { key: "wau", label: "WAU", axis: "left" },
                { key: "mau", label: "MAU", axis: "left" },
              ]}
            />
            <DualLineChart
              title="DAU/MAU 고착도"
              subtitle="월간 활성 사용자 중 일간 활성 사용자 비율"
              help="월간 활성 사용자 중 일간 활성 사용자의 비율입니다. 높을수록 매일 사용하는 사용자가 많다는 뜻입니다."
              rows={ts.data}
              xKey="t"
              tickFormatter={fmtDate}
              bucketHours={24}
              lines={[{ key: "stickiness", label: "고착도 %", axis: "left" }]}
            />
          </>
        )}
      </div>
    </div>
  );
}
