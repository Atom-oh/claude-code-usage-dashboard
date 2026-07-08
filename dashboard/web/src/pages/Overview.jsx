import { useState } from "react";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { GroupAreaChart, GroupBarChart, DualLineChart } from "../components/GroupCharts.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { makeTickFmt } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const TOKEN_VIEWS = [
  { value: "tokens", label: "전체" },
  { value: "input_tokens", label: "입력" },
  { value: "output_tokens", label: "출력" },
];

export default function Overview() {
  const [tokenView, setTokenView] = useState("tokens");
  const { intervalHours } = useRange();
  const fmtTick = makeTickFmt(intervalHours);
  const kpi = useApi("/api/overview/kpi");
  const tokens = useApi("/api/overview/tokens-timeseries");
  const cache = useApi("/api/overview/cache-efficiency");
  const models = useApi("/api/overview/model-distribution");
  const adoption = useApi("/api/adoption/levels");
  const activeTrend = useApi("/api/adoption/timeseries");

  const totals = (kpi.data || []).reduce(
    (acc, r) => ({
      users: acc.users + Number(r.users),
      sessions: acc.sessions + Number(r.sessions),
      tokens: acc.tokens + Number(r.total_tokens),
      inputTokens: acc.inputTokens + Number(r.input_tokens),
      outputTokens: acc.outputTokens + Number(r.output_tokens),
      loc: acc.loc + Number(r.lines_of_code),
    }),
    { users: 0, sessions: 0, tokens: 0, inputTokens: 0, outputTokens: 0, loc: 0 }
  );

  return (
    <div>
      <PageHeader title="Overview" subtitle="bedrock vs enterprise — 텔레메트리 기반 그룹 자동 판별" live right={<RangePicker />} />
      <div className="p-8 flex flex-col gap-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatTile label="전체 유저" value={fmt(totals.users)} variant="accent" />
          <StatTile label="세션" value={fmt(totals.sessions)} />
          <StatTile label="추가 라인" value={fmt(totals.loc)} />
          <StatTile label="전체 토큰" value={fmt(totals.tokens)} />
          <StatTile label="입력 토큰" value={fmt(totals.inputTokens)} />
          <StatTile label="출력 토큰" value={fmt(totals.outputTokens)} />
        </div>

        {adoption.loading ? (
          <Loading />
        ) : adoption.error ? (
          <ErrorBox error={adoption.error} />
        ) : (
          <Card title="도입 수준 & 고착도" subtitle="세션이 1건 이상 있었던 유저 기준">
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
            lines={[
              { key: "mau", label: "MAU" },
              { key: "wau", label: "WAU" },
              { key: "dau", label: "DAU" },
            ]}
          />
        )}

        <div className="grid gap-4 lg:grid-cols-2">
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
          {cache.loading ? <Loading /> : cache.error ? <ErrorBox error={cache.error} /> : (
            <GroupBarChart title="캐시 재사용률" subtitle="cacheRead / (input + cacheRead)" rows={cache.data} valueKey="cache_read_ratio" />
          )}
        </div>

        {models.loading ? (
          <Loading />
        ) : models.error ? (
          <ErrorBox error={models.error} />
        ) : (
          <DataTable
            title="모델별 토큰 분포"
            subtitle="그룹 간 모델 차이 — 교란 요인 점검용"
            columns={[
              { key: "group", label: "그룹" },
              { key: "model", label: "모델" },
              { key: "input_tokens", label: "입력 토큰", render: fmt },
              { key: "output_tokens", label: "출력 토큰", render: fmt },
              { key: "tokens", label: "전체 토큰", render: fmt },
            ]}
            rows={models.data}
          />
        )}
      </div>
    </div>
  );
}
