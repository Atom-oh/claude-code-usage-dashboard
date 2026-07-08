import { useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { DonutBreakdown, SeriesBarChart } from "../components/GroupCharts.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";

const fmtTick = (t) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export default function Cost() {
  const [intervalHours, setIntervalHours] = useState(24);
  const { from, to } = useRange();
  const summary = useApi("/api/cost/summary");
  const byModel = useApi("/api/cost/by-model");
  const byUserModel = useApi("/api/cost/by-user-model");
  const byModelDaily = useApi("/api/cost/by-model-daily", { intervalHours });
  const compare = useApi("/api/cost/by-model-compare");
  const tiers = useApi("/api/cost/tiers");
  const efficiency = useApi("/api/users/cost-efficiency");
  const prevCostByModel = new Map((compare.data || []).map((r) => [r.model, r.cost === null ? null : Number(r.prev_cost)]));

  const totals = (summary.data || []).reduce(
    (acc, r) => ({
      cost: acc.cost + Number(r.computed_cost),
      reported: acc.reported + Number(r.reported_cost),
      input: acc.input + Number(r.input_tokens),
      output: acc.output + Number(r.output_tokens),
      cacheRead: acc.cacheRead + Number(r.cache_read_tokens),
      cacheWrite: acc.cacheWrite + Number(r.cache_write_tokens),
      unpricedTokens: acc.unpricedTokens + Number(r.unpriced_tokens),
      sessions: acc.sessions + Number(r.sessions),
    }),
    { cost: 0, reported: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, sessions: 0 }
  );

  const modelTotals = new Map();
  for (const r of byModel.data || []) {
    const prev =
      modelTotals.get(r.model) || { model: r.model, cost: 0, reportedCost: 0, inputTokens: 0, outputTokens: 0, unpriced: false };
    if (r.cost === null) prev.unpriced = true;
    else prev.cost += Number(r.cost);
    prev.reportedCost += Number(r.reported_cost);
    prev.inputTokens += Number(r.input_tokens);
    prev.outputTokens += Number(r.output_tokens);
    modelTotals.set(r.model, prev);
  }
  const modelRows = [...modelTotals.values()].sort((a, b) => b.cost - a.cost);
  const totalModelCost = modelRows.reduce((s, r) => s + (r.unpriced ? 0 : r.cost), 0);

  const userModelRows = [...(byUserModel.data || [])].sort((a, b) => (b.cost || 0) - (a.cost || 0));

  const daysInRange = Math.max(1, (to - from) / 86400000);
  const projection30d = (totals.cost / daysInRange) * 30;
  const developerCount = new Set((byUserModel.data || []).map((r) => r.user)).size;
  const spendPerDeveloper = developerCount > 0 ? totals.cost / developerCount : 0;

  const tierRows = tiers.data
    ? [
        { tier: "캐시 읽기", cost: tiers.data.cacheRead },
        { tier: "캐시 쓰기", cost: tiers.data.cacheWrite },
        { tier: "출력", cost: tiers.data.output },
        { tier: "비캐시 입력", cost: tiers.data.uncachedInput },
      ]
    : [];

  // loc=0이어도 commits>0인 유저(라인 없이 커밋만 한 경우)는 $/커밋 컬럼에 값이 있으므로 테이블에서
  // 지우면 안 된다. unpriced(미산정 모델 사용) 유저는 cost_per_loc이 null — 오름차순 정렬에서 항상
  // 맨 뒤로 보내야 $0.0000/LOC로 "가장 효율적"에 잘못 노출되지 않는다.
  const efficiencyRows = [...(efficiency.data || [])]
    .filter((r) => r.loc > 0 || r.commits > 0)
    .sort((a, b) => (a.cost_per_loc == null) - (b.cost_per_loc == null) || a.cost_per_loc - b.cost_per_loc);

  return (
    <div>
      <PageHeader
        title="Cost"
        subtitle="토큰 실측 × 모델 단가(캐시 읽기/쓰기 포함)로 계산한 비용. '보고 비용'은 Claude Code 텔레메트리가 자체 보고하는 근사치 — 비교용."
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {summary.loading || byUserModel.loading ? (
          <Loading />
        ) : summary.error || byUserModel.error ? (
          <ErrorBox error={summary.error || byUserModel.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label="계산 비용 (합계)"
              value={usd(totals.cost)}
              variant="accent"
              hint={totals.unpricedTokens > 0 ? `미산정 모델 토큰 ${fmt(totals.unpricedTokens)}개` : `${summary.data.length}개 그룹`}
            />
            <StatTile label="보고 비용 (Claude Code)" value={usd(totals.reported)} />
            <StatTile label="입력 토큰" value={fmt(totals.input)} />
            <StatTile label="출력 토큰" value={fmt(totals.output)} />
            <StatTile label="캐시 읽기 토큰" value={fmt(totals.cacheRead)} />
            <StatTile label="캐시 쓰기 토큰" value={fmt(totals.cacheWrite)} />
            <StatTile label="세션" value={fmt(totals.sessions)} />
            <StatTile label="30일 프로젝션" value={usd(projection30d)} hint="현재 기간 일평균 × 30" />
            {/* developerCount/spendPerDeveloper는 byUserModel에서 나온다 — summary만 게이트하면
                byUserModel이 아직 로딩 중이거나 에러여도 "$0 / 0명 기준"이 실제 값처럼 보인다. */}
            <StatTile label="개발자당 지출" value={usd(spendPerDeveloper)} hint={`${developerCount}명 기준`} />
          </div>
        )}

        {tiers.loading ? (
          <Loading />
        ) : tiers.error ? (
          <ErrorBox error={tiers.error} />
        ) : (
          <DonutBreakdown
            title="캐시 티어별 지출"
            subtitle={
              totals.unpricedTokens > 0
                ? `비캐시 입력 / 캐시 읽기 / 캐시 쓰기 / 출력 — 미산정 모델 토큰 ${fmt(totals.unpricedTokens)}개는 제외`
                : "비캐시 입력 / 캐시 읽기 / 캐시 쓰기 / 출력"
            }
            data={tierRows}
            nameKey="tier"
            valueKey="cost"
            valuePrefix="$"
          />
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
          <SeriesBarChart
            title="일간 모델별 지출"
            right={
              <SegmentedControl
                options={[{ value: "24", label: "일간" }, { value: "168", label: "주간" }]}
                value={String(intervalHours)}
                onChange={(v) => setIntervalHours(Number(v))}
              />
            }
            rows={byModelDaily.data}
            xKey="day"
            seriesKey="model"
            valueKey="cost"
            tickFormatter={fmtTick}
            valuePrefix="$"
          />
        )}

        <DataTable
          title="모델 · 지출 & 토큰"
          subtitle="계산 비용 기준 정렬 · 이전 기간 대비는 현재와 동일한 길이의 직전 구간과 비교"
          columns={[
            { key: "model", label: "모델" },
            { key: "cost", label: "지출 (계산)", render: (_v, r) => (r.unpriced ? <Badge tone="neutral">미산정</Badge> : usd(r.cost)) },
            { key: "reportedCost", label: "보고 비용", render: usd },
            {
              key: "share",
              label: "전체 대비",
              render: (_v, r) => (r.unpriced ? <span className="text-ink-400">—</span> : `${totalModelCost > 0 ? ((r.cost / totalModelCost) * 100).toFixed(1) : 0}%`),
            },
            {
              key: "change",
              label: "이전 기간 대비",
              render: (_v, r) => {
                const prev = prevCostByModel.get(r.model);
                if (r.unpriced || prev === null || prev === undefined || prev <= 0) return <span className="text-ink-400">—</span>;
                const pct = ((r.cost - prev) / prev) * 100;
                return (
                  <Badge tone={pct >= 0 ? "positive" : "negative"}>
                    {pct >= 0 ? "+" : ""}
                    {pct.toFixed(1)}%
                  </Badge>
                );
              },
            },
            { key: "inputTokens", label: "입력 토큰", render: fmt },
            { key: "outputTokens", label: "출력 토큰", render: fmt },
          ]}
          rows={modelRows}
          groupKey="__none__"
        />

        {byUserModel.loading ? (
          <Loading />
        ) : byUserModel.error ? (
          <ErrorBox error={byUserModel.error} />
        ) : (
          <DataTable
            title="사용자 · 모델별 지출"
            subtitle="계산 비용 기준 정렬 · 그룹(bedrock/enterprise)은 사용자가 실제로 호출한 모델로 자동 판별"
            columns={[
              { key: "user", label: "사용자" },
              { key: "group", label: "그룹" },
              { key: "model", label: "모델" },
              { key: "cost", label: "지출 (계산)", render: (_v, r) => (r.unpriced ? <Badge tone="neutral">미산정</Badge> : usd(r.cost)) },
              { key: "reported_cost", label: "보고 비용", render: usd },
              { key: "tokens", label: "토큰", render: fmt },
            ]}
            rows={userModelRows}
          />
        )}

        {efficiency.loading ? (
          <Loading />
        ) : efficiency.error ? (
          <ErrorBox error={efficiency.error} />
        ) : (
          <DataTable
            title="비용 효율 ($/LOC · $/커밋)"
            subtitle="라인당 계산 비용이 낮은 순 — 성과 평가가 아니라 비용 신호"
            columns={[
              { key: "user", label: "사용자" },
              { key: "group", label: "그룹" },
              { key: "cost", label: "지출 (계산)", render: (v, r) => (r.unpriced ? <Badge tone="neutral">미산정 포함</Badge> : usd(v)) },
              { key: "loc", label: "추가 라인", render: fmt },
              { key: "commits", label: "커밋", render: fmt },
              { key: "cost_per_loc", label: "$/LOC", render: (v) => (v == null ? "—" : `$${v.toFixed(4)}`) },
              { key: "cost_per_commit", label: "$/커밋", render: (v) => (v == null ? "—" : usd(v)) },
            ]}
            rows={efficiencyRows}
          />
        )}
      </div>
    </div>
  );
}
