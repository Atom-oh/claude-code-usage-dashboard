import { useEffect, useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { DonutBody, DonutBreakdown, HBarList, SeriesBarChart } from "../components/GroupCharts.jsx";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { useChartColors } from "../useChartColors.js";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useFilters } from "../FilterContext.jsx";
import { useRange } from "../RangeContext.jsx";
import { makeTickFmt } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function foldModelRows(rows) {
  const totals = new Map();
  for (const r of rows) {
    const prev =
      totals.get(r.model) ||
      { model: r.model, cost: 0, reportedCost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, unpriced: false };
    if (r.cost === null) prev.unpriced = true;
    else prev.cost += Number(r.cost);
    prev.reportedCost += Number(r.reported_cost);
    prev.tokens += Number(r.tokens);
    prev.inputTokens += Number(r.input_tokens);
    prev.outputTokens += Number(r.output_tokens);
    totals.set(r.model, prev);
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost);
}

export default function Cost() {
  const { intervalHours: defaultIntervalHours, days, from, to } = useRange();
  const { model } = useFilters();
  const [intervalHours, setIntervalHours] = useState(defaultIntervalHours);
  // 전역 기간 프리셋(RangePicker)이 바뀌면 이 페이지의 로컬 granularity도 기본값으로 재동기화 —
  // 안 그러면 7일 보다가 1일로 바꿔도 "일간" 버킷에 머문다. days도 dependency에 넣는다: 주간(168)을
  // 수동 선택한 뒤 30일→7일로 바꾸면 defaultIntervalHours(24)는 불변이라 effect가 안 돌아 주간 버킷이
  // 남는데(7일=바 1개), days가 바뀌므로 이때도 기본 granularity로 리셋된다.
  // from/to의 getTime()도 필요하다 — 드래그 줌으로 커스텀 구간을 옮겨도(days는 프리셋 전용이라
  // 안 바뀌고 defaultIntervalHours도 같은 해상도로 우연히 같은 값이면) effect가 재실행되지 않아
  // 이 페이지의 차트만 옛 구간의 intervalHours에 머문다(리뷰에서 MINOR로 확인).
  useEffect(() => setIntervalHours(defaultIntervalHours), [defaultIntervalHours, days, from.getTime(), to.getTime()]);
  const fmtTick = makeTickFmt(intervalHours);
  const summary = useApi("/api/cost/summary");
  const byModel = useApi("/api/cost/by-model");
  const byUserModel = useApi("/api/cost/by-user-model");
  const byModelDaily = useApi("/api/cost/by-model-daily", { intervalHours });
  const compare = useApi("/api/cost/by-model-compare");
  const tiers = useApi("/api/cost/tiers");
  const cacheEff = useApi("/api/overview/cache-efficiency");
  // 개발자당 지출의 분모 — byUserModel(excludeUnknown 기본값, unknown 유저 제외)이 아니라
  // activeUsers(excludeUnknown:false, "전체 개발자 수" 총계)를 써야 한다. totals.cost(costSummary,
  // 이 PR에서 excludeUnknown:false로 바뀜)와 짝을 맞추지 않으면 분자·분모 모수가 달라 지출이
  // 과대 계산된다(리뷰에서 MAJOR로 확인 — Executive.jsx는 이미 activeUsers로 통일했었음).
  const activeUsers = useApi("/api/overview/active-users");
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

  const modelRows = foldModelRows(byModel.data || []);
  const totalModelCost = modelRows.reduce((s, r) => s + (r.unpriced ? 0 : r.cost), 0);

  const userModelRows = [...(byUserModel.data || [])].sort((a, b) => (b.cost || 0) - (a.cost || 0));

  const userTotals = new Map();
  for (const r of byUserModel.data || []) {
    if (r.cost === null) continue;
    userTotals.set(r.user, (userTotals.get(r.user) || 0) + Number(r.cost));
  }
  const top10Users = [...userTotals.entries()]
    .map(([user, cost]) => ({ user, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);

  // bedrock/enterprise 도넛 두 개를 한 카드에 — 같은 모델은 양쪽에서 같은 색이어야 하므로
  // 전체 지출 순위(modelRows) 기준으로 색을 먼저 고정하고 두 도넛에 같은 맵을 넘긴다.
  const chartColors = useChartColors();
  const modelColor = new Map(modelRows.map((r, i) => [r.model, chartColors.palette[i % chartColors.palette.length]]));
  const bedrockModelRows = foldModelRows((byModel.data || []).filter((r) => r.group === "bedrock"));
  const enterpriseModelRows = foldModelRows((byModel.data || []).filter((r) => r.group === "enterprise"));

  // 탭으로 그룹을 고르던 방식 대신 bedrock/enterprise 카드를 좌우로 분리 — 각 카드는 그 그룹만의 합계.
  function tokenTypeRowsFor(group) {
    const totals = (summary.data || [])
      .filter((r) => r.group === group)
      .reduce(
        (acc, r) => ({
          input: acc.input + Number(r.input_tokens),
          output: acc.output + Number(r.output_tokens),
          cacheRead: acc.cacheRead + Number(r.cache_read_tokens),
          cacheWrite: acc.cacheWrite + Number(r.cache_write_tokens),
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      );
    return [
      { type: "입력", tokens: totals.input },
      { type: "출력", tokens: totals.output },
      { type: "캐시 읽기", tokens: totals.cacheRead },
      { type: "캐시 쓰기", tokens: totals.cacheWrite },
    ].filter((r) => r.tokens > 0);
  }

  // 최소 하한을 1일로 두면 드래그 줌으로 고른 <1일 구간(예: 10분)의 지출이 "일평균"으로
  // 잘못 간주돼 ×30이 크게 부풀려진다(리뷰에서 MINOR로 확인) — 실제 구간 길이(분 단위까지)로
  // 나눠야 짧은 줌 구간에서도 선형 비례가 유지된다. 최소 1분만 하한(0으로 나누기 방지).
  const daysInRange = Math.max(1 / 1440, (to - from) / 86400000);
  const projection30d = (totals.cost / daysInRange) * 30;
  const developerCount = activeUsers.data?.users ?? 0;
  const spendPerDeveloper = developerCount > 0 ? totals.cost / developerCount : 0;
  // model 필터가 켜져 있으면 totals.cost(costSummary, modelMixed로 model 필터 적용)와
  // developerCount(activeUsers, model 필터 미적용 — People 섹션 규칙)의 모수 축이 어긋난다 —
  // "이 모델 지출 / 전체 개발자"가 되어 실제보다 낮게 나온다(리뷰에서 MAJOR로 확인). 정확한
  // model-aware 분모가 없으므로, 필터가 켜진 상태에선 오해를 막기 위해 힌트로 명시한다.
  const spendPerDeveloperHint = model
    ? `${fmt(developerCount)}명 기준 — model 필터가 켜져 있어 분자만 필터링됨(참고용)`
    : `${fmt(developerCount)}명 기준`;

  // 그룹별 캐시 티어별 지출 — bedrock/enterprise 좌우 분리(다른 카드들과 동일 패턴).
  function tierRowsFor(group) {
    const t = tiers.data?.[group];
    if (!t) return [];
    return [
      { tier: "캐시 읽기", cost: t.cacheRead },
      { tier: "캐시 쓰기", cost: t.cacheWrite },
      { tier: "출력", cost: t.output },
      { tier: "비캐시 입력", cost: t.uncachedInput },
    ];
  }
  // 캐시율(cacheRead / (input+cacheRead+cacheCreation)) — /api/overview/cache-efficiency가
  // 이미 그룹별로 계산해주는 값을 그대로 재사용(중복 계산 없음).
  const cacheRatioFor = (group) => Number((cacheEff.data || []).find((r) => r.group === group)?.cache_read_ratio || 0);
  // 미산정 토큰도 그룹별로 — 전체 합계(totals.unpricedTokens)를 양쪽 카드에 그대로 쓰면 한쪽
  // 그룹에만 미산정 모델이 있어도 반대쪽 카드에 잘못된 "미산정 N개 제외" 안내가 뜬다(리뷰에서
  // MINOR로 확인). summary.data가 이미 그룹별 unpriced_tokens를 갖고 있으니 그대로 찾는다.
  const unpricedTokensFor = (group) => Number((summary.data || []).find((r) => r.group === group)?.unpriced_tokens || 0);

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
        {/* byUserModel은 이 카드 블록에서 안 쓴다(developerCount는 이제 activeUsers 기반) —
            여기 게이트에 넣으면 이 카드와 무관한 API 로딩/에러가 렌더를 불필요하게 묶는다
            (리뷰에서 확인). byUserModel을 실제로 쓰는 아래 랭킹 섹션이 자체 게이트를 갖는다. */}
        {summary.loading || activeUsers.loading ? (
          <Loading />
        ) : summary.error || activeUsers.error ? (
          <ErrorBox error={summary.error || activeUsers.error} />
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
            {/* developerCount/spendPerDeveloper는 activeUsers에서 나온다 — summary만 게이트하면
                activeUsers가 아직 로딩 중이거나 에러여도 "$0 / 0명 기준"이 실제 값처럼 보인다. */}
            <StatTile label="개발자당 지출" value={usd(spendPerDeveloper)} hint={spendPerDeveloperHint} />
          </div>
        )}

        {tiers.loading || cacheEff.loading ? (
          <Loading />
        ) : tiers.error || cacheEff.error ? (
          <ErrorBox error={tiers.error || cacheEff.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {["bedrock", "enterprise"].map((g) => (
              <DonutBreakdown
                key={g}
                title={`캐시 티어별 지출 — ${g}`}
                subtitle={`캐시율(재사용률) ${(cacheRatioFor(g) * 100).toFixed(1)}% · 비캐시 입력 / 캐시 읽기 / 캐시 쓰기 / 출력${
                  unpricedTokensFor(g) > 0 ? ` — 미산정 모델 토큰 ${fmt(unpricedTokensFor(g))}개는 제외` : ""
                }`}
                right={<Badge tone="brand">캐시율 {(cacheRatioFor(g) * 100).toFixed(1)}%</Badge>}
                data={tierRowsFor(g)}
                nameKey="tier"
                valueKey="cost"
                valuePrefix="$"
              />
            ))}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {byModel.loading ? (
            <Loading />
          ) : byModel.error ? (
            <ErrorBox error={byModel.error} />
          ) : (
            <>
              <Card title="모델별 지출 비중 — bedrock" subtitle="같은 모델은 enterprise 카드와 같은 색">
                <DonutBody data={bedrockModelRows} nameKey="model" valueKey="cost" valuePrefix="$" colorOf={(name) => modelColor.get(name)} />
              </Card>
              <Card title="모델별 지출 비중 — enterprise" subtitle="같은 모델은 bedrock 카드와 같은 색">
                <DonutBody data={enterpriseModelRows} nameKey="model" valueKey="cost" valuePrefix="$" colorOf={(name) => modelColor.get(name)} />
              </Card>
            </>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {summary.loading ? (
            <Loading />
          ) : summary.error ? (
            <ErrorBox error={summary.error} />
          ) : (
            <>
              <DonutBreakdown
                title="토큰 타입별 비중 — bedrock"
                data={tokenTypeRowsFor("bedrock")}
                nameKey="type"
                valueKey="tokens"
              />
              <DonutBreakdown
                title="토큰 타입별 비중 — enterprise"
                data={tokenTypeRowsFor("enterprise")}
                nameKey="type"
                valueKey="tokens"
              />
            </>
          )}
        </div>

        {byModelDaily.loading ? (
          <Loading />
        ) : byModelDaily.error ? (
          <ErrorBox error={byModelDaily.error} />
        ) : (
          <SeriesBarChart
            title="모델별 지출 추이"
            right={
              <SegmentedControl
                options={[
                  { value: "1", label: "시간별" },
                  { value: "24", label: "일간" },
                  { value: "168", label: "주간" },
                ]}
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
            bucketHours={intervalHours}
          />
        )}

        <DataTable
          title="모델 · 지출 & 토큰"
          subtitle="계산 비용 기준 정렬 · 이전 기간 대비는 현재와 동일한 길이의 직전 구간과 비교(1시간 미만 드래그 줌은 최소 1시간 창으로 비교됨)"
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
          <HBarList title="Top 10 — 지출 유저" subtitle="계산 비용 기준" data={top10Users} labelKey="user" valueKey="cost" valuePrefix="$" />
        )}

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
