import { localeTag, localize, translate, translateSource, useLocale } from "../i18n/index.js";
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
const helpText = () => translate("md0e41539dd65", [translateSource(SPEND_HELP), translateSource(NO_TEAM)]);

const usd = (n) => n == null || !Number.isFinite(Number(n)) ? translate("m84dd6e381dca")
  : `$${Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;
const num = (n) => Number(n || 0).toLocaleString(localeTag());
const pct = (v) => v === null ? "" : `${v.toFixed(1)}%`;

// Rows keep the server order (known teams by spend, 팀 없음 last) and gain a display share of
// the known total; an all-unknown team has no share.
export function teamTableRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.reduce((s, r) => s + (r.known_reported_cost ?? 0), 0);
  return list.map((r) => ({ ...r, label: r.team ?? translateSource(NO_TEAM), cost: r.known_reported_cost,
    cost_partial: r.reported_partial === true,
    cost_status: r.reported_partial === true ? translate("md15c830a6f1c") : r.known_reported_cost === null ? translate("m84dd6e381dca") : translate("mf2c10bf5d512"),
    share: r.known_reported_cost === null || total <= 0 ? null : (r.known_reported_cost / total) * 100 }));
}

export const TEAM_COLUMNS = localize([
  { key: "label", label: "팀", toText: (v) => v },
  { key: "cost", label: "비용", render: (v, r) => r.cost_partial
    ? <span className="inline-flex items-center gap-1.5">{usd(v)}<Badge tone="warning">{translate("md15c830a6f1c")}</Badge></span> : usd(v),
    toText: (v) => v ?? "" },
  { key: "share", label: "전체 대비", render: (v) => v === null ? translate("m84dd6e381dca") : pct(v), toText: pct },
  { key: "tokens", label: "토큰", render: num },
  { key: "requests", label: "요청", render: num },
  { key: "users", label: "활성 사용자", render: num },
  { key: "sessions", label: "세션", render: num },
  { key: "cost_status", label: "비용 상태" },
]);

// Partial and unavailable team spend, disclosed wherever known sums are shown (ADR-013).
export function coverageNote(rows) {
  const partial = rows.some((r) => r.cost_partial);
  const unavailable = rows.filter((r) => r.cost === null).length;
  return [partial ? translate("m4042e4001814") : null, unavailable ? translate("m65a60b27ec54", [unavailable]) : null]
    .filter(Boolean).join(" · ") || undefined;
}

export function TeamCostView({ table, trend, intervalHours, onIntervalHours }) {
  const _locale = useLocale();
  const rows = useMemo(() => teamTableRows(table.data), [table.data, _locale]);
  const cells = useMemo(() => fromByModelDaily(trend.data, { dimension: "team" }), [trend.data, _locale]);
  const known = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
  const teamed = rows.filter((r) => r.team !== null).reduce((s, r) => s + (r.cost ?? 0), 0);
  const activeTeams = rows.filter((r) => r.team !== null).length;
  const note = coverageNote(rows);
  return (
    <section className="flex flex-col gap-4" aria-label={translate("mf0b752e9eb98")}>
      <h2 className="text-base font-semibold text-ink-800">{translate("mf0b752e9eb98")}</h2>
      {table.loading ? <Loading /> : table.error ? <ErrorBox error={table.error} /> : <>
        <div className="grid gap-3 sm:grid-cols-2">
          <StatTile label={translate("m38f428eabffd")} value={num(activeTeams)} hint={note}
            help={translate("m41e526692ced", [translateSource(NO_TEAM)])} />
          <StatTile label={translate("m48c96bf42eac")} value={known > 0 ? pct((teamed / known) * 100) : "—"}
            hint={note} help={translate("m6e968d3fab43", [])} />
        </div>
        {/* Known spend only: an all-unknown team has no bar (its table cell reads 확인 필요). */}
        <SeriesBarChart title={translate("m2ef1e524d747")} subtitle={[translate("me18ec02dd663", [translateSource(BASIS)]), note].filter(Boolean).join(" · ")} help={helpText()}
          rows={rows.filter((r) => r.cost !== null).map((r) => ({ team: r.label, part: translate("m65cd7735272e"), value: r.cost }))}
          xKey="team" seriesKey="part" valueKey="value" valuePrefix="$" horizontal />
        <DataTable title={translate("m5c1c03432d39")} subtitle={translateSource(BASIS)} help={helpText()} columns={TEAM_COLUMNS} rows={rows}
          groupKey={null} exportName="team-cost" stale={table.stale || trend.stale} pinLast={isNoTeam} />
      </>}
      {trend.loading ? <Loading /> : trend.error ? <ErrorBox error={trend.error} /> : (
        <ModelCostTrend title={translate("ma8d00e5049ba")} subtitle={translate("m54c5ea01dad7", [translateSource(BASIS)])} cells={cells} help={helpText()} top={8}
          basis={translate("ma029ac069435")} xKey="t" dimension="team" bucketHours={intervalHours} zoomDisabled={trend.stale}
          right={onIntervalHours ? <SegmentedControl options={[{ value: "1", label: translate("mdeb162691363") },
            { value: "24", label: translate("m58ea1d09d2dd") }, { value: "168", label: translate("m2392bb5e3aa6") }]} value={String(intervalHours)}
            onChange={(v) => onIntervalHours(Number(v))} /> : undefined} />
      )}
    </section>
  );
}

// intervalHours is the Cost page's bucket, shared with "모델별 비용 추이".
export function TeamCostSection({ intervalHours }) {
  const _locale = useLocale();
  const table = useApi("/api/cost/by-team");
  const trend = useApi("/api/cost/by-team-daily", { intervalHours });
  return <TeamCostView table={table} trend={trend} intervalHours={intervalHours} />;
}
