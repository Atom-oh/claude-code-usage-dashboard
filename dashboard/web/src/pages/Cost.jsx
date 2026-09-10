import { useEffect, useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { BarTip } from "../components/BarTip.jsx";
import { DonutBody, DonutBreakdown, SeriesBarChart } from "../components/GroupCharts.jsx";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useConfig } from "../ConfigContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { useRange } from "../RangeContext.jsx";
import { makeTickFmt, maskEmail } from "../fmt.js";
import { colorFor, modelColorFor, byModelLegendOrder, groupModelColorFor, makeGroupBreakdownColorer, GROUP_SEGMENT_ORDER } from "../colors.js";
import { useGroupsShown } from "../useGroupsShown.js";
import { effortLabel, unclassifiedLabel } from "../labels.js";
import { asSpendRows, sumSpend, SPEND_HELP } from "../spend.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => n == null || !Number.isFinite(Number(n)) ? "확인 필요" : `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const computedText = (v, r) => r.unpriced ? "단가 미등록" : usd(v);
const computedCsv = (v, r) => r.unpriced ? "" : v;
const spendOrder = (a, b) => (a.cost == null) - (b.cost == null) || b.cost - a.cost;
const sumPair = (a, b) => sumSpend([{ cost: a }, { cost: b }]);
const unavailable = "보고 비용 확인 필요 — 누락되거나 검증되지 않은 보고값이 포함되어 있습니다.";
const agentLabel = (v) => (v === "main" ? "메인 세션" : v);
// bedrock/enterprise로 나뉘는 도넛들(캐시 티어·토큰 타입·Effort)의 라벨 순서 — 그룹 색상 배정이
// 데이터 등장 순서가 아니라 이 고정 순서를 따르게 한다(colors.js makeGroupBreakdownColorer).
const TIER_LABEL_ORDER = ["캐시 읽기", "캐시 쓰기", "출력", "비캐시 입력"];
const TOKEN_TYPE_LABEL_ORDER = ["캐시 읽기", "캐시 쓰기", "출력", "입력"];
const EFFORT_LABEL_ORDER = ["medium", "high", "xhigh", "미지정"];

function foldModelRows(rows) {
  const totals = new Map();
  for (const r of asSpendRows(rows)) {
    const acc = totals.get(r.model) || { model: r.model, cost: 0, computed_cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, unpriced: false };
    acc.cost = sumPair(acc.cost, r.cost);
    acc.computed_cost = sumPair(acc.computed_cost, r.computed_cost);
    acc.unpriced ||= r.unpriced === true || r.computed_cost === null;
    acc.tokens += Number(r.tokens || 0);
    acc.inputTokens += Number(r.input_tokens || 0);
    acc.outputTokens += Number(r.output_tokens || 0);
    totals.set(r.model, acc);
  }
  return [...totals.values()].sort(spendOrder);
}

// 미산정 조각이 섞였다는 표시를 유지해야 양수 부분합을 완전한 보고 비용으로 다시 쓰지 않는다.
function addSpend(acc, row) {
  acc.cost = sumPair(acc.cost, row.cost);
  acc.computed_cost = sumPair(acc.computed_cost, row.computed_cost);
  acc.reported_cost = sumPair(acc.reported_cost, row.reported_cost);
  acc.reported_unpriced = acc.cost === null;
  acc.unpriced ||= row.unpriced === true || row.computed_cost === null;
  acc.tokens += Number(row.tokens || 0);
}

const spendTotal = () => ({ cost: 0, computed_cost: 0, reported_cost: 0, tokens: 0, unpriced: false, reported_unpriced: false });

export function mergeUserModelRows(rows) {
  const totals = new Map();
  for (const r of asSpendRows(rows)) {
    const key = JSON.stringify([r.user, r.model]);
    const acc = totals.get(key) || { user: r.user, model: r.model, ...spendTotal(), groups: {} };
    addSpend(acc, r);
    const group = acc.groups[r.group] || (acc.groups[r.group] = spendTotal());
    addSpend(group, r);
    totals.set(key, acc);
  }
  return [...totals.values()];
}

