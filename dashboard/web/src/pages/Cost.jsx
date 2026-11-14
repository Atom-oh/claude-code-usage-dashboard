import { richMessage, localeTag, localize, translate, translateSource, useLocale } from "../i18n/index.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../components/Badge.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { BarTip } from "../components/BarTip.jsx";
import { DonutBody, DonutBreakdown, SeriesBarChart } from "../components/GroupCharts.jsx";
import { ModelCostTrend } from "../components/ModelCostTrend.jsx";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useConfig } from "../ConfigContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { useRange } from "../RangeContext.jsx";
import { maskEmail } from "../fmt.js";
import { isZeroTokenModel } from "../modelRows.js";
import { colorFor, modelColorFor, byModelLegendOrder, groupModelColorFor, makeGroupBreakdownColorer, GROUP_SEGMENT_ORDER } from "../colors.js";
import { useGroupsShown } from "../useGroupsShown.js";
import { CostBreakdownCard, ZeroCostRows } from "../components/CostBreakdowns.jsx";
import { effortLabel, unclassifiedLabel } from "../labels.js";
import { asCostSummaryRows, asKnownSpendRows, asSpendRows, sumKnownSpend, sumSpend, SPEND_HELP } from "../spend.js";
import { fromByModelDaily, modelLabel } from "../modelCostTrend.js";
import { priceSourceText } from "../pricingSource.js";
import { teamSuffix, useTeams, withTeamColumn, withTeams } from "../TeamsContext.jsx";
import { TeamCostSection } from "../components/TeamCostSection.jsx";

