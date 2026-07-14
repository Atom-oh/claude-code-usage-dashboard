import { useState } from "react";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { GroupAreaChart, RingGauge, DualLineChart } from "../components/GroupCharts.jsx";
import { GROUP_ORDER, colorFor } from "../colors.js";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { makeTickFmt } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const TOKEN_VIEWS = [
  { value: "tokens", label: "전체" },
  { value: "input_tokens", label: "입력" },
  { value: "output_tokens", label: "출력" },
];

// group을 카드 제목으로 좌우 분리해 보여주므로 테이블 안에서는 그룹 컬럼을 뺀다.
const MODEL_DIST_COLUMNS = [
  { key: "model", label: "모델" },
  { key: "input_tokens", label: "입력 토큰", render: fmt },
  { key: "output_tokens", label: "출력 토큰", render: fmt },
  { key: "tokens", label: "전체 토큰", render: fmt },
];

export default function Overview() {
  const [tokenView, setTokenView] = useState("tokens");
  const { intervalHours } = useRange();
  const { model } = useFilters();
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
      <PageHeader title="Overview" subtitle="bedrock vs enterprise — 텔레메트리 기반 그룹 자동 판별" live right={<RangePicker />} />
      <div className="p-8 flex flex-col gap-6">
        {/* activeUsers도 게이트에 포함 — 안 그러면 로딩/실패 중 "전체 유저 0"이 정상 수치처럼 보인다. */}
        {kpi.loading || activeUsers.loading ? (
          <Loading />
        ) : kpi.error || activeUsers.error ? (
          <ErrorBox error={kpi.error || activeUsers.error} />
        ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatTile
            label="전체 유저"
            value={fmt(activeUsers.data?.users)}
            variant="accent"
            hint={model ? "⚠ model 필터 미적용" : undefined}
          />
          <StatTile label="세션" value={fmt(totals.sessions)} />
          <StatTile label="추가 라인" value={fmt(totals.loc)} />
          <StatTile label="전체 토큰" value={fmt(totals.tokens)} />
          <StatTile label="입력 토큰" value={fmt(totals.inputTokens)} />
          <StatTile label="출력 토큰" value={fmt(totals.outputTokens)} />
        </div>
        )}

        {adoption.loading ? (
          <Loading />
        ) : adoption.error ? (
          <ErrorBox error={adoption.error} />
        ) : (
          <Card
            title="도입 수준 & 고착도"
            subtitle={
              model
                ? "세션이 1건 이상 있었던 유저 기준 · ⚠ model 필터는 이 카드에 적용되지 않습니다(전체 모델 기준)"
                : "세션이 1건 이상 있었던 유저 기준"
            }
          >
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatTile label="전체 멤버" value={fmt(adoption.data.total_members)} />
              <StatTile label="월간 활성 (MAU)" value={fmt(adoption.data.mau)} />
              <StatTile label="주간 활성 (WAU)" value={fmt(adoption.data.wau)} />
              <StatTile label="일간 활성 (DAU)" value={fmt(adoption.data.dau)} variant="accent" />
              <StatTile
                label="DAU/MAU 고착도"
                value={adoption.data.mau > 0 ? `${((adoption.data.dau / adoption.data.mau) * 100).toFixed(0)}%` : "—"}
                hint="일간 활성 ÷ 월간 활성"
              />
            </div>
          </Card>
        )}

        <Card title="그룹별 KPI 요약">
          {kpi.loading ? (
            <Loading />
          ) : kpi.error ? (
            <ErrorBox error={kpi.error} />
          ) : (
            <table className="w-full text-[14px]">
              <thead>
                <tr>
                  {["그룹", "유저", "세션", "커밋", "PR", "입력 토큰", "출력 토큰", "전체 토큰", "추가 라인"].map((h) => (
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
                        {r.group}
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

        {activeTrend.loading ? (
          <Loading />
        ) : activeTrend.error ? (
          <ErrorBox error={activeTrend.error} />
        ) : (
          <DualLineChart
            title="활성 사용자 추이"
            subtitle="DAU / WAU / MAU — 그룹 구분 없이 조직 전체"
            rows={activeTrend.data}
            xKey="t"
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
            title="토큰 사용량 시계열"
            right={<SegmentedControl options={TOKEN_VIEWS} value={tokenView} onChange={setTokenView} />}
            rows={tokens.data}
            xKey="t"
            valueKey={tokenView}
            tickFormatter={fmtTick}
          />
        )}

        {cache.loading ? (
          <Loading />
        ) : cache.error ? (
          <ErrorBox error={cache.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {GROUP_ORDER.map((g) => {
              const r = (cache.data || []).find((row) => row.group === g);
              const inputSide = Number(r?.input_side) || 0;
              const readPct = r?.cache_read_ratio == null ? null : Number(r.cache_read_ratio);
              const writePct = inputSide > 0 ? Number(r.cache_write) / inputSide : null;
              return (
                <Card key={g} title={`캐시 효율 — ${g}`} subtitle="입력측 토큰 중 캐시 읽기/쓰기 비율">
                  <div className="flex justify-center gap-10 py-2">
                    <RingGauge pct={readPct} color={colorFor(g)} label="읽기캐시" sub={r ? `${fmt(r.cache_read)} tok` : undefined} />
                    <RingGauge pct={writePct} color={colorFor(g)} label="쓰기캐시" sub={r ? `${fmt(r.cache_write)} tok` : undefined} />
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
          <div className="grid gap-4 md:grid-cols-2">
            {["bedrock", "enterprise"].map((g) => (
              <DataTable
                key={g}
                title={`모델별 토큰 분포 — ${g}`}
                subtitle="교란 요인 점검용"
                columns={MODEL_DIST_COLUMNS}
                rows={(models.data || []).filter((r) => r.group === g)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
