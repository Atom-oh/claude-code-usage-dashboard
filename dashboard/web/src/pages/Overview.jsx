import { localeTag, localize, translate, useLocale } from "../i18n/index.js";
import { useState } from "react";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { GroupAreaChart, RingGauge, DualLineChart } from "../components/GroupCharts.jsx";
import { colorFor } from "../colors.js";
import { groupLabel } from "../pivot.js";
import { useGroupsShown } from "../useGroupsShown.js";
import { useApi } from "../useApi.js";
import { withoutZeroTokenModels } from "../modelRows.js";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { makeTickFmt } from "../fmt.js";
import { unclassifiedLabel } from "../labels.js";
import SessionTurns from "../components/SessionTurns.jsx";
import DailyInsights from "../components/DailyInsights.jsx";

const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
const TOKEN_VIEWS = localize([
  { value: "tokens", label: "전체" },
  { value: "input_tokens", label: "입력" },
  { value: "output_tokens", label: "출력" },
]);

// group을 카드 제목으로 좌우 분리해 보여주므로 테이블 안에서는 그룹 컬럼을 뺀다.
const MODEL_DIST_COLUMNS = localize([
  { key: "model", label: "모델" },
  { key: "input_tokens", label: "입력 토큰", render: fmt },
  { key: "output_tokens", label: "출력 토큰", render: fmt },
  { key: "tokens", label: "전체 토큰", render: fmt },
]);