const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
const usd = (n) => n == null || !Number.isFinite(Number(n)) ? translate("m84dd6e381dca") : `$${Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;
const computedText = (v, r) => r.unpriced ? translate("mc24cf23e364f") : usd(v);
const computedCsv = (v, r) => r.unpriced ? "" : v;
const spendOrder = (a, b) => (a.cost == null) - (b.cost == null) || b.cost - a.cost;
const sumPair = (a, b) => sumSpend([{ cost: a }, { cost: b }]);
const unavailable = "보고 비용 확인 필요 — 누락되거나 검증되지 않은 보고값이 포함되어 있습니다.";
const costStatus = (r) => (r.cost_partial ? translate("md15c830a6f1c") : r.cost === null ? translate("m84dd6e381dca") : translate("mf2c10bf5d512"));
const costStatusColumn = localize({ key: "cost_status", label: "비용 상태" });
// 알려진 보고 비용 부분합은 금액 옆 배지로 밝힌다. CSV는 render를 쓰지 않으므로 숫자 그대로 나간다.
const knownUsd = (v, r) =>
  r.cost_partial ? (
    <span className="inline-flex items-center gap-1.5">
      {usd(v)}
      <Badge tone="warning">{translate("md15c830a6f1c")}</Badge>
    </span>
  ) : (
    usd(v)
  );
// 부분합 비용에서 나온 단위 값($/LOC·$/커밋)도 같은 배지로 밝힌다. CSV는 숫자 그대로 나간다.
const partialUnit = (text, r) =>
  r.cost_partial ? (
    <span className="inline-flex items-center gap-1.5">
      {text}
      <Badge tone="warning">{translate("md15c830a6f1c")}</Badge>
    </span>
  ) : (
    text
  );
const agentLabel = (v) => (v === "main" ? translate("m532fa5422839") : v);
// bedrock/enterprise로 나뉘는 도넛들(캐시 티어·토큰 타입·Effort)의 라벨 순서 — 그룹 색상 배정이
// 데이터 등장 순서가 아니라 이 고정 순서를 따르게 한다(colors.js makeGroupBreakdownColorer).
const TIER_LABEL_ORDER = localize(["캐시 읽기", "캐시 쓰기", "출력", "비캐시 입력"]);
const TOKEN_TYPE_LABEL_ORDER = localize(["캐시 읽기", "캐시 쓰기", "출력", "입력"]);
const EFFORT_LABEL_ORDER = localize(["medium", "high", "xhigh", "미지정"]);

function ReportedCostDonut({ rows, nameKey, colorOf, listUnknown = false, listZero = false }) {
  const _locale = useLocale();
  if (rows.length === 0) return <EmptyState />;
  const { total, partial } = sumKnownSpend(rows);
  const known = rows.filter((r) => r.cost !== null && r.cost !== 0);
  return (
    <>
      {partial && <p className="mb-3 text-sm text-ink-500">{translate("mbf031b077927")}</p>}
      {total === null ? <p className="text-sm text-ink-400">{translateSource(unavailable)}</p>
        : total === 0 ? <p className="tabular text-sm text-ink-600">{usd(total)}</p>
          : <DonutBody data={known} nameKey={nameKey} valueKey="cost" valueFormatter={usd} colorOf={colorOf} />}
      {listZero && <ZeroCostRows rows={rows.filter((r) => r.cost === 0)}
        label={(r) => `${r[nameKey]}${r.cost_partial ? translate("m830e860c2bd2") : ""}`} />}
      {listUnknown && rows.some((r) => r.cost === null) && (
        <ul className="mt-3 text-[12px] text-ink-400">
          {rows.filter((r) => r.cost === null).map((r) => <li key={r[nameKey]}>{richMessage("m04073e2d2e64", [r[nameKey]])}</li>)}
        </ul>
      )}
    </>
  );
}

// ADR-013 known subtotal: an unusable piece is never $0 — null + null stays null and null + x is x.
// cost_partial marks a non-null subtotal that excludes an unusable or partial piece. A fresh
// accumulator's cost is undefined (no piece yet), so its first piece is taken as-is.
function addKnownCost(acc, row) {
  const { total, partial } = sumKnownSpend(acc.cost === undefined ? [row] : [acc, row]);
  acc.cost = total;
  acc.cost_partial = partial;
}

function foldModelRows(rows) {
  const totals = new Map();
  for (const r of asKnownSpendRows(rows)) {
    // Preserve legacy API rows; explicitly historical-only model evidence is not current use.
    if (r.observed_usage_rows === 0 || r.observed_usage_rows === "0") continue;
    const acc = totals.get(r.model) || { model: r.model, cost: undefined, cost_partial: false, computed_cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, unpriced: false };
    addKnownCost(acc, r);
    acc.computed_cost = sumPair(acc.computed_cost, r.computed_cost);
    acc.unpriced ||= r.unpriced === true || r.computed_cost === null;
    acc.tokens += Number(r.tokens || 0);
    acc.inputTokens += Number(r.input_tokens || 0);
    acc.outputTokens += Number(r.output_tokens || 0);
    // Judged on the raw rows: the fold above coerces unknown token counts to 0.
    acc.zeroTokens = (acc.zeroTokens ?? true) && isZeroTokenModel(r);
    totals.set(r.model, acc);
  }
  return [...totals.values()].sort(spendOrder);
}

// cost/reported_cost는 알려진 보고 비용 부분합이고 cost_partial이 미산정 조각을 밝힌다 — 다시
// asSpendRows를 거쳐도(...row) 부분합 표시가 남아 완전한 보고 비용으로 읽히지 않는다.
// computed_cost는 진단값이라 기존처럼 조각 하나만 없어도 null이다.
function addSpend(acc, row) {
  addKnownCost(acc, row);
  acc.computed_cost = sumPair(acc.computed_cost, row.computed_cost);
  acc.reported_cost = acc.cost;
  acc.reported_unpriced = acc.cost === null;
  acc.unpriced ||= row.unpriced === true || row.computed_cost === null;
  acc.tokens += Number(row.tokens || 0);
}

const spendTotal = () => ({ cost: undefined, cost_partial: false, computed_cost: 0, reported_cost: 0, tokens: 0, unpriced: false, reported_unpriced: false });

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

// 모델 하나의 사용자별 보고 비용 비중 — by-user-model 한 응답만으로 계산한다. by-model과 섞으면 두 응답이
// 따로 도착하는 사이(기간 변경·백그라운드 새로고침의 창 이동) 서로 다른 시점의 합계끼리 차액이 꾸며진다
// (PR #178 리뷰). 분모는 그 모델의 알려진 사용자 비용 합계이고, 사용자 ID가 없는 사용량은 들어 있지 않다.
export function modelUserShares(userModelRows, model) {
  const users = userModelRows.filter((r) => r.model === model).sort(spendOrder);
  const { total, partial } = sumKnownSpend(users);
  const share = (cost) => cost === null || total === null ? null : total > 0 ? cost / total * 100 : 0;
  return {
    rows: users.map((r) => ({ user: r.user, cost: r.cost, cost_partial: r.cost_partial, tokens: r.tokens, share: share(r.cost) })),
    total,
    partial,
  };
}

function ModelUserPanel({ modelRow, userModelRows, loading, error, onClose }) {
  const _locale = useLocale();
  const teams = useTeams();
  const close = (
    <button type="button" onClick={onClose} aria-label={translate("mcae65762e175")} className="text-[12px] text-ink-500 hover:text-ink-800">{translate("mb5fe570a7d09")}</button>
  );
  const title = translate("m1fdbf829aed8", [modelLabel(modelRow.model)]);
  if (loading) return <Card title={title} right={close}><Loading /></Card>;
  if (error) return <Card title={title} right={close}><ErrorBox error={error} /></Card>;
  const { rows, total, partial } = modelUserShares(userModelRows, modelRow.model);
  return (
    <Card
      title={title}
      subtitle={translate("m8d3c93ebf7f7", [usd(total), partial ? translate("m1d42633eb6fd") : "", rows.length])}
      help={translate("m3695eec5c658", [translateSource(SPEND_HELP)])}
      right={close}
      padded={false}
    >
      {rows.length === 0 ? (
        <div className="p-4"><EmptyState /></div>
      ) : (
        <ul className="max-h-[28rem] overflow-y-auto divide-y divide-ink-100">
          {rows.map((r) => (
            <li key={r.user} className="px-4 py-2 text-[13px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-ink-800">{maskEmail(r.user)}{teamSuffix(teams, r.user)}</span>
                <span className="shrink-0 tabular text-ink-800">
                  {knownUsd(r.cost, r)}
                  <span className="ml-2 inline-block min-w-[3.5rem] text-right text-ink-500">{r.share === null ? translate("m84dd6e381dca") : `${r.share.toFixed(1)}%`}</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-ink-100">
                <div className="h-1.5 rounded" style={{ width: `${Math.min(100, Math.max(0, r.share || 0))}%`, background: modelColorFor(modelLabel(modelRow.model)) || "var(--chart-1)" }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
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
// 비용 줄은 알려진 모델 보고값만 그리고, 미산정·부분합 모델이 있으면 partial로 밝힌다.
export function groupModelSegments(groups, group, metric) {
  const models = groups?.[group]?.models;
  if (!models) return null;
  const segs = Object.entries(models)
    .map(([model, v]) => ({ model, value: Number(v[metric] || 0) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => byModelLegendOrder(a.model, b.model));
  const total = segs.reduce((sum, x) => sum + x.value, 0);
  const partial = metric === "cost" && Object.values(models).some((v) => v.cost === null || v.cost_partial === true);
  return total > 0 ? { segs, total, partial } : null;
}

// 셀 툴팁/CSV용 그룹 합계 문자열 — 모델 내역은 각 줄의 hover가, 여기는 그룹 총액만.
export function groupTotalsText(groups, metric) {
  const fmtVal = (v) => (metric === "tokens" ? translate("m3775564a0c42", [fmt(v)]) : usd(v));
  return GROUP_SEGMENT_ORDER.map((g) => {
    const models = groups?.[g]?.models;
    if (metric === "cost" && models && sumKnownSpend(Object.values(models)).total === null) return translate("m1d65372ce08c", [unclassifiedLabel(g)]);
    const line = groupModelSegments(groups, g, metric);
    return line ? `${unclassifiedLabel(g)} ${fmtVal(line.total)}${line.partial ? translate("m830e860c2bd2") : ""}` : null;
  })
    .filter(Boolean)
    .join(" · ");
}

// 숫자 옆 "그룹별 모델 스택 바 두 줄" — 위 bedrock, 아래 enterprise(+unknown 행이 있으면 세
// 번째 줄). 줄 머리의 점이 그룹 색, 막대의 색 분할은 모델(MODEL_COLOR 공통 팔레트 — 두 그룹이
// 같은 셀에 있으므로 "같은 모델 = 같은 색" 규칙). 줄 길이는 컬럼 공통 분모(max = 전체 행의
// 최대 그룹 줄 합계) 대비라 행 간·줄 간 크기 비교가 성립한다. 값이 없는 그룹 줄은 아예 없다.
function UserGroupModelBars({ groups, metric, max }) {
  const _locale = useLocale();
  const fmtVal = (v) => (metric === "tokens" ? translate("m3775564a0c42", [fmt(v)]) : usd(v));
  const lines = GROUP_SEGMENT_ORDER.map((g) => ({ group: g, line: groupModelSegments(groups, g, metric) })).filter((x) => x.line);
  if (!lines.length || !(max > 0)) return null;
  return (
    <span className="inline-flex w-36 shrink-0 flex-col gap-[3px] align-middle">
      {lines.map(({ group, line }) => (
        <BarTip
          key={group}
          className="flex items-center gap-1.5"
          label={`${unclassifiedLabel(group)} ${fmtVal(line.total)}${line.partial ? translate("m830e860c2bd2") : ""} — ${line.segs.map((x) => `${modelLabel(x.model)} ${fmtVal(x.value)}`).join(" · ")}`}
          tip={
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 font-semibold">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorFor(group) }} />
                {unclassifiedLabel(group)}
                <span className="tabular ml-auto pl-4">{`${fmtVal(line.total)}${line.partial ? translate("m830e860c2bd2") : ""}`}</span>
              </span>
              {line.segs.map((x) => (
                <span key={x.model} className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: modelColorFor(x.model) ?? "var(--ink-300)" }} />
                  {modelLabel(x.model)}
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
  const _locale = useLocale();
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
  const _locale = useLocale();
  const { groupMode, pricing } = useConfig();
  const ttl = pricing?.cacheWriteTtl === "5m" ? translate("m9d5ea7923d6c") : pricing?.cacheWriteTtl === "1h" ? translate("m643ab66e580f") : translate("mdc0c487c9693");
  const ttlHint = translate("m611d3ca652f2", [ttl]);
  const priceSource = priceSourceText(pricing?.priceList);
  const computedHelp = translate("mfa878718a7b5", [ttlHint, priceSource]);
  const shownGroups = useGroupsShown();
  const { intervalHours: defaultIntervalHours, days, from, to } = useRange();
  const { model, group, user, project, backend, team } = useFilters();
  const [intervalHours, setIntervalHours] = useState(defaultIntervalHours);
  const [topN, setTopN] = useState(20);
  const [showComputed, setShowComputed] = useState(false);
  const comparisonHelp = showComputed ? computedHelp : "";
  // 전역 기간 프리셋(RangePicker)이 바뀌면 이 페이지의 로컬 granularity도 기본값으로 재동기화 —
  // 안 그러면 7일 보다가 1일로 바꿔도 "일간" 버킷에 머문다. days도 dependency에 넣는다: 주간(168)을
  // 수동 선택한 뒤 30일→7일로 바꾸면 defaultIntervalHours(24)는 불변이라 effect가 안 돌아 주간 버킷이
  // 남는데(7일=바 1개), days가 바뀌므로 이때도 기본 granularity로 리셋된다.
  // from/to의 getTime()도 필요하다 — 드래그 줌으로 커스텀 구간을 옮겨도(days는 프리셋 전용이라
  // 안 바뀌고 defaultIntervalHours도 같은 해상도로 우연히 같은 값이면) effect가 재실행되지 않아
  // 이 페이지의 차트만 옛 구간의 intervalHours에 머문다(리뷰에서 MINOR로 확인).
  useEffect(() => setIntervalHours(defaultIntervalHours), [defaultIntervalHours, days, from.getTime(), to.getTime()]);
  const summary = useApi("/api/cost/summary");
  const byModel = useApi("/api/cost/by-model");
  const byUserModel = useApi("/api/cost/by-user-model");
  const teams = useTeams();
  const userSuffix = useCallback((user) => teamSuffix(teams, user), [teams]);
  // 표시용 per-user 테이블만 unknown 그룹 포함 뷰로 전환한다. 위 byUserModel을 쓰는 지출 유저
  // 랭킹과 서버의 userCostEfficiency는 A/B 조인 소비자라 기본(제외) 뷰를 계속 써야 한다 —
  // index.js의 /api/cost/by-user-model 주석에 있는 정책 그대로.
  // 체크가 꺼져 있으면 이 호출은 위와 문자 그대로 같은 요청이라 서버 TTL 캐시에 히트한다.
  // 항상 includeUnknown=1을 받아두는 대안은 warmer가 데우지 않는 콜드 뷰를 매 방문마다 긁게 만든다.
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [selectedModel, setSelectedModel] = useState(null);
  // 필터가 바뀌면 사용자별 패널 선택을 해제한다(web AGENTS.md State 규칙).
  useEffect(() => setSelectedModel(null), [model, group, user, project, backend, team]);
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
  const summaryRows = asCostSummaryRows(summary.data);
  const knownSummary = sumKnownSpend(summaryRows);
  // Raw rows, not asSpendRows: the trend keeps known subtotals beside per-session exclusions.
  const dailyCells = useMemo(() => fromByModelDaily(byModelDaily.data), [byModelDaily.data, _locale]);
  // Same bucket and filters as the model trend, regrouped per user.
  const byUserDaily = useApi("/api/cost/by-user-daily", { intervalHours });
  const userDailyCells = useMemo(() => fromByModelDaily(byUserDaily.data, { dimension: "user" }), [byUserDaily.data, _locale]);
  const effortRows = asKnownSpendRows(effortMix.data);
  const agentRows = asKnownSpendRows(agentCost.data).sort(spendOrder).slice(0, 15).map((r) => ({ ...r, cost_status: costStatus(r) }));
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
    { cost: knownSummary.total, costPartial: knownSummary.partial, computed: sumSpend(summaryRows, "computed_cost"), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, sessions: 0 }
  );
  // 비용에서 파생한 예상·단위 값도 같은 부분합을 쓰므로 힌트에 기준을 밝힌다.
  const partialBasis = totals.costPartial ? translate("m1d42633eb6fd") : "";

  const modelTotals = foldModelRows(byModel.data || []);
  const totalModelCost = sumKnownSpend(modelTotals).total;
  // Totals keep every row (missingness included); only the listed rows drop zero-token models.
  // A partial model subtotal is not comparable with the previous period's full report.
  const modelRows = modelTotals.filter((r) => !r.zeroTokens).map((r) => {
    const prev = prevCostByModel.get(r.model);
    return {
      ...r,
      share: r.cost === null || totalModelCost === null ? null : totalModelCost > 0 ? r.cost / totalModelCost * 100 : 0,
      change: r.cost === null || r.cost_partial || prev == null || prev <= 0 ? null : (r.cost - prev) / prev * 100,
      cost_status: costStatus(r),
    };
  });

  const mergedUserModel = mergeUserModelRows(byUserModel.data || []);
  // 새 기간·필터에 선택 모델이 없으면 패널은 사라진다(선택값은 남아 다시 나타나면 복원).
  const selectedModelRow = modelRows.find((r) => r.model === selectedModel) || null;
  const userRows = mergeUserRows(byUserModelTable.data || []).sort(spendOrder).map((r) => ({ ...r, cost_status: costStatus(r) }));
  // 범례는 실제로 등장한 그룹만 — 'unknown 그룹 포함'을 켰는데 unknown 행이 없으면 unknown 점을
  // 띄우지 않는다(막대에도 안 나오므로 범례에도 없어야 한다).
  const shareGroups = GROUP_SEGMENT_ORDER.filter((g) => userRows.some((r) => r.groups?.[g]));
  // 스택 바 줄 길이의 공통 분모(컬럼별) — 전체 행에서 한 그룹 줄이 가질 수 있는 최대 합계.
  const lineMax = (metric) =>
    userRows.reduce((m, r) => Math.max(m, ...GROUP_SEGMENT_ORDER.map((g) => groupModelSegments(r.groups, g, metric)?.total || 0)), 0);
  const costLineMax = lineMax("cost");
  const tokenLineMax = lineMax("tokens");

  const rankedUsers = mergeUserRows(byUserModel.data || []);
  // 순위는 알려진 보고 비용(부분합 포함)으로 매기고, 모든 조각이 미산정인 사용자만 제외한다.
  const unavailableUsers = rankedUsers.filter((r) => r.cost === null).length;
  const topUsers = rankedUsers.filter((r) => r.cost !== null).sort(spendOrder).slice(0, topN);
  const partialTopUsers = topUsers.filter((r) => r.cost_partial).length;

  // pivotByKey는 자체 정렬/제한이 없고 행의 등장 순서를 그대로 유지한다(비-날짜 xKey일 때) — 그래서
  // topUsers(지출 내림차순)를 순회하며 그 유저의 행만 그 순서로 모아야 스택 바도 지출 순으로 나온다.
  const topUserModelRows = topUsers.flatMap((u) =>
    mergedUserModel.filter((r) => r.user === u.user && r.cost !== null)
      .map((row) => ({ ...row, model_label: modelLabel(row.model) }))
  );

  // Model versions remain separate; family hue is stable across backend cards.
  // Donut shares use the same disclosed known subtotal as the model table.
  const modelRowsFor = (group) => foldModelRows((byModel.data || []).filter((r) => r.group === group))
    .map((row) => ({ ...row, model_label: modelLabel(row.model) }));

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
      { type: translate("mad83311ef94f"), tokens: totals.input },
      { type: translate("m13c53880c24e"), tokens: totals.output },
      { type: translate("m12be3da02b6d"), tokens: totals.cacheRead },
      { type: translate("m1be0e1388dc5"), tokens: totals.cacheWrite },
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
    ? translate("mffb278a4a91c", [fmt(developerCount)])
    : translate("mb970f8efb903", [fmt(developerCount)]);

  // A/B 비교의 핵심 지표 — 그룹별 총지출은 그룹의 사용자 수가 다르면 비교가 안 되므로
  // 사용자당 평균으로 정규화한다. 분자는 summary(그룹별 보고 비용), 분모는 activeUsers의
  // 그룹별 uniq — 위 spendPerDeveloper와 같은 모수 규칙(excludeUnknown:false)을 그대로 따른다.
  const groupUserCount = (g) => Number(activeUsers.data?.[`${g}_users`] ?? 0);
  const groupCost = (g) => sumKnownSpend(summaryRows.filter((r) => r.group === g));
  const spendPerUserFor = (g) => (groupCost(g).total !== null && groupUserCount(g) > 0 ? groupCost(g).total / groupUserCount(g) : null);

  // 그룹별 캐시 티어별 지출 — bedrock/enterprise 좌우 분리(다른 카드들과 동일 패턴).
  function tierRowsFor(group) {
    const t = tiers.data?.[group];
    if (!t) return [];
    return [
      { tier: translate("m12be3da02b6d"), cost: t.cacheRead },
      { tier: translate("m1be0e1388dc5"), cost: t.cacheWrite },
      { tier: translate("m13c53880c24e"), cost: t.output },
      { tier: translate("mc43da268406e"), cost: t.uncachedInput },
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
  // 부분합 사용자는 추적된 보고 비용(알려진 부분합)을 같은 분모로 나누고 부분합 배지로 밝힌다
  // (ADR-013 2026-10-28 개정) — API의 엄격한 cost_per_loc/cost_per_commit은 그대로 둔다.
  const efficiencyRows = asKnownSpendRows(efficiency.data)
    .filter((r) => r.loc > 0 || r.commits > 0)
    .map((r) => ({
      ...r,
      cost_per_loc: r.cost === null || !(r.loc > 0) ? null : r.cost_partial ? r.cost / r.loc : r.cost_per_loc,
      cost_per_commit: r.cost === null || !(r.commits > 0) ? null : r.cost_partial ? r.cost / r.commits : r.cost_per_commit,
      cost_status: costStatus(r),
      computed_cost_per_loc: !r.unpriced && r.computed_cost !== null && r.loc > 0 ? r.computed_cost / r.loc : null,
      computed_cost_per_commit: !r.unpriced && r.computed_cost !== null && r.commits > 0 ? r.computed_cost / r.commits : null,
    }))
    .sort((a, b) => (a.cost_per_loc == null) - (b.cost_per_loc == null) || a.cost_per_loc - b.cost_per_loc);

  return (
    <div>
      <PageHeader
        title={translate("m204a5eb2cd28")}
        subtitle={translate("mdd5a59fc82dd")}
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-3">
          {showComputed && <a href="#computed-cost-comparison" className="text-sm text-brand-700 underline underline-offset-2">{translate("mf2c5c15c5a50")}</a>}
          <label className="flex items-center gap-2 text-sm text-ink-600 cursor-pointer">{richMessage("m973374e57e5b", [<input
              type="checkbox"
              checked={showComputed}
              onChange={(e) => setShowComputed(e.target.checked)}
              className="h-4 w-4 accent-brand-500"
            />])}</label>
        </div>
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
              label={translate("mb6306d032796")}
              value={usd(totals.cost)}
              variant="accent"
              help={translateSource(SPEND_HELP)}
              hint={
                totals.cost === null
                  ? translate("mb8ea64a8e6ca")
                  : totals.costPartial
                    ? translate("maed843efee6c")
                    : translate("m7065819eea96")
              }
            />
            <StatTile label={translate("me10fd8ddfcf8")} value={fmt(totals.input)} />
            <StatTile label={translate("m6f31589138ca")} value={fmt(totals.output)} help={translate("m7ecfee1cb4be")} />
            <StatTile label={translate("ma9bdbc290aa6")} value={fmt(totals.cacheRead)} />
            <StatTile label={translate("m6c4f1f9716fe")} value={fmt(totals.cacheWrite)} />
            <StatTile label={translate("me600d4f5926e")} value={fmt(totals.sessions)} />
            <StatTile
              label={translate("m0b693e4cf87c")}
              value={usd(projection30d)}
              help={translate("md0e101b2e5eb")}
              hint={translate("mc6ce93ac373c", [partialBasis])}
            />
            {/* developerCount/spendPerDeveloper는 activeUsers에서 나온다 — summary만 게이트하면
                activeUsers가 아직 로딩 중이거나 에러여도 "$0 / 0명 기준"이 실제 값처럼 보인다. */}
            <StatTile label={translate("m5c615b8ee780")} value={usd(spendPerDeveloper)} hint={`${spendPerDeveloperHint}${partialBasis}`} />
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
                    {translate("me8a5ef43f77e", [g])}
                  </span>
                }
                value={usd(spendPerUserFor(g))}
                hint={`${
                  model
                    ? translate("m28ba178fe32c", [fmt(groupUserCount(g))])
                    : translate("ma1cd76b536a3", [fmt(groupUserCount(g)), usd(groupCost(g).total)])
                }${groupCost(g).partial ? translate("m1d42633eb6fd") : ""}`}
              />
            ))}
          </div>
        )}

        <div className="group-grid">
          {shownGroups(effortMix.data).map((g) => (
            <CostBreakdownCard
              key={g}
              title={translate("mb2671582ce1b", [g])}
              loading={effortMix.loading}
              error={effortMix.error}
              help={translate("mcd0e2e55edc9", [translateSource(SPEND_HELP), comparisonHelp])}
            >
              <ReportedCostDonut
                rows={effortRowsFor(g)}
                nameKey="effort"
                colorOf={makeGroupBreakdownColorer(g, EFFORT_LABEL_ORDER)}
              />
              <ul className="mt-3 text-[12px] text-ink-400">
                {effortRowsFor(g).map((r) => (
                  <li key={r.effort}>{`${effortLabel(r.effort)}: ${usd(r.cost)}${r.cost_partial ? translate("m830e860c2bd2") : ""}${showComputed ? translate("mca751ef60d75", [usd(r.computed_cost), r.unpriced_tokens > 0 ? translate("mdd11c25417e5") : ""]) : ""}`}</li>
                ))}
              </ul>
            </CostBreakdownCard>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {shownGroups(byModel.data).map((g) => (
            <CostBreakdownCard key={g} title={translate("mb6a2c1baa1dd", [g])} help={translateSource(SPEND_HELP)}
              loading={byModel.loading} error={byModel.error}>
              <ReportedCostDonut
                rows={modelRowsFor(g)}
                nameKey="model_label"
                colorOf={(name, _index, theme) => groupModelColorFor(g, name, theme)}
                listUnknown
                listZero
              />
            </CostBreakdownCard>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {shownGroups(summary.data).map((g) => (
            <CostBreakdownCard key={g} title={translate("m535d998e5e1a", [g])}
              loading={summary.loading} error={summary.error}>
              <DonutBody
                data={tokenTypeRowsFor(g)}
                nameKey="type"
                valueKey="tokens"
                colorOf={makeGroupBreakdownColorer(g, TOKEN_TYPE_LABEL_ORDER)}
              />
            </CostBreakdownCard>
          ))}
        </div>

        {byModelDaily.loading ? (
          <Loading />
        ) : byModelDaily.error ? (
          <ErrorBox error={byModelDaily.error} />
        ) : (
          <ModelCostTrend
            title={translate("m25cddb8e4cf4")}
            right={
              <SegmentedControl
                options={[
                  { value: "1", label: translate("mdeb162691363") },
                  { value: "24", label: translate("m58ea1d09d2dd") },
                  { value: "168", label: translate("m2392bb5e3aa6") },
                ]}
                value={String(intervalHours)}
                onChange={(v) => setIntervalHours(Number(v))}
              />
            }
            cells={dailyCells}
            help={translateSource(SPEND_HELP)}
            basis={translate("ma029ac069435")}
            xKey="t"
            pinned={model ? [model] : undefined}
            bucketHours={intervalHours}
            zoomDisabled={byModelDaily.stale}
            clampRange={[from, null]}
          />
        )}

        {byUserDaily.loading ? (
          <Loading />
        ) : byUserDaily.error ? (
          <ErrorBox error={byUserDaily.error} />
        ) : (
          <ModelCostTrend
            title={translate("mafd8327e1623")}
            subtitle={translate("m7d08d8867934")}
            cells={userDailyCells}
            help={translateSource(SPEND_HELP)}
            basis={translate("ma029ac069435")}
            xKey="t"
            dimension="user"
            userSuffix={userSuffix}
            bucketHours={intervalHours}
            zoomDisabled={byUserDaily.stale}
            clampRange={[from, null]}
          />
        )}

        <TeamCostSection intervalHours={intervalHours} />

        <div className={selectedModelRow ? "grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start" : undefined}>
        <DataTable
          key={`models-${showComputed}`}
          title={translate("mf53a751f77b6")}
          subtitle={translate("me4a69165336b")}
          help={translate("m52f5e9cfeb08", [translateSource(SPEND_HELP), comparisonHelp])}
          columns={[
            { key: "model", label: translate("mf9f4d4113aa1"), render: modelLabel, toText: modelLabel },
            { key: "cost", label: translate("m24423dd67b3a"), render: knownUsd },
            ...(showComputed ? [{ key: "computed_cost", label: translate("m50892133f2e8"), render: computedText, toText: computedCsv }] : []),
            { key: "share", label: translate("md6e77d776f15"), render: (v) => v === null ? translate("m84dd6e381dca") : `${v.toFixed(1)}%`, toText: (v) => v === null ? "" : `${v.toFixed(1)}%` },
            {
              key: "change",
              label: translate("m97fe478cb1de"),
              render: (v) => v === null ? translate("m84dd6e381dca") : <Badge tone={v >= 0 ? "positive" : "negative"}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</Badge>,
              toText: (v) => v === null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`,
            },
            { key: "inputTokens", label: translate("me10fd8ddfcf8"), render: fmt },
            { key: "outputTokens", label: translate("m6f31589138ca"), render: fmt },
            costStatusColumn,
          ]}
          rows={modelRows}
          groupKey="__none__"
          onRowClick={(r) => setSelectedModel((m) => (m === r.model ? null : r.model))}
          isRowSelected={(r) => r.model === selectedModel}
          exportName="cost_by_model"
          stale={byModel.stale || compare.stale}
        />
        {/* 패널은 by-user-model 응답만 쓴다 — 그 응답이 이전 기간의 것이면(stale) 비중을 보이지 않는다. */}
        {selectedModelRow && (
          <ModelUserPanel
            modelRow={selectedModelRow}
            userModelRows={mergedUserModel}
            loading={byUserModel.loading || byUserModel.stale}
            error={byUserModel.error}
            onClose={() => setSelectedModel(null)}
          />
        )}
        </div>

        {agentCost.loading ? (
          <Loading />
        ) : agentCost.error ? (
          <ErrorBox error={agentCost.error} />
        ) : (
          <DataTable
            key={`agents-${showComputed}`}
            title={translate("m1af4a4003dad")}
            subtitle={translate("ma524fc14196d")}
            help={translate("m697a0b179032", [translateSource(SPEND_HELP), comparisonHelp])}
            columns={[
              { key: "agent", label: translate("md33f1c5fe1f4"), render: agentLabel, toText: agentLabel },
              { key: "group", label: translate("ma391a59a3eb6") },
              { key: "cost", label: translate("m24423dd67b3a"), render: knownUsd },
              ...(showComputed ? [{ key: "computed_cost", label: translate("m50892133f2e8"), render: computedText, toText: computedCsv }] : []),
              { key: "tokens", label: translate("meb540501fb31"), render: fmt },
              costStatusColumn,
            ]}
            rows={agentRows}
            exportName="cost_by_agent"
            stale={agentCost.stale}
          />
        )}

        {byUserModel.loading ? (
          <Loading />
        ) : byUserModel.error ? (
          <ErrorBox error={byUserModel.error} />
        ) : (
          <SeriesBarChart
            title={translate("me46907940c0e", [topN])}
            subtitle={translate("maeec926baf97", [unavailableUsers ? translate("m8c806312eae2", [unavailableUsers]) : "", partialTopUsers ? translate("mdc121477123d", [partialTopUsers]) : ""])}
            help={translate("m3e8383b1cb07", [translateSource(SPEND_HELP)])}
            right={
              <SegmentedControl
                options={[10, 20, 50, 100].map((n) => ({ value: String(n), label: String(n) }))}
                value={String(topN)}
                onChange={(v) => setTopN(Number(v))}
              />
            }
            rows={topUserModelRows}
            xKey="user"
            seriesKey="model_label"
            valueKey="cost"
            colorOf={modelColorFor}
            seriesSort={byModelLegendOrder}
            valuePrefix="$"
            tickFormatter={(user) => maskEmail(user) + userSuffix(user)}
            horizontal
          />
        )}

        {byUserModelTable.loading ? (
          <Loading />
        ) : byUserModelTable.error ? (
          <ErrorBox error={byUserModelTable.error} />
        ) : (
          <DataTable
            key={`users-${showComputed}`}
            title={translate("me39cd7a7fc5c")}
            // single 모드에선 그룹 줄 구분이 무의미해 막대를 빼므로 부제도 막대/범례를 말하지 않는다.
            subtitle={
              groupMode === "single" ? (
                translate("m4fd106edc5e8")
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1.5">{richMessage("maa15c8938360", [<GroupShareLegend groups={shareGroups} />])}</span>
              )
            }
            help={
              groupMode === "single"
                ? translate("m47a42c7a94e5", [translateSource(SPEND_HELP), comparisonHelp])
                : translate("m5170a2fcd3cf", [translateSource(SPEND_HELP), comparisonHelp])
            }
            right={
              <label className="flex items-center gap-1.5 text-[12px] text-ink-600 select-none cursor-pointer">{richMessage("ma6043a2a1ace", [<input
                  type="checkbox"
                  checked={includeUnknown}
                  onChange={(e) => setIncludeUnknown(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-ink-200 accent-brand-500"
                />])}</label>
            }
            columns={withTeamColumn([
              { key: "user", label: translate("m1ac6e422b7dc"), render: maskEmail },
              // 스택 바 두 줄은 숫자 옆에 산다(사용자 지정) — 행 그레인이 사용자라 모델 축은
              // 이 막대(색 분할)와 hover가 나른다. single 모드에선 그룹 줄이 하나뿐이라 숫자만.
              {
                key: "cost",
                label: translate("m24423dd67b3a"),
                render: (_v, r) => (
                  <span className="inline-flex items-center gap-3">
                    <span className="min-w-[4.5rem]">{knownUsd(r.cost, r)}</span>
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
              ...(showComputed ? [{ key: "computed_cost", label: translate("m50892133f2e8"), render: computedText, toText: computedCsv }] : []),
              {
                key: "tokens",
                label: translate("meb540501fb31"),
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
              costStatusColumn,
            ], teams)}
            rows={withTeams(userRows, teams)}
            exportName="cost_by_user"
            stale={byUserModelTable.stale}
          />
        )}

        {efficiency.loading ? (
          <Loading />
        ) : efficiency.error ? (
          <ErrorBox error={efficiency.error} />
        ) : (
          <DataTable
            key={`efficiency-${showComputed}`}
            title={translate("mb6ad3293a647")}
            subtitle={translate("md83e52709642")}
            help={translate("m89cb5abb3cef", [translateSource(SPEND_HELP), comparisonHelp])}
            columns={withTeamColumn([
              { key: "user", label: translate("m1ac6e422b7dc"), render: maskEmail },
              { key: "group", label: translate("ma391a59a3eb6") },
              { key: "cost", label: translate("m24423dd67b3a"), render: knownUsd },
              { key: "loc", label: translate("m81ea6a128280"), render: fmt },
              { key: "commits", label: translate("ma5d6612cd595"), render: fmt },
              { key: "cost_per_loc", label: "$/LOC", render: (v, r) => (v == null ? translate("m84dd6e381dca") : partialUnit(`$${Number(v).toFixed(4)}`, r)) },
              { key: "cost_per_commit", label: translate("m848d81a5aa61"), render: (v, r) => (v == null ? translate("m84dd6e381dca") : partialUnit(usd(v), r)) },
              ...(showComputed ? [{ key: "computed_cost", label: translate("m50892133f2e8"), render: computedText, toText: computedCsv }] : []),
              ...(showComputed ? [{ key: "computed_cost_per_loc", label: translate("m0a42f33a98cc"), render: (v) => (v == null ? translate("m84dd6e381dca") : `$${Number(v).toFixed(4)}`) }] : []),
              ...(showComputed ? [{ key: "computed_cost_per_commit", label: translate("m244514d75e8f"), render: usd }] : []),
              costStatusColumn,
            ], teams)}
            rows={withTeams(efficiencyRows, teams)}
            exportName="cost_efficiency_by_user"
            stale={efficiency.stale}
          />
        )}

        {showComputed && (
          <section id="computed-cost-comparison" aria-label={translate("m3d6bcfd09cd3")} className="mt-4 flex flex-col gap-4 border-t border-dashed border-ink-200 pt-5">
            <div>
              <h2 className="text-base font-semibold text-ink-800">{translate("m3d6bcfd09cd3")}</h2>
              <p className="mt-1 text-sm text-ink-500">{translate("mb4bba6980c1f", [priceSource])}</p>
            </div>
            {summary.loading ? <Loading /> : summary.error ? <ErrorBox error={summary.error} /> : (
              <div className="grid grid-cols-2 gap-4">
                <StatTile label={translate("m37131be45e8b")} value={usd(totals.cost)} help={translateSource(SPEND_HELP)} hint={totals.costPartial ? translate("m63913ae049a3") : undefined} />
                <StatTile
                  label={translate("m2d2100fe3bf8")}
                  value={usd(totals.computed)}
                  help={computedHelp}
                  hint={`${ttlHint}${totals.unpricedTokens > 0 ? translate("m8d15fac1acde", [fmt(totals.unpricedTokens)]) : ""}`}
                />
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
                    title={translate("m57f7ad0d53db", [g])}
                    subtitle={`${ttlHint}${unpricedTokensFor(g) > 0 ? translate("m8d15fac1acde", [fmt(unpricedTokensFor(g))]) : ""}`}
                    help={computedHelp}
                    right={<Badge tone="brand">{translate("m8e912755c21a")}{(cacheRatioFor(g) * 100).toFixed(1)}%</Badge>}
                    data={tierRowsFor(g)}
                    nameKey="tier"
                    valueKey="cost"
                    valuePrefix="$"
                    valueFormatter={usd}
                    colorOf={makeGroupBreakdownColorer(g, TIER_LABEL_ORDER)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