export function mergeUserRows(rows) {
  const totals = new Map();
  for (const r of asSpendRows(rows)) {
    const acc = totals.get(r.user) || { user: r.user, ...spendTotal(), groups: {} };
    addSpend(acc, r);
    const group = acc.groups[r.group] || (acc.groups[r.group] = { models: {} });
    const model = group.models[r.model] || (group.models[r.model] = spendTotal());
    addSpend(model, r);
    totals.set(r.user, acc);
  }
  return [...totals.values()];
}

// 한 그룹 줄의 모델 세그먼트 목록 — 값 0 모델 제외, 순서는 범례 규칙(byModelLegendOrder) 고정.
export function groupModelSegments(groups, group, metric) {
  const models = groups?.[group]?.models;
  if (!models || (metric === "cost" && sumSpend(Object.values(models)) === null)) return null;
  const segs = Object.entries(models)
    .map(([model, v]) => ({ model, value: Number(v[metric] || 0) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => byModelLegendOrder(a.model, b.model));
  const total = segs.reduce((sum, x) => sum + x.value, 0);
  return total > 0 ? { segs, total } : null;
}

// 셀 툴팁/CSV용 그룹 합계 문자열 — 모델 내역은 각 줄의 hover가, 여기는 그룹 총액만.
export function groupTotalsText(groups, metric) {
  const fmtVal = (v) => (metric === "tokens" ? `${fmt(v)}토큰` : usd(v));
  return GROUP_SEGMENT_ORDER.map((g) => {
    const models = groups?.[g]?.models;
    if (metric === "cost" && models && sumSpend(Object.values(models)) === null) return `${unclassifiedLabel(g)} 확인 필요`;
    const line = groupModelSegments(groups, g, metric);
    return line ? `${unclassifiedLabel(g)} ${fmtVal(line.total)}` : null;
  })
    .filter(Boolean)
    .join(" · ");
}

// 숫자 옆 "그룹별 모델 스택 바 두 줄" — 위 bedrock, 아래 enterprise(+unknown 행이 있으면 세
// 번째 줄). 줄 머리의 점이 그룹 색, 막대의 색 분할은 모델(MODEL_COLOR 공통 팔레트 — 두 그룹이
// 같은 셀에 있으므로 "같은 모델 = 같은 색" 규칙). 줄 길이는 컬럼 공통 분모(max = 전체 행의
// 최대 그룹 줄 합계) 대비라 행 간·줄 간 크기 비교가 성립한다. 값이 없는 그룹 줄은 아예 없다.
function UserGroupModelBars({ groups, metric, max }) {
  const fmtVal = (v) => (metric === "tokens" ? `${fmt(v)}토큰` : usd(v));
  const lines = GROUP_SEGMENT_ORDER.map((g) => ({ group: g, line: groupModelSegments(groups, g, metric) })).filter((x) => x.line);
  if (!lines.length || !(max > 0)) return null;
  return (
    <span className="inline-flex w-36 shrink-0 flex-col gap-[3px] align-middle">
      {lines.map(({ group, line }) => (
        <BarTip
          key={group}
          className="flex items-center gap-1.5"
          label={`${unclassifiedLabel(group)} ${fmtVal(line.total)} — ${line.segs.map((x) => `${x.model} ${fmtVal(x.value)}`).join(" · ")}`}
          tip={
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 font-semibold">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorFor(group) }} />
                {unclassifiedLabel(group)}
                <span className="tabular ml-auto pl-4">{fmtVal(line.total)}</span>
              </span>
              {line.segs.map((x) => (
                <span key={x.model} className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: modelColorFor(x.model) ?? "var(--ink-300)" }} />
                  {x.model}
                  <span className="tabular ml-auto pl-4">{fmtVal(x.value)}</span>
                </span>
              ))}
            </span>
          }
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colorFor(group) }} />
          <span className="h-1.5 min-w-0 flex-1">
            <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(1, (line.total / max) * 100)}%` }}>
              {line.segs.map((x) => (
                // 미등록(비-Claude) 모델은 모델 팔레트 밖 — 잉크 회색으로 물러나고 hover가 이름을 말한다.
                <span key={x.model} style={{ width: `${(x.value / line.total) * 100}%`, minWidth: "1px", background: modelColorFor(x.model) ?? "var(--ink-300)" }} />
              ))}
            </span>
          </span>
        </BarTip>
      ))}
    </span>
  );
}

// 범례는 DataTable의 right 슬롯이 아니라 subtitle에 넣는다 — right에는 이미 'unknown 그룹 포함'
// 체크박스가 있고 DataTable이 거기에 CSV 버튼까지 shrink-0로 감싸므로, 세 번째 항목을 넣으면
// 좁은 폭에서 카드 헤더가 넘친다.
function GroupShareLegend({ groups }) {
  return (
    <span className="inline-flex items-center gap-2">
      {groups.map((g) => (
        <span key={g} className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(g) }} />
          {unclassifiedLabel(g)}
        </span>
      ))}
    </span>
  );
}

export default function Cost() {
  const { groupMode, pricing } = useConfig();
  const ttl = pricing?.cacheWriteTtl === "5m" ? "5분" : pricing?.cacheWriteTtl === "1h" ? "1시간" : "미확인";
  const ttlHint = `캐시 쓰기 TTL 가정: ${ttl}`;
  const computedHelp = `토큰 사용량 × 서버 단가의 진단용 계산값입니다. ${ttlHint}. 실제 요청의 TTL·클라이언트 버전·수집 범위에 따라 보고 비용 및 청구액과 다를 수 있습니다.`;
  const shownGroups = useGroupsShown();
  const { intervalHours: defaultIntervalHours, days, from, to } = useRange();
  const { model } = useFilters();
  const [intervalHours, setIntervalHours] = useState(defaultIntervalHours);
  const [topN, setTopN] = useState(20);
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
  // 표시용 per-user 테이블만 unknown 그룹 포함 뷰로 전환한다. 위 byUserModel을 쓰는 지출 유저
  // 랭킹과 서버의 userCostEfficiency는 A/B 조인 소비자라 기본(제외) 뷰를 계속 써야 한다 —
  // index.js의 /api/cost/by-user-model 주석에 있는 정책 그대로.
  // 체크가 꺼져 있으면 이 호출은 위와 문자 그대로 같은 요청이라 서버 TTL 캐시에 히트한다.
  // 항상 includeUnknown=1을 받아두는 대안은 warmer가 데우지 않는 콜드 뷰를 매 방문마다 긁게 만든다.
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const byUserModelTable = useApi("/api/cost/by-user-model", includeUnknown ? { includeUnknown: "1" } : {});
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
  const effortMix = useApi("/api/cost/effort-mix");
  const agentCost = useApi("/api/cost/by-agent");
  const summaryRows = asSpendRows(summary.data);
  const dailyRows = asSpendRows(byModelDaily.data);
  const effortRows = asSpendRows(effortMix.data);
  const agentRows = asSpendRows(agentCost.data).sort(spendOrder).slice(0, 15);
  const prevCostByModel = new Map(asSpendRows(compare.data).map((r) => [r.model, r.prev_cost]));

  const totals = summaryRows.reduce(
    (acc, r) => ({
      ...acc,
      input: acc.input + Number(r.input_tokens),
      output: acc.output + Number(r.output_tokens),
      cacheRead: acc.cacheRead + Number(r.cache_read_tokens),
      cacheWrite: acc.cacheWrite + Number(r.cache_write_tokens),
      unpricedTokens: acc.unpricedTokens + Number(r.unpriced_tokens),
      sessions: acc.sessions + Number(r.sessions),
    }),
    { cost: sumSpend(summaryRows), computed: sumSpend(summaryRows, "computed_cost"), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, sessions: 0 }
  );

  const modelTotals = foldModelRows(byModel.data || []);
  const totalModelCost = sumSpend(modelTotals);
  const modelRows = modelTotals.map((r) => {
    const prev = prevCostByModel.get(r.model);
    return {
      ...r,
      share: r.cost === null || totalModelCost === null ? null : totalModelCost > 0 ? r.cost / totalModelCost * 100 : 0,
      change: r.cost === null || prev == null || prev <= 0 ? null : (r.cost - prev) / prev * 100,
    };
  });

  const mergedUserModel = mergeUserModelRows(byUserModel.data || []);
  const userRows = mergeUserRows(byUserModelTable.data || []).sort(spendOrder);
  // 범례는 실제로 등장한 그룹만 — 'unknown 그룹 포함'을 켰는데 unknown 행이 없으면 unknown 점을
  // 띄우지 않는다(막대에도 안 나오므로 범례에도 없어야 한다).
  const shareGroups = GROUP_SEGMENT_ORDER.filter((g) => userRows.some((r) => r.groups?.[g]));
  // 스택 바 줄 길이의 공통 분모(컬럼별) — 전체 행에서 한 그룹 줄이 가질 수 있는 최대 합계.
  const lineMax = (metric) =>
    userRows.reduce((m, r) => Math.max(m, ...GROUP_SEGMENT_ORDER.map((g) => groupModelSegments(r.groups, g, metric)?.total || 0)), 0);
  const costLineMax = lineMax("cost");
  const tokenLineMax = lineMax("tokens");

  const rankedUsers = mergeUserRows(byUserModel.data || []);
  const unavailableUsers = rankedUsers.filter((r) => r.cost === null).length;
  const topUsers = rankedUsers.filter((r) => r.cost !== null).sort(spendOrder).slice(0, topN);

  // pivotByKey는 자체 정렬/제한이 없고 행의 등장 순서를 그대로 유지한다(비-날짜 xKey일 때) — 그래서
  // topUsers(지출 내림차순)를 순회하며 그 유저의 행만 그 순서로 모아야 스택 바도 지출 순으로 나온다.
  const topUserModelRows = topUsers.flatMap((u) =>
    mergedUserModel.filter((r) => r.user === u.user && r.cost !== null)
  );

  // bedrock/enterprise 도넛은 그룹=색상 계열 규칙을 따른다(사용자 지시) — 같은 모델이라도
  // bedrock 카드에선 블루, enterprise 카드에선 틸로 다르게 보인다(groupModelColorFor). 모델
  // 정체성은 그 계열 안의 명도로 표현되지, 색조(hue)로 표현되지 않는다 — 그룹이 우선.
  const modelRowsFor = (group) => foldModelRows((byModel.data || []).filter((r) => r.group === group));

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
  const projection30d = totals.cost === null ? null : (totals.cost / daysInRange) * 30;
  const developerCount = activeUsers.data?.users ?? 0;
  const spendPerDeveloper = totals.cost !== null && developerCount > 0 ? totals.cost / developerCount : null;
  // model 필터가 켜져 있으면 totals.cost(costSummary, modelMixed로 model 필터 적용)와
  // developerCount(activeUsers, model 필터 미적용 — People 섹션 규칙)의 모수 축이 어긋난다 —
  // "이 모델 지출 / 전체 개발자"가 되어 실제보다 낮게 나온다(리뷰에서 MAJOR로 확인). 정확한
  // model-aware 분모가 없으므로, 필터가 켜진 상태에선 오해를 막기 위해 힌트로 명시한다.
  const spendPerDeveloperHint = model
    ? `${fmt(developerCount)}명 기준 — model 필터가 켜져 있어 분자만 필터링됨(참고용)`
    : `${fmt(developerCount)}명 기준`;

  // A/B 비교의 핵심 지표 — 그룹별 총지출은 그룹의 사용자 수가 다르면 비교가 안 되므로
  // 사용자당 평균으로 정규화한다. 분자는 summary(그룹별 보고 비용), 분모는 activeUsers의
  // 그룹별 uniq — 위 spendPerDeveloper와 같은 모수 규칙(excludeUnknown:false)을 그대로 따른다.
  const groupUserCount = (g) => Number(activeUsers.data?.[`${g}_users`] ?? 0);
  const groupCost = (g) => sumSpend(summaryRows.filter((r) => r.group === g));
  const spendPerUserFor = (g) => (groupCost(g) !== null && groupUserCount(g) > 0 ? groupCost(g) / groupUserCount(g) : null);

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

  const effortOrder = (e) => {
    const i = EFFORT_LABEL_ORDER.indexOf(e);
    return i === -1 ? EFFORT_LABEL_ORDER.length : i;
  };
  const effortRowsFor = (group) =>
    effortRows
      .filter((r) => r.group === group)
      .map((r) => ({ ...r, effort: effortLabel(r.effort) }))
      .sort((a, b) => effortOrder(a.effort) - effortOrder(b.effort));

  // LOC 없이 커밋만 있는 사용자도 유지하며 보고 단위 비용 미확인 행은 마지막에 둔다.
  const efficiencyRows = asSpendRows(efficiency.data)
    .filter((r) => r.loc > 0 || r.commits > 0)
    .map((r) => ({
      ...r,
      cost_per_loc: r.reported_unpriced ? null : r.cost_per_loc,
      cost_per_commit: r.reported_unpriced ? null : r.cost_per_commit,
      computed_cost_per_loc: !r.unpriced && r.computed_cost !== null && r.loc > 0 ? r.computed_cost / r.loc : null,
      computed_cost_per_commit: !r.unpriced && r.computed_cost !== null && r.commits > 0 ? r.computed_cost / r.commits : null,
    }))
    .sort((a, b) => (a.cost_per_loc == null) - (b.cost_per_loc == null) || a.cost_per_loc - b.cost_per_loc);

  return (
    <div>
      <PageHeader
        title="Cost"
        subtitle="Claude Code 보고 비용 기준 추정 지출 · 토큰 단가 계산값은 진단용"
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
              label="총 비용"
              value={usd(totals.cost)}
              variant="accent"
              help={SPEND_HELP}
              hint={totals.cost === null ? "보고값 누락 또는 부분 수집" : "선택 기간 보고 비용 · 미분류 채널 포함"}
            />
            <StatTile
              label="토큰 단가 계산 비용"
              value={usd(totals.computed)}
              help={computedHelp}
              hint={`${ttlHint}${totals.unpricedTokens > 0 ? ` · 단가 미등록 토큰 ${fmt(totals.unpricedTokens)}개 제외` : ""}`}
            />
            <StatTile label="입력 토큰" value={fmt(totals.input)} />
            <StatTile label="출력 토큰" value={fmt(totals.output)} help="Thinking 토큰이 포함됩니다." />
            <StatTile label="캐시 읽기 토큰" value={fmt(totals.cacheRead)} />
            <StatTile label="캐시 쓰기 토큰" value={fmt(totals.cacheWrite)} />
            <StatTile label="세션" value={fmt(totals.sessions)} />
            <StatTile
              label="30일 예상 비용"
              value={usd(projection30d)}
              help="선택한 기간의 일평균 비용을 30일 기준으로 환산한 값입니다."
              hint="선택 기간의 일평균을 30일로 환산"
            />
            {/* developerCount/spendPerDeveloper는 activeUsers에서 나온다 — summary만 게이트하면
                activeUsers가 아직 로딩 중이거나 에러여도 "$0 / 0명 기준"이 실제 값처럼 보인다. */}
            <StatTile label="개발자당 비용" value={usd(spendPerDeveloper)} hint={spendPerDeveloperHint} />
            {/* A/B 비교용 — 총지출이 아니라 사용자당 평균이라야 그룹 간 사용자 수 차이가 상쇄된다.
                전체(개발자당 지출)는 그룹 합이 아니다: 한 유저가 두 그룹에 걸칠 수 있어(세션 단위
                판별, grouping.js) 전역 uniq 분모가 그룹 분모의 합보다 작을 수 있다. */}
            {shownGroups(summary.data).map((g) => (
              <StatTile
                key={g}
                // 그룹 색 틴트 — 두 타일이 나란히 있어 라벨만으로는 구분이 약하다. Users.jsx의
                // GroupFaceOff와 같은 8% color-mix 패턴이되, 카드가 페이지 배경 위에 직접 놓이므로
                // transparent가 아니라 surface-card와 섞어 불투명하게 유지한다.
                style={{
                  background: `color-mix(in srgb, ${colorFor(g)} 8%, var(--surface-card))`,
                  borderColor: `color-mix(in srgb, ${colorFor(g)} 35%, var(--surface-card))`,
                }}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: colorFor(g) }} />
                    {`사용자당 비용 — ${g}`}
                  </span>
                }
                value={usd(spendPerUserFor(g))}
                hint={
                  model
                    ? `사용자 ${fmt(groupUserCount(g))}명 기준, 모델 필터는 비용에만 적용`
                    : `사용자 ${fmt(groupUserCount(g))}명 · 총 비용 ${usd(groupCost(g))}`
                }
              />
            ))}
          </div>
        )}

        {tiers.loading || cacheEff.loading ? (
          <Loading />
        ) : tiers.error || cacheEff.error ? (
          <ErrorBox error={tiers.error || cacheEff.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(Object.keys(tiers.data || {}).map((group) => ({ group }))).map((g) => (
              <DonutBreakdown
                key={g}
                title={`토큰 유형별 계산 비용 — ${g}`}
                subtitle={`${ttlHint}${unpricedTokensFor(g) > 0 ? ` · 단가 미등록 토큰 ${fmt(unpricedTokensFor(g))}개 제외` : ""}`}
                help={computedHelp}
                right={<Badge tone="brand">캐시율 {(cacheRatioFor(g) * 100).toFixed(1)}%</Badge>}
                data={tierRowsFor(g)}
                nameKey="tier"
                valueKey="cost"
                valuePrefix="$"
                colorOf={makeGroupBreakdownColorer(g, TIER_LABEL_ORDER)}
              />
            ))}
          </div>
        )}

        {effortMix.loading ? (
          <Loading />
        ) : effortMix.error ? (
          <ErrorBox error={effortMix.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(effortMix.data).map((g) => (
              <Card
                key={g}
                title={`Effort 수준별 비용 — ${g}`}
                help={`${SPEND_HELP} Effort 정보가 없으면 미지정으로 묶습니다. Thinking 토큰은 출력 토큰에 포함됩니다. ${computedHelp}`}
              >
                {sumSpend(effortRowsFor(g)) === null ? <p className="text-sm text-ink-400">{unavailable}</p> : <DonutBody
                  data={effortRowsFor(g)}
                  nameKey="effort"
                  valueKey="cost"
                  valuePrefix="$"
                  colorOf={makeGroupBreakdownColorer(g, EFFORT_LABEL_ORDER)}
                />}
                <ul className="mt-3 text-[12px] text-ink-400">
                  {effortRowsFor(g).map((r) => (
                    <li key={r.effort}>{`${effortLabel(r.effort)}: ${usd(r.cost)} (계산값 ${usd(r.computed_cost)}${r.unpriced_tokens > 0 ? "; 단가 미등록 토큰 제외" : ""})`}</li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {byModel.loading ? (
            <Loading />
          ) : byModel.error ? (
            <ErrorBox error={byModel.error} />
          ) : (
            shownGroups(byModel.data).map((g) => (
              <Card key={g} title={`모델별 비용 비중 — ${g}`} help={SPEND_HELP}>
                {sumSpend(modelRowsFor(g)) === null ? <p className="text-sm text-ink-400">{unavailable}</p> : <DonutBody data={modelRowsFor(g)} nameKey="model" valueKey="cost" valuePrefix="$" colorOf={(name) => groupModelColorFor(g, name)} />}
              </Card>
            ))
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {summary.loading ? (
            <Loading />
          ) : summary.error ? (
            <ErrorBox error={summary.error} />
          ) : (
            shownGroups(summary.data).map((g) => (
              <DonutBreakdown
                key={g}
                title={`토큰 유형별 사용량 — ${g}`}
                data={tokenTypeRowsFor(g)}
                nameKey="type"
                valueKey="tokens"
                colorOf={makeGroupBreakdownColorer(g, TOKEN_TYPE_LABEL_ORDER)}
              />
            ))
          )}
        </div>

        {byModelDaily.loading ? (
          <Loading />
        ) : byModelDaily.error ? (
          <ErrorBox error={byModelDaily.error} />
        ) : (
          <SeriesBarChart
            title="모델별 비용 추이"
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
            rows={dailyRows}
            subtitle={dailyRows.some((r) => r.cost === null) ? "보고 비용 확인 필요 구간 포함" : undefined}
            help={SPEND_HELP}
            xKey="day"
            seriesKey="model"
            valueKey="cost"
            colorOf={modelColorFor}
            seriesSort={byModelLegendOrder}
            tickFormatter={fmtTick}
            valuePrefix="$"
            bucketHours={intervalHours}
          />
        )}

        <DataTable
          title="모델별 비용과 토큰"
          subtitle="비용 기준 정렬"
          help={`${SPEND_HELP} 이전 기간 대비는 같은 길이의 직전 기간 보고 비용과 비교합니다. ${computedHelp}`}
          columns={[
            { key: "model", label: "모델" },
            { key: "cost", label: "비용", render: usd },
            { key: "computed_cost", label: "토큰 단가 계산값", render: computedText, toText: computedCsv },
            { key: "share", label: "전체 대비", render: (v) => v === null ? "확인 필요" : `${v.toFixed(1)}%`, toText: (v) => v === null ? "" : `${v.toFixed(1)}%` },
            {
              key: "change",
              label: "이전 기간 대비",
              render: (v) => v === null ? "확인 필요" : <Badge tone={v >= 0 ? "positive" : "negative"}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</Badge>,
              toText: (v) => v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
            },
            { key: "inputTokens", label: "입력 토큰", render: fmt },
            { key: "outputTokens", label: "출력 토큰", render: fmt },
          ]}
          rows={modelRows}
          groupKey="__none__"
          exportName="cost_by_model"
        />

        {agentCost.loading ? (
          <Loading />
        ) : agentCost.error ? (
          <ErrorBox error={agentCost.error} />
        ) : (
          <DataTable
            title="에이전트별 비용"
            subtitle="API가 제공한 에이전트 중 보고 비용 상위 15개"
            help={`에이전트가 지정되지 않은 사용량은 메인 세션으로 표시합니다. ${SPEND_HELP} ${computedHelp}`}
            columns={[
              { key: "agent", label: "에이전트", render: agentLabel, toText: agentLabel },
              { key: "group", label: "채널" },
              { key: "cost", label: "비용", render: usd },
              { key: "computed_cost", label: "토큰 단가 계산값", render: computedText, toText: computedCsv },
              { key: "tokens", label: "토큰", render: fmt },
            ]}
            rows={agentRows}
            exportName="cost_by_agent"
          />
        )}

        {byUserModel.loading ? (
          <Loading />
        ) : byUserModel.error ? (
          <ErrorBox error={byUserModel.error} />
        ) : (
          <SeriesBarChart
            title={`비용 상위 사용자 ${topN}명`}
            subtitle={`모델별 보고 비용 구성${unavailableUsers ? ` · 보고 비용 확인 필요 사용자 ${unavailableUsers}명 제외` : ""}`}
            help={`미분류 채널은 제외됩니다. 단가 미등록 모델도 유효한 보고 비용은 포함합니다. ${SPEND_HELP}`}
            right={
              <SegmentedControl
                options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: String(n) }))}
                value={String(topN)}
                onChange={(v) => setTopN(Number(v))}
              />
            }
            rows={topUserModelRows}
            xKey="user"
            seriesKey="model"
            valueKey="cost"
            colorOf={modelColorFor}
            seriesSort={byModelLegendOrder}
            valuePrefix="$"
            tickFormatter={maskEmail}
            horizontal
          />
        )}

        {byUserModelTable.loading ? (
          <Loading />
        ) : byUserModelTable.error ? (
          <ErrorBox error={byUserModelTable.error} />
        ) : (
          <DataTable
            title="사용자 · 모델별 비용"
            // single 모드에선 그룹 줄 구분이 무의미해 막대를 빼므로 부제도 막대/범례를 말하지 않는다.
            subtitle={
              groupMode === "single" ? (
                "사용자 단위로 합산"
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  사용자 단위로 합산 · 막대의 줄은 채널, 색은 모델
                  <GroupShareLegend groups={shareGroups} />
                </span>
              )
            }
            help={
              groupMode === "single"
                ? `미분류 채널은 체크박스로 포함할 수 있습니다. ${SPEND_HELP} ${computedHelp}`
                : `같은 사용자가 두 채널을 모두 사용하면 한 행으로 합칩니다. 비용 옆 막대의 줄은 채널, 색은 모델입니다. 단가 미등록 모델도 유효한 보고 비용은 포함합니다. 미분류 채널은 체크박스로 포함할 수 있습니다. ${SPEND_HELP} ${computedHelp}`
            }
            right={
              <label className="flex items-center gap-1.5 text-[12px] text-ink-600 select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeUnknown}
                  onChange={(e) => setIncludeUnknown(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-ink-200 accent-brand-500"
                />
                미분류 포함
              </label>
            }
            columns={[
              { key: "user", label: "사용자", render: maskEmail },
              // 스택 바 두 줄은 숫자 옆에 산다(사용자 지정) — 행 그레인이 사용자라 모델 축은
              // 이 막대(색 분할)와 hover가 나른다. single 모드에선 그룹 줄이 하나뿐이라 숫자만.
              {
                key: "cost",
                label: "비용",
                render: (_v, r) => (
                  <span className="inline-flex items-center gap-3">
                    <span className="min-w-[4.5rem]">{usd(r.cost)}</span>
                    {groupMode !== "single" && <UserGroupModelBars groups={r.groups} metric="cost" max={costLineMax} />}
                  </span>
                ),
                toText: (_v, r) => {
                  if (r.cost === null) return "";
                  if (groupMode === "single") return r.cost;
                  const split = groupTotalsText(r.groups, "cost");
                  return split ? `${usd(r.cost)} — ${split}` : usd(r.cost);
                },
              },
              { key: "computed_cost", label: "토큰 단가 계산값", render: computedText, toText: computedCsv },
              {
                key: "tokens",
                label: "토큰",
                render: (v, r) => (
                  <span className="inline-flex items-center gap-3">
                    <span className="min-w-[5.5rem]">{fmt(v)}</span>
                    {groupMode !== "single" && <UserGroupModelBars groups={r.groups} metric="tokens" max={tokenLineMax} />}
                  </span>
                ),
                toText: (v, r) => {
                  const split = groupTotalsText(r.groups, "tokens");
                  return split ? `${fmt(v)} — ${split}` : fmt(v);
                },
              },
            ]}
            rows={userRows}
            exportName="cost_by_user"
          />
        )}

        {efficiency.loading ? (
          <Loading />
        ) : efficiency.error ? (
          <ErrorBox error={efficiency.error} />
        ) : (
          <DataTable
            title="비용 효율 ($/LOC · $/커밋)"
            subtitle="코드 라인당 비용이 낮은 순"
            help={`추가된 코드 라인과 커밋 수로 보고 비용을 나눕니다. 개인 성과 평가용이 아닌 참고 지표이며 보고값 미확인 사용자는 맨 아래에 표시합니다. ${SPEND_HELP} ${computedHelp}`}
            columns={[
              { key: "user", label: "사용자", render: maskEmail },
              { key: "group", label: "채널" },
              { key: "cost", label: "비용", render: usd },
              { key: "loc", label: "추가 코드 라인", render: fmt },
              { key: "commits", label: "커밋", render: fmt },
              { key: "cost_per_loc", label: "$/LOC", render: (v) => (v == null ? "확인 필요" : `$${Number(v).toFixed(4)}`) },
              { key: "cost_per_commit", label: "$/커밋", render: usd },
              { key: "computed_cost", label: "토큰 단가 계산값", render: computedText, toText: computedCsv },
              { key: "computed_cost_per_loc", label: "계산 $/LOC", render: (v) => (v == null ? "확인 필요" : `$${Number(v).toFixed(4)}`) },
              { key: "computed_cost_per_commit", label: "계산 $/커밋", render: usd },
            ]}
            rows={efficiencyRows}
            exportName="cost_efficiency_by_user"
          />
        )}
      </div>
    </div>
  );
}
