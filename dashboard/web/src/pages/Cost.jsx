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
import { groupsShown } from "../pivot.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
// render와 CSV 내보내기용 값이 같아야 하는 컬럼용. 원본 값만으로는 셀을 복원할 수 없는 경우다:
// unpriced는 row의 플래그이고, agent의 'main'은 화면에서 '메인 세션'으로 바뀐다.
// 화면의 —(값 없음)는 CSV에서 빈 셀로 내보낸다 — 숫자 컬럼에 em-dash가 들어가면
// 스프레드시트가 그 열을 통째로 텍스트로 승격시킨다.
const modelCostText = (_v, r) => (r.unpriced ? "미산정" : usd(r.cost));
const userCostText = (v, r) => (r.unpriced ? "미산정 포함" : usd(v));
const agentLabel = (v) => (v === "main" ? "메인 세션" : v);
// bedrock/enterprise로 나뉘는 도넛들(캐시 티어·토큰 타입·Effort)의 라벨 순서 — 그룹 색상 배정이
// 데이터 등장 순서가 아니라 이 고정 순서를 따르게 한다(colors.js makeGroupBreakdownColorer).
const TIER_LABEL_ORDER = ["캐시 읽기", "캐시 쓰기", "출력", "비캐시 입력"];
const TOKEN_TYPE_LABEL_ORDER = ["캐시 읽기", "캐시 쓰기", "출력", "입력"];
const EFFORT_LABEL_ORDER = ["medium", "high", "xhigh", "unknown"];

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

// 양 그룹을 오간 유저(straddler)는 normModel 이후 모델명이 같아 그룹 점만 다른 두 줄로 보인다
// (사용자 지시: 이 드릴다운은 그룹 구분 없이 user×model 병합 — 그룹 비교는 다른 패널 몫).
// 병합 키에 model이 들어가므로 unpriced는 병합 조각끼리 항상 동일하다(같은 정규화 모델 = 같은 단가표 상태).
// 랭킹(기본 뷰)과 표시용 테이블(unknown 포함 전환 가능)이 서로 다른 응답을 같은 규칙으로
// 접어야 해서 함수로 분리했다.
// groups는 병합으로 버려지던 그룹 축을 행 안에 보존한 것 — 합계 컬럼들은 그대로 두고 "그룹별 지출"
// 스택 막대만 이걸 읽는다(순수 추가). Cost.test.js가 import하므로 export다.
export function mergeUserModelRows(rows) {
  return [...rows
    .reduce((m, r) => {
      const k = `${r.user}|${r.model}`;
      const acc = m.get(k) || { user: r.user, model: r.model, unpriced: r.unpriced, cost: r.cost === null ? null : 0, reported_cost: 0, tokens: 0, groups: {} };
      if (acc.cost !== null) acc.cost += Number(r.cost);
      acc.reported_cost += Number(r.reported_cost || 0);
      acc.tokens += Number(r.tokens || 0);
      // 미산정 행은 r.cost가 null이라 그룹 cost도 0으로만 누적된다. 응답에 없는 그룹 키는
      // 만들지 않는다.
      const g = acc.groups[r.group] || (acc.groups[r.group] = { cost: 0, tokens: 0, reported: 0 });
      g.cost += Number(r.cost || 0);
      g.tokens += Number(r.tokens || 0);
      // 미산정 행의 막대 길이 폴백용 — 보고 비용도 달러라 계산 비용과 같은 축에 놓을 수 있다.
      g.reported += Number(r.reported_cost || 0);
      return m.set(k, acc);
    }, new Map())
    .values()];
}

