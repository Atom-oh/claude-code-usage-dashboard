import { localeTag, translate, useLocale } from "../i18n/index.js";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { DualLineChart } from "../components/GroupCharts.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";
import { parseUtc } from "../fmt.js";

const fmtDate = (t) => parseUtc(t).toLocaleDateString(localeTag(), { month: "numeric", day: "numeric" });

export default function Trends() {
  const _locale = useLocale();
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
        title={translate("me856c6c6a48b")}
        subtitle={
          model
            ? translate("ma202f1d51280")
            : translate("mfe67eed3ed5d")
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
              hint={translate("mbd3fcb524601")}
              spark={(ts.data || []).map((r) => r.dau)}
            />
            <StatTile label="WAU" value={last?.wau ?? levels.data.wau} hint={translate("m4678be6aaf99")} spark={(ts.data || []).map((r) => r.wau)} />
            <StatTile label="MAU" value={last?.mau ?? levels.data.mau} hint={translate("mccee8060d2cf")} spark={(ts.data || []).map((r) => r.mau)} />
            <StatTile label={translate("m41cce84fd8fb")} value={last ? `${last.stickiness}%` : "—"} hint={translate("m7ee171fe59c8")} spark={(ts.data || []).map((r) => r.stickiness)} />
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
              title={translate("m2a93f4e07a91")}
              help={
                model
                  ? translate("med0c0ce5f1eb")
                  : translate("m80ece9af1f71")
              }
              rows={ts.data}
              xKey="t"
              zoomDisabled={ts.stale}
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
              title={translate("m41cce84fd8fb")}
              subtitle={translate("m164e1f2f614a")}
              help={translate("m3bfaab399a98")}
              rows={ts.data}
              xKey="t"
              zoomDisabled={ts.stale}
              tickFormatter={fmtDate}
              bucketHours={24}
              lines={[{ key: "stickiness", label: translate("m33fba8e493c5"), axis: "left" }]}
            />
          </>
        )}
      </div>
    </div>
  );
}
