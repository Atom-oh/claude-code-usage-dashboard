import { useState } from "react";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { GroupAreaChart, RingGauge, DualLineChart } from "../components/GroupCharts.jsx";
import { colorFor } from "../colors.js";
import { groupsShown, groupLabel } from "../pivot.js";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { makeTickFmt } from "../fmt.js";
import { unclassifiedLabel } from "../labels.js";

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
  const { groupMode } = useConfig();
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
        title="Overview"
        subtitle={groupLabel(groupMode, "bedrock과 enterprise 채널 비교", "Claude Code 사용량 개요")}
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
            label="활성 사용자"
            value={fmt(activeUsers.data?.users)}
            variant="accent"
            hint={model ? "모델 필터 미적용" : undefined}
            help="선택한 기간에 세션이 1건 이상 있었던 사용자 수입니다. 채널 구분 없이 집계하며 채널이 판별되지 않은 세션도 포함합니다."
          />
          <StatTile label="세션" value={fmt(totals.sessions)} help="선택한 기간의 세션 수입니다. 채널이 판별되지 않은 세션도 포함합니다." />
          <StatTile label="추가 코드 라인" value={fmt(totals.loc)} help="선택한 기간에 추가된 코드 라인 수입니다. 채널이 판별되지 않은 세션도 포함합니다." />
          <StatTile label="전체 토큰" value={fmt(totals.tokens)} help="선택한 기간의 토큰 사용량입니다. 입력, 출력, 캐시 읽기, 캐시 쓰기 토큰을 모두 포함합니다." />
          <StatTile label="입력 토큰" value={fmt(totals.inputTokens)} help="선택한 기간의 입력 토큰 사용량입니다. 캐시 읽기·쓰기 토큰은 포함하지 않습니다." />
          <StatTile label="출력 토큰" value={fmt(totals.outputTokens)} help="선택한 기간의 출력 토큰 사용량입니다. Thinking 토큰이 포함됩니다." />
        </div>
        )}

        {adoption.loading ? (
          <Loading />
        ) : adoption.error ? (
          <ErrorBox error={adoption.error} />
        ) : (
          <Card
            title="도입 수준과 고착도"
            subtitle={
              model
                ? "세션이 1건 이상 있었던 사용자 기준 · 모델 필터 미적용"
                : "세션이 1건 이상 있었던 사용자 기준"
            }
            help={model ? "이 카드의 지표는 선택한 모델 필터와 무관하게 전체 모델 기준으로 집계됩니다." : undefined}
          >
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <StatTile
                label="누적 사용자"
                value={fmt(adoption.data.total_members)}
                help="지금까지 한 번이라도 세션을 실행한 사용자 수입니다. 선택한 기간의 시작과 무관하게 기간 종료 시점까지의 전체 이력을 집계합니다."
              />
              <StatTile
                label="월간 활성 (MAU)"
                value={fmt(adoption.data.mau)}
                help="기간 종료 시점 기준 최근 30일 안에 세션이 있었던 사용자 수입니다."
              />
              <StatTile
                label="주간 활성 (WAU)"
                value={fmt(adoption.data.wau)}
                help="기간 종료 시점 기준 최근 7일 안에 세션이 있었던 사용자 수입니다."
              />
              <StatTile
                label="일간 활성 (DAU)"
                value={fmt(adoption.data.dau)}
                variant="accent"
                help="기간 종료 시점 기준 최근 24시간 안에 세션이 있었던 사용자 수입니다."
              />
              <StatTile
                label="DAU/MAU 고착도"
                value={adoption.data.mau > 0 ? `${((adoption.data.dau / adoption.data.mau) * 100).toFixed(0)}%` : "—"}
                hint="일간 활성 ÷ 월간 활성"
                help="월간 활성 사용자 중 일간 활성 사용자의 비율입니다. 높을수록 매일 사용하는 사용자가 많다는 뜻입니다."
              />
            </div>
          </Card>
        )}

        <Card title="채널별 KPI 요약" help="이 표에는 채널이 판별되지 않은 세션이 미분류 행으로 함께 표시됩니다.">
          {kpi.loading ? (
            <Loading />
          ) : kpi.error ? (
            <ErrorBox error={kpi.error} />
          ) : (
            <table className="w-full text-[14px]">
              <thead>
                <tr>
                  {["채널", "사용자", "세션", "커밋", "PR", "입력 토큰", "출력 토큰", "전체 토큰", "추가 코드 라인"].map((h) => (
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

        {activeTrend.loading ? (
          <Loading />
        ) : activeTrend.error ? (
          <ErrorBox error={activeTrend.error} />
        ) : (
          <DualLineChart
            title="활성 사용자 추이"
            subtitle="채널 구분 없는 조직 전체 기준"
            help="주간·월간 활성 사용자는 각 날짜 기준 최근 7일과 30일 안에 세션이 있었던 사용자입니다."
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
            title="토큰 사용량 추이"
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
            {groupsShown(groupMode, cache.data).map((g) => {
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
                <Card key={g} title={`캐시 효율 — ${g}`} subtitle="입력 쪽 토큰 중 캐시 읽기·쓰기 비율" help="입력, 캐시 읽기, 캐시 쓰기 토큰을 합한 값을 기준으로 각각의 비율을 계산합니다.">
                  <div className="flex justify-center gap-10 py-2">
                    <RingGauge pct={readPct} color={colorFor(g)} label="캐시 읽기" sub={r ? `${fmt(r.cache_read)} 토큰` : undefined} />
                    <RingGauge pct={writePct} color={colorFor(g)} label="캐시 쓰기" sub={r ? `${fmt(r.cache_write)} 토큰` : undefined} />
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
            {groupsShown(groupMode, models.data).map((g) => (
              <DataTable
                key={g}
                title={`모델별 토큰 분포 — ${g}`}
                subtitle="채널별 모델 구성"
                help="두 채널의 모델 구성이 다르면 비용과 생산성 비교에 영향을 줄 수 있습니다."
                columns={MODEL_DIST_COLUMNS}
                rows={(models.data || []).filter((r) => r.group === g)}
                exportName={`overview_model_tokens_${g}`}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