// 사용자 단위 폴드 — user×model 행(100유저 × 모델 5개꼴)은 표가 너무 길어 못 읽는다는
// 피드백으로 행 그레인을 사용자로 올리고, 모델 축은 셀 안의 그룹별(두 줄) 모델 스택 바가
// 나른다. groups[g].models[model] = {cost, tokens} 중첩으로 접는다. 미산정 모델(cost null)은
// 사용자 지시로 이 표에서는 그냥 0으로 계산한다 — 배지/표기 없이 합계에 0으로 접히고, 지출
// 줄에서는 값 0이라 자연히 빠지며 토큰 줄에는 그대로 남는다.
export function mergeUserRows(rows) {
  return [...rows
    .reduce((m, r) => {
      const acc = m.get(r.user) || { user: r.user, cost: 0, reported_cost: 0, tokens: 0, groups: {} };
      acc.cost += Number(r.cost || 0);
      acc.reported_cost += Number(r.reported_cost || 0);
      acc.tokens += Number(r.tokens || 0);
      const g = acc.groups[r.group] || (acc.groups[r.group] = { models: {} });
      const mm = g.models[r.model] || (g.models[r.model] = { cost: 0, tokens: 0 });
      mm.cost += Number(r.cost || 0);
      mm.tokens += Number(r.tokens || 0);
      return m.set(r.user, acc);
    }, new Map())
    .values()];
}

// 한 그룹 줄의 모델 세그먼트 목록 — 값 0 모델 제외, 순서는 범례 규칙(byModelLegendOrder) 고정.
export function groupModelSegments(groups, group, metric) {
  const models = groups?.[group]?.models;
  if (!models) return null;
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
    const line = groupModelSegments(groups, g, metric);
    return line ? `${g} ${fmtVal(line.total)}` : null;
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
          label={`${group} ${fmtVal(line.total)} — ${line.segs.map((x) => `${x.model} ${fmtVal(x.value)}`).join(" · ")}`}
          tip={
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 font-semibold">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorFor(group) }} />
                {group}
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
          {g}
        </span>
      ))}
    </span>
  );
}