export default function Overview() {
  const _locale = useLocale();
  const [tokenView, setTokenView] = useState("tokens");
  const { intervalHours } = useRange();
  const { model } = useFilters();
  const { groupMode } = useConfig();
  const shownGroups = useGroupsShown();
  const fmtTick = makeTickFmt(intervalHours);
  const kpi = useApi("/api/overview/kpi");
  const activeUsers = useApi("/api/overview/active-users");
  const tokens = useApi("/api/overview/tokens-timeseries");
  const cache = useApi("/api/overview/cache-efficiency");
  const models = useApi("/api/overview/model-distribution");
  const adoption = useApi("/api/adoption/levels");
  const activeTrend = useApi("/api/adoption/timeseries");

  // users는 그룹별 kpi 합산 대신 ungrouped uniq(active-users)로 — 세션 그레인 판별상 한 유저가
  // 양 그룹에 걸치면 합산이 중복 카운트된다.
  const totals = (kpi.data || []).reduce(
    (acc, r) => ({
      sessions: acc.sessions + Number(r.sessions),
      tokens: acc.tokens + Number(r.total_tokens),
      inputTokens: acc.inputTokens + Number(r.input_tokens),
      outputTokens: acc.outputTokens + Number(r.output_tokens),
      loc: acc.loc + Number(r.lines_of_code),
    }),
    { sessions: 0, tokens: 0, inputTokens: 0, outputTokens: 0, loc: 0 }
  );

  return (
    <div>
      <PageHeader
        title={translate("md4b1ea5708dd")}
        subtitle={groupLabel(groupMode, translate("mf91e81c27ba1"), translate("mf732be02ad7f"))}
        live
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-6">
        {/* activeUsers도 게이트에 포함 — 안 그러면 로딩/실패 중 "전체 유저 0"이 정상 수치처럼 보인다. */}
        {kpi.loading || activeUsers.loading ? (
          <Loading />
        ) : kpi.error || activeUsers.error ? (
          <ErrorBox error={kpi.error || activeUsers.error} />
        ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatTile
            label={translate("m316e29c8e8c3")}
            value={fmt(activeUsers.data?.users)}
            variant="accent"
            hint={model ? translate("m59ff6f5f411b") : undefined}
            help={translate("m5d0af1a49e7e")}
          />
          <StatTile label={translate("me600d4f5926e")} value={fmt(totals.sessions)} help={translate("m474b0ec2c53e")} />
          <StatTile label={translate("m81ea6a128280")} value={fmt(totals.loc)} help={translate("mcb5b39c3cc11")} />
          <StatTile label={translate("m950ed890e8a3")} value={fmt(totals.tokens)} help={translate("m5b64158c88f0")} />
          <StatTile label={translate("me10fd8ddfcf8")} value={fmt(totals.inputTokens)} help={translate("m09577ed46264")} />
          <StatTile label={translate("m6f31589138ca")} value={fmt(totals.outputTokens)} help={translate("m2cffe0261630")} />
        </div>
        )}

        {adoption.loading ? (
          <Loading />
        ) : adoption.error ? (
          <ErrorBox error={adoption.error} />
        ) : (
          <Card
            title={translate("m8c27c3eab24f")}
            subtitle={
              model
                ? translate("m2f777b8763d1")
                : translate("m4f1248cb9e0b")
            }
            help={model ? translate("m41b3cdf4f86a") : undefined}
          >
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatTile
                label={translate("ma2bc53aee146")}
                value={fmt(adoption.data.total_members)}
                help={translate("mdd2add3f5fea")}
              />
              <StatTile
                label={translate("md86f4b807f46")}
                value={fmt(adoption.data.mau)}
                help={translate("mc696b847d43a")}
              />
              <StatTile
                label={translate("mb2769677c238")}
                value={fmt(adoption.data.wau)}
                help={translate("m1f34f470506c")}
              />
              <StatTile
                label={translate("mf799616a9bb7")}
                value={fmt(adoption.data.dau)}
                variant="accent"
                help={translate("mcfbdf52e017f")}
              />
              <StatTile
                label={translate("m41cce84fd8fb")}
                value={adoption.data.mau > 0 ? `${((adoption.data.dau / adoption.data.mau) * 100).toFixed(0)}%` : "—"}
                hint={translate("m7ee171fe59c8")}
                help={translate("m3bfaab399a98")}
              />
            </div>
          </Card>
        )}

        <Card title={translate("ma4d95414ec54")} help={translate("mae5bdcb67be4")}>
          {kpi.loading ? (
            <Loading />
          ) : kpi.error ? (
            <ErrorBox error={kpi.error} />
          ) : (
            <table className="w-full text-[14px]">
              <thead>
                <tr>
                  {[translate("ma391a59a3eb6"), translate("m1ac6e422b7dc"), translate("me600d4f5926e"), translate("ma5d6612cd595"), "PR", translate("me10fd8ddfcf8"), translate("m6f31589138ca"), translate("m950ed890e8a3"), translate("m81ea6a128280")].map((h) => (
                    <th key={h} className="text-left text-[11px] uppercase tracking-[0.04em] font-medium text-ink-400 py-2 px-2 border-b border-ink-100">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {kpi.data.map((r, i) => (
                  <tr key={i} className="border-t border-ink-100">
                    <td className="py-2 px-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ background: `var(--chart-${i + 1})` }} />
                        {unclassifiedLabel(r.group)}
                      </span>
                    </td>
                    <td className="py-2 px-2 tabular">{fmt(r.users)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.sessions)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.commits)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.prs)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.input_tokens)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.output_tokens)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.total_tokens)}</td>
                    <td className="py-2 px-2 tabular">{fmt(r.lines_of_code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <SessionTurns />
        <DailyInsights />

        {activeTrend.loading ? (
          <Loading />
        ) : activeTrend.error ? (
          <ErrorBox error={activeTrend.error} />
        ) : (
          <DualLineChart
            title={translate("m7ae57a1391dc")}
            subtitle={translate("mf96a7513d0f3")}
            help={translate("m80ece9af1f71")}
            rows={activeTrend.data}
            xKey="t"
            zoomDisabled={activeTrend.stale}
            tickFormatter={fmtTick}
            bucketHours={24}
            lines={[
              { key: "mau", label: "MAU" },
              { key: "wau", label: "WAU" },
              { key: "dau", label: "DAU" },
            ]}
          />
        )}

        {tokens.loading ? <Loading /> : tokens.error ? <ErrorBox error={tokens.error} /> : (
          <GroupAreaChart
            title={translate("m34586c25c520")}
            right={<SegmentedControl options={TOKEN_VIEWS} value={tokenView} onChange={setTokenView} />}
            rows={tokens.data}
            xKey="t"
            zoomDisabled={tokens.stale}
            valueKey={tokenView}
            tickFormatter={fmtTick}
          />
        )}

        {cache.loading ? (
          <Loading />
        ) : cache.error ? (
          <ErrorBox error={cache.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(cache.data).map((g) => {
              const r = (cache.data || []).find((row) => row.group === g);
              // 진짜 캐시 적중률 = cache_read / input_side(비캐시입력+캐시읽기+캐시쓰기). 캐시 쓰기를
              // 분모에서 빼면 안 된다 — 캐시 미스는 실제로 uncached_input이 아니라 cache_write로
              // 잡힌다(이번에 새로 캐시를 쓴 것 = 못 맞은 것). uncached_input은 원래 캐시 대상이
              // 아닌 소량이라, 이걸 빼고 나면 분모가 거의 cache_read 자신이 되어 항상 ~100%로
              // 나온다(실측 리뷰로 확인된 회귀 — cache_write를 반드시 분모에 포함해야 한다).
              const inputSide = Number(r?.input_side) || 0;
              const readPct = inputSide > 0 ? Number(r.cache_read) / inputSide : null;
              const writePct = inputSide > 0 ? Number(r.cache_write) / inputSide : null;
              return (
                <Card key={g} title={translate("ma71505975b4e", [g])} subtitle={translate("m0c88dbcf4bc8")} help={translate("mbe1638eb0193")}>
                  <div className="flex justify-center gap-10 py-2">
                    <RingGauge pct={readPct} color={colorFor(g)} label={translate("m12be3da02b6d")} sub={r ? translate("ma4a733a72b03", [fmt(r.cache_read)]) : undefined} />
                    <RingGauge pct={writePct} color={colorFor(g)} label={translate("m1be0e1388dc5")} sub={r ? translate("ma4a733a72b03", [fmt(r.cache_write)]) : undefined} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {models.loading ? (
          <Loading />
        ) : models.error ? (
          <ErrorBox error={models.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(models.data).map((g) => (
              <DataTable
                key={g}
                title={translate("mdff631a865d6", [g])}
                subtitle={translate("mc9aa9861a643")}
                help={translate("m0381ac1c4741")}
                columns={MODEL_DIST_COLUMNS}
                rows={withoutZeroTokenModels((models.data || []).filter((r) => r.group === g))}
                exportName={`overview_model_tokens_${g}`}
                stale={models.stale}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