export default function Cost() {
  const { groupMode } = useConfig();
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

  const mergedUserModel = mergeUserModelRows(byUserModel.data || []);
  const userRows = mergeUserRows(byUserModelTable.data || []).sort((a, b) => (b.cost || 0) - (a.cost || 0));
  // 범례는 실제로 등장한 그룹만 — 'unknown 그룹 포함'을 켰는데 unknown 행이 없으면 unknown 점을
  // 띄우지 않는다(막대에도 안 나오므로 범례에도 없어야 한다).
  const shareGroups = GROUP_SEGMENT_ORDER.filter((g) => userRows.some((r) => r.groups?.[g]));
  // 스택 바 줄 길이의 공통 분모(컬럼별) — 전체 행에서 한 그룹 줄이 가질 수 있는 최대 합계.
  const lineMax = (metric) =>
    userRows.reduce((m, r) => Math.max(m, ...GROUP_SEGMENT_ORDER.map((g) => groupModelSegments(r.groups, g, metric)?.total || 0)), 0);
  const costLineMax = lineMax("cost");
  const tokenLineMax = lineMax("tokens");

  const userTotals = new Map();
  for (const r of mergedUserModel) {
    if (r.cost === null) continue;
    userTotals.set(r.user, (userTotals.get(r.user) || 0) + Number(r.cost));
  }
  const topUsers = [...userTotals.entries()]
    .map(([user, cost]) => ({ user, cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, topN);

  // pivotByKey는 자체 정렬/제한이 없고 행의 등장 순서를 그대로 유지한다(비-날짜 xKey일 때) — 그래서
  // topUsers(지출 내림차순)를 순회하며 그 유저의 행만 그 순서로 모아야 스택 바도 지출 순으로 나온다.
  const topUserModelRows = topUsers.flatMap((u) =>
    mergedUserModel.filter((r) => r.user === u.user && r.cost !== null)
  );

  // bedrock/enterprise 도넛은 그룹=색상 계열 규칙을 따른다(사용자 지시) — 같은 모델이라도
  // bedrock 카드에선 블루, enterprise 카드에선 틸로 다르게 보인다(groupModelColorFor). 모델
  // 정체성은 그 계열 안의 명도로 표현되지, 색조(hue)로 표현되지 않는다 — 그룹이 우선.
  const modelRowsFor = (group) => foldModelRows((byModel.data || []).filter((r) => r.group === group));
  // 계열 이름은 색상 규칙(위)의 사람 설명이라 그룹별로 다르다 — 카드가 groupsShown으로
  // 순회되므로 문구도 그룹에서 끌어온다.
  const MODEL_DONUT_HUE = { bedrock: "블루 계열", enterprise: "틸 계열" };

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

  // A/B 비교의 핵심 지표 — 그룹별 총지출은 그룹의 사용자 수가 다르면 비교가 안 되므로
  // 사용자당 평균으로 정규화한다. 분자는 summary(그룹별 computed_cost), 분모는 activeUsers의
  // 그룹별 uniq — 위 spendPerDeveloper와 같은 모수 규칙(excludeUnknown:false)을 그대로 따른다.
  const groupUserCount = (g) => Number(activeUsers.data?.[`${g}_users`] ?? 0);
  const groupCost = (g) => Number((summary.data || []).find((r) => r.group === g)?.computed_cost || 0);
  const spendPerUserFor = (g) => (groupUserCount(g) > 0 ? groupCost(g) / groupUserCount(g) : 0);

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
    (effortMix.data || [])
      .filter((r) => r.group === group && Number(r.cost) > 0)
      .sort((a, b) => effortOrder(a.effort) - effortOrder(b.effort));

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
            {/* A/B 비교용 — 총지출이 아니라 사용자당 평균이라야 그룹 간 사용자 수 차이가 상쇄된다.
                전체(개발자당 지출)는 그룹 합이 아니다: 한 유저가 두 그룹에 걸칠 수 있어(세션 단위
                판별, grouping.js) 전역 uniq 분모가 그룹 분모의 합보다 작을 수 있다. */}
            {groupsShown(groupMode, summary.data).map((g) => (
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
                    {`사용자당 평균 — ${g}`}
                  </span>
                }
                value={usd(spendPerUserFor(g))}
                hint={
                  model
                    ? `${fmt(groupUserCount(g))}명 기준 — model 필터로 분자만 필터링됨(참고용)`
                    : `${fmt(groupUserCount(g))}명 · 총 ${usd(groupCost(g))}`
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
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, tiers.data).map((g) => (
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
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, effortMix.data).map((g) => (
              <Card
                key={g}
                title={`Effort별 지출 — ${g}`}
                subtitle="reasoning effort별 계산 비용(토큰 × 모델 단가) · 보고 비용(Claude Code cost.usage)은 대조용 · effort 미보고 세션은 unknown"
              >
                <DonutBody
                  data={effortRowsFor(g)}
                  nameKey="effort"
                  valueKey="cost"
                  valuePrefix="$"
                  colorOf={makeGroupBreakdownColorer(g, EFFORT_LABEL_ORDER)}
                />
                <ul className="mt-3 text-[12px] text-ink-400">
                  {effortRowsFor(g).map((r) => (
                    <li key={r.effort}>{`${r.effort} · 계산 ${usd(r.cost)} · 보고 ${usd(r.reported_cost)}`}</li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] text-ink-400">
                  보고 비용은 Claude Code 클라이언트의 자체 단가표로 계산되어 버전에 따라 달라진다 (실측 2026-09-03: v2.1.251은 fable-5-1을 opus-5 단가로 보고 → 약 0.5×). thinking 토큰은 output 토큰에 포함된다.
                </p>
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
            groupsShown(groupMode, byModel.data).map((g) => (
              <Card key={g} title={`모델별 지출 비중 — ${g}`} subtitle={`${MODEL_DONUT_HUE[g] ?? "그룹 계열"} · 명도로 모델 구분(신버전일수록 진하게)`}>
                <DonutBody data={modelRowsFor(g)} nameKey="model" valueKey="cost" valuePrefix="$" colorOf={(name) => groupModelColorFor(g, name)} />
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
            groupsShown(groupMode, summary.data).map((g) => (
              <DonutBreakdown
                key={g}
                title={`토큰 타입별 비중 — ${g}`}
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
            colorOf={modelColorFor}
            seriesSort={byModelLegendOrder}
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
            { key: "cost", label: "지출 (계산)", render: (_v, r) => (r.unpriced ? <Badge tone="neutral">미산정</Badge> : usd(r.cost)), toText: modelCostText },
            { key: "reportedCost", label: "보고 비용", render: usd },
            {
              key: "share",
              label: "전체 대비",
              render: (_v, r) => (r.unpriced ? <span className="text-ink-400">—</span> : `${totalModelCost > 0 ? ((r.cost / totalModelCost) * 100).toFixed(1) : 0}%`),
              toText: (_v, r) => (r.unpriced ? "" : `${totalModelCost > 0 ? ((r.cost / totalModelCost) * 100).toFixed(1) : 0}%`),
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
              toText: (_v, r) => {
                const prev = prevCostByModel.get(r.model);
                if (r.unpriced || prev === null || prev === undefined || prev <= 0) return "";
                const p = ((r.cost - prev) / prev) * 100;
                return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
              },
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
            title="에이전트별 지출"
            subtitle="계산 비용(토큰 × 단가) 상위 15개 · 보고 비용은 대조용 — 에이전트 미지정(메인 세션) 지출 포함"
            columns={[
              { key: "agent", label: "에이전트", render: agentLabel, toText: agentLabel },
              { key: "group", label: "그룹" },
              { key: "cost", label: "지출(계산)", render: usd },
              { key: "reported_cost", label: "보고 비용", render: usd },
              { key: "tokens", label: "토큰", render: fmt },
            ]}
            rows={(agentCost.data || []).slice(0, 15)}
            exportName="cost_by_agent"
          />
        )}

        {byUserModel.loading ? (
          <Loading />
        ) : byUserModel.error ? (
          <ErrorBox error={byUserModel.error} />
        ) : (
          <SeriesBarChart
            title={`Top ${topN} — 지출 유저`}
            subtitle="계산 비용 기준 · 모델별 스택"
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
            title="사용자 · 모델별 지출"
            // single 모드에선 그룹 줄 구분이 무의미해 막대를 빼므로 부제도 막대/범례를 말하지 않는다.
            subtitle={
              groupMode === "single" ? (
                "계산 비용 기준 정렬 · 사용자 단위 병합"
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1.5">
                  계산 비용 기준 정렬 · 사용자 단위 병합(단가표 밖 모델은 $0 처리) · 숫자 옆 두 줄 = 그룹(줄 머리 점), 색 분할 = 모델 — hover로 모델별 값
                  <GroupShareLegend groups={shareGroups} />
                </span>
              )
            }
            right={
              <label className="flex items-center gap-1.5 text-[12px] text-ink-600 select-none cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeUnknown}
                  onChange={(e) => setIncludeUnknown(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-ink-200 accent-brand-500"
                />
                unknown 그룹 포함
              </label>
            }
            columns={[
              { key: "user", label: "사용자", render: maskEmail },
              // 스택 바 두 줄은 숫자 옆에 산다(사용자 지정) — 행 그레인이 사용자라 모델 축은
              // 이 막대(색 분할)와 hover가 나른다. single 모드에선 그룹 줄이 하나뿐이라 숫자만.
              {
                key: "cost",
                label: "지출 (계산)",
                render: (_v, r) => (
                  <span className="inline-flex items-center gap-3">
                    <span className="min-w-[4.5rem]">{usd(r.cost)}</span>
                    {groupMode !== "single" && <UserGroupModelBars groups={r.groups} metric="cost" max={costLineMax} />}
                  </span>
                ),
                toText: (_v, r) => {
                  const split = groupTotalsText(r.groups, "cost");
                  return split ? `${usd(r.cost)} — ${split}` : usd(r.cost);
                },
              },
              { key: "reported_cost", label: "보고 비용", render: usd },
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
            subtitle="라인당 계산 비용이 낮은 순 — 성과 평가가 아니라 비용 신호"
            columns={[
              { key: "user", label: "사용자", render: maskEmail },
              { key: "group", label: "그룹" },
              { key: "cost", label: "지출 (계산)", render: (v, r) => (r.unpriced ? <Badge tone="neutral">미산정 포함</Badge> : usd(v)), toText: userCostText },
              { key: "loc", label: "추가 라인", render: fmt },
              { key: "commits", label: "커밋", render: fmt },
              { key: "cost_per_loc", label: "$/LOC", render: (v) => (v == null ? "—" : `$${v.toFixed(4)}`) },
              { key: "cost_per_commit", label: "$/커밋", render: (v) => (v == null ? "—" : usd(v)) },
            ]}
            rows={efficiencyRows}
            exportName="cost_efficiency_by_user"
          />
        )}
      </div>
    </div>
  );
}
