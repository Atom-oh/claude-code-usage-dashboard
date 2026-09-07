import { Badge } from "../components/Badge.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { GroupAreaChart, GroupBarChart, DualLineChart, SeriesBarChart, HBarList } from "../components/GroupCharts.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { BarTip } from "../components/BarTip.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { makeTickFmt, maskEmail } from "../fmt.js";
import { useGroupsShown } from "../useGroupsShown.js";
import { colorFor, GROUP_SEGMENT_ORDER } from "../colors.js";
import { foldLeaderboardByUser } from "../score.js";
import { decisionLabel, unclassifiedLabel } from "../labels.js";

const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

// 비용 셀의 그룹 스택 바 — 한 줄짜리, 색 분할 = 그룹(bedrock/enterprise[/unknown]), 길이 =
// 컬럼 최대 사용자 비용 대비. 단가표 밖 모델은 서버 응답에서 cost null → 0으로 접힌다
// (Cost 페이지의 사용자 표와 같은 규칙). hover에 그룹별 금액.
function CostGroupBar({ split, max }) {
  const segs = GROUP_SEGMENT_ORDER.map((g) => ({ group: g, value: Number(split?.[g] || 0) })).filter((x) => x.value > 0);
  const total = segs.reduce((sum, x) => sum + x.value, 0);
  if (!total || !(max > 0)) return null;
  return (
    <BarTip
      className="inline-block h-1.5 w-24 shrink-0 rounded-full bg-ink-100 align-middle"
      label={segs.map((x) => `${x.group} ${usd(x.value)}`).join(" · ")}
      tip={
        <span className="flex flex-col gap-0.5">
          {segs.map((x) => (
            <span key={x.group} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorFor(x.group) }} />
              {x.group}
              <span className="tabular ml-auto pl-4">{usd(x.value)}</span>
            </span>
          ))}
        </span>
      }
    >
      <span className="flex h-full overflow-hidden rounded-full" style={{ width: `${Math.max(1, (total / max) * 100)}%` }}>
        {segs.map((x) => (
          <span key={x.group} style={{ width: `${(x.value / total) * 100}%`, minWidth: "1px", background: colorFor(x.group) }} />
        ))}
      </span>
    </BarTip>
  );
}

const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (n) => `${(Number(n) * 100).toFixed(0)}%`;
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };

// 2026-08-11 traces beta 패널(권한대기/TTFT) — 서버가 {unsupported, rows} 모양을 내려준다.
// unsupported=true는 "0"이 아니라 "이 구간엔 해당 스팬이 없음"(베타 미배포 또는 v2.1.214
// 미만)이라는 뜻이라 DataTable의 기본 "데이터 없음"과 구분되는 안내를 별도로 보여준다.
const PERMISSION_WAIT_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "p50_wait_ms", label: "p50 대기 (ms)", render: fmt },
  { key: "p95_wait_ms", label: "p95 대기 (ms)", render: fmt },
  { key: "n", label: "샘플 수", render: fmt },
];

const TTFT_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "model", label: "모델" },
  { key: "p50_ttft_ms", label: "p50 TTFT (ms)", render: fmt },
  { key: "p95_ttft_ms", label: "p95 TTFT (ms)", render: fmt },
  { key: "n", label: "샘플 수", render: fmt },
];

// 2026-08-31 — 인터랙션 시간 분해. 비중 합계가 1을 넘을 수 있다(자식 스팬은 동시 실행될 수 있고
// tool 스팬 duration_ms는 권한 대기 + 실행을 함께 담는다) — 구성비가 아니라 "인터랙션 총 시간
// 대비 각 종류가 쓴 시간의 배수"다. 100%를 넘는 값이 보이면 버그가 아니다.
const INTERACTION_BREAKDOWN_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "interactions", label: "인터랙션 수", render: fmt },
  { key: "p50_interaction_ms", label: "p50 소요 (ms)", render: fmt },
  { key: "p95_interaction_ms", label: "p95 소요 (ms)", render: fmt },
  { key: "llm_share", label: "모델 응답 비중", render: pct, toText: pct },
  { key: "tool_exec_share", label: "도구 실행 비중", render: pct, toText: pct },
  { key: "blocked_share", label: "권한 대기 비중", render: pct, toText: pct },
];

const LANGUAGE_COLUMNS = [
  { key: "language", label: "언어", render: unclassifiedLabel, toText: unclassifiedLabel },
  { key: "edits", label: "편집 수", render: fmt },
  { key: "accept_rate", label: "수락률", render: pct, toText: pct },
];

function TracesBetaPanel({ resp, title, subtitle, help, columns, exportName }) {
  if (resp.loading) return <Loading />;
  if (resp.error) return <ErrorBox error={resp.error} />;
  if (resp.data?.unsupported) {
    return (
      <DataTable
        title={title}
        subtitle="이 기간에는 수집되지 않은 지표입니다"
        help="확장 텔레메트리 옵션이 켜진 최신 Claude Code에서만 수집되는 지표입니다. 값이 0이라는 뜻이 아니라 아직 수집된 데이터가 없다는 뜻입니다."
        columns={columns}
        rows={[]}
        exportName={exportName}
      />
    );
  }
  return <DataTable title={title} subtitle={subtitle} help={help} columns={columns} rows={resp.data?.rows || []} exportName={exportName} />;
}

export default function Productivity() {
  const shownGroups = useGroupsShown();
  const { intervalHours, from, to } = useRange();
  const fmtTick = makeTickFmt(intervalHours);
  const kpi = useApi("/api/overview/kpi");
  const norm = useApi("/api/productivity/normalized");
  const decisions = useApi("/api/productivity/decisions");
  const decisionsByTool = useApi("/api/productivity/decisions-by-tool");
  const active = useApi("/api/productivity/active-time");
  const agentic = useApi("/api/productivity/agenticness");
  const engagement = useApi("/api/productivity/engagement");
  const locTrend = useApi("/api/productivity/loc-timeseries");
  const leaderboard = useApi("/api/users/leaderboard");
  const byUserCost = useApi("/api/cost/by-user-model");

  // 사용자별 생산성 표: 유저×그룹 행을 유저 단위로 접고 점수를 재계산(score.js — Executive의
  // 조직 점수와 같은 폴드). 비용은 by-user-model을 유저×그룹으로 접는다 — cost null(단가표 밖
  // 모델)은 0으로(사용자 지시, Cost 페이지의 사용자 표와 동일 규칙).
  const scoreDays = Math.max(1, (to - from) / 86400000);
  const costByUser = new Map();
  for (const r of byUserCost.data || []) {
    const m = costByUser.get(r.user) || {};
    m[r.group] = (m[r.group] || 0) + Number(r.cost || 0);
    costByUser.set(r.user, m);
  }
  const userProductivityRows = foldLeaderboardByUser(leaderboard.data, scoreDays)
    .map((u) => {
      const split = costByUser.get(u.user) || {};
      return { ...u, costByGroup: split, cost: Object.values(split).reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => b.productivity_score - a.productivity_score);
  const userCostMax = userProductivityRows.reduce((m, r) => Math.max(m, r.cost || 0), 0);
  const permissionWait = useApi("/api/productivity/permission-wait");
  const ttft = useApi("/api/productivity/ttft");
  const interactionBreakdown = useApi("/api/productivity/interaction-breakdown");
  const activeSummary = useApi("/api/productivity/active-time-summary");
  const languages = useApi("/api/productivity/languages");

  const activeHours = active.data?.map((r) => ({ ...r, active_seconds: r.active_seconds / 3600 }));

  // decisionsByTool은 group×tool×decision 원본이라 xKey="tool" 막대차트에 그대로 넣으면 전역 그룹
  // 필터가 꺼진 상태(양 그룹 모두)에서 같은 tool/decision 막대가 그룹별로 중복 렌더된다 →
  // "도구별 총량"으로 오독된다. tool+decision으로 합산해 넘긴다(필터가 켜져 한 그룹뿐이면 no-op).
  const decisionsByToolAgg = Object.values(
    (decisionsByTool.data || []).reduce((acc, r) => {
      const k = `${r.tool}|${r.decision}`;
      (acc[k] ||= { tool: r.tool, decision: r.decision, n: 0 }).n += Number(r.n);
      return acc;
    }, {})
  );

  const outcomeTotals = (kpi.data || []).reduce(
    (acc, r) => ({ prs: acc.prs + Number(r.prs), loc: acc.loc + Number(r.lines_of_code) }),
    { prs: 0, loc: 0 }
  );
  const decisionTotals = (decisions.data || []).reduce(
    (acc, r) => ({ accept: acc.accept + (r.decision === "accept" ? Number(r.n) : 0), total: acc.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = decisionTotals.total > 0 ? decisionTotals.accept / decisionTotals.total : 0;

  const activeTotals = (activeSummary.data || []).reduce(
    (acc, r) => ({ user: acc.user + Number(r.user_seconds), cli: acc.cli + Number(r.cli_seconds) }),
    { user: 0, cli: 0 }
  );
  const userHours = activeTotals.user / 3600;
  const cliHours = activeTotals.cli / 3600;

  const langRowsFor = (g) =>
    (languages.data || [])
      .filter((r) => r.group === g && Number(r.edits) > 0)
      .map((r) => ({ ...r, accept_rate: Number(r.accepted) / Number(r.edits) }))
      .sort((a, b) => Number(b.edits) - Number(a.edits))
      .slice(0, 10);

  // leaderboard는 유저×그룹 행(userLeaderboard)이라 그대로 슬라이스하면 두 그룹을 오간
  // 유저(straddler)가 같은 이름으로 중복 노출되고 어느 그룹 점수인지 안 보인다 — 라벨에
  // 그룹을 붙여 구분한다(Users 페이지처럼 그룹별로 아예 나누는 대신, 여기는 조직 전체
  // Top 10 하나로 유지 — 아래 표에 이미 그룹 컬럼이 있는 상세 뷰가 따로 있다).
  const top10ByScore = [...(leaderboard.data || [])]
    .sort((a, b) => Number(b.productivity_score) - Number(a.productivity_score))
    .slice(0, 10)
    .map((r) => ({ ...r, label: `${maskEmail(r.user)} (${r.group})` }));

  return (
    <div>
      <PageHeader
        title="Productivity"
        subtitle="코드 산출물과 작업 시간으로 보는 채널별 생산성"
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        {kpi.loading || decisions.loading ? (
          <Loading />
        ) : kpi.error || decisions.error ? (
          <ErrorBox error={kpi.error || decisions.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label="생성된 PR" value={fmt(outcomeTotals.prs)} variant="accent" />
            <StatTile label="추가 코드 라인" value={fmt(outcomeTotals.loc)} />
            <StatTile label="제안 수락률" value={`${(acceptRate * 100).toFixed(0)}%`} />
            <StatTile
              label="수락된 코드 라인"
              value={fmt(Math.round(outcomeTotals.loc * acceptRate))}
              hint="추가된 코드 라인에 제안 수락률을 적용한 추정치"
            />
          </div>
        )}

        {leaderboard.loading ? (
          <Loading />
        ) : leaderboard.error ? (
          <ErrorBox error={leaderboard.error} />
        ) : (
          <HBarList
            title="생산성 점수 상위 10위"
            subtitle="사용자별 생산성 점수, 100점 만점"
            help="선택한 기간의 하루 평균 추가 코드 라인, 수락률, 하루 평균 커밋 수, 활성일 비율, 하루 평균 세션 수를 각각 30%, 25%, 20%, 15%, 10% 비중으로 합산한 100점 만점 점수입니다. 하루 평균 항목은 코드 라인 300, 커밋 3회, 세션 4회를 기준치로 삼아 그 이상은 만점으로 계산합니다. 수락률은 코드 편집 제안 중 수락된 비율, 활성일 비율은 선택한 기간 중 활동한 날의 비율입니다. 두 채널을 모두 사용한 사용자는 채널별로 따로 집계되어 이름 뒤에 채널이 표시됩니다."
            data={top10ByScore.map((r) => ({ ...r, score: Number(r.productivity_score) }))}
            labelKey="label"
            valueKey="score"
          />
        )}

        {leaderboard.loading ? null : leaderboard.error ? null : (
          <DataTable
            title="사용자별 생산성"
            subtitle="사용자 단위로 합산 · 막대 색은 채널"
            help="선택한 기간의 하루 평균 추가 코드 라인, 수락률, 하루 평균 커밋 수, 활성일 비율, 하루 평균 세션 수를 각각 30%, 25%, 20%, 15%, 10% 비중으로 합산한 100점 만점 점수입니다. 하루 평균 항목은 코드 라인 300, 커밋 3회, 세션 4회를 기준치로 삼아 그 이상은 만점으로 계산합니다. 수락률은 코드 편집 제안 중 수락된 비율, 활성일 비율은 선택한 기간 중 활동한 날의 비율입니다. 두 채널을 모두 사용한 사용자는 원시 지표를 합산한 뒤 점수를 다시 계산합니다. 비용 막대의 색은 채널, 길이는 가장 큰 사용자 대비 비율입니다."
            columns={[
              { key: "user", label: "사용자", render: maskEmail },
              { key: "productivity_score", label: "생산성 점수", render: (v) => Number(v).toFixed(1), bar: true },
              {
                key: "cost",
                label: "비용",
                render: (v, r) => (
                  <span className="inline-flex items-center gap-2">
                    <span className="min-w-[4rem]">{usd(v)}</span>
                    <CostGroupBar split={r.costByGroup} max={userCostMax} />
                  </span>
                ),
                toText: (v, r) => {
                  const split = GROUP_SEGMENT_ORDER.map((g) => (r.costByGroup?.[g] ? `${g} ${usd(r.costByGroup[g])}` : null))
                    .filter(Boolean)
                    .join(" · ");
                  return split ? `${usd(v)} — ${split}` : usd(v);
                },
              },
              { key: "loc", label: "추가 코드 라인", render: fmt, bar: true },
              { key: "commits", label: "커밋", render: fmt },
              { key: "prs", label: "PR", render: fmt },
              { key: "accept_rate", label: "수락률", render: pct, toText: pct },
              { key: "sessions", label: "세션", render: fmt },
              { key: "active_days", label: "활성일", render: fmt },
            ]}
            rows={userProductivityRows}
            exportName="productivity_by_user"
          />
        )}

        {engagement.loading ? (
          <Loading />
        ) : engagement.error ? (
          <ErrorBox error={engagement.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DualLineChart
              title="사용자와 세션 추이"
              subtitle="사용자 수와 세션 수"
              rows={engagement.data}
              xKey="t"
              tickFormatter={fmtTick}
              lines={[
                { key: "users", label: "사용자", axis: "left" },
                { key: "sessions", label: "세션", axis: "right" },
              ]}
            />
            <DualLineChart
              title="사용자당 PR"
              subtitle="사용자 수와 사용자당 PR 수"
              rows={engagement.data}
              xKey="t"
              tickFormatter={fmtTick}
              lines={[
                { key: "users", label: "사용자", axis: "left" },
                { key: "prs_per_user", label: "사용자당 PR", axis: "right" },
              ]}
            />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart
              title="백만 토큰당 추가 코드 라인"
              help="채널 간 비교에는 비용 대신 토큰 사용량 기준으로 정규화한 지표를 사용합니다."
              rows={norm.data}
              valueKey="loc_per_million_tokens"
            />
          )}
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title="백만 토큰당 커밋" rows={norm.data} valueKey="commits_per_million_tokens" />
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title="추가된 코드 라인 추이" rows={locTrend.data} xKey="t" valueKey="loc_added" tickFormatter={fmtTick} />
          )}
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title="제거된 코드 라인 추이" rows={locTrend.data} xKey="t" valueKey="loc_removed" tickFormatter={fmtTick} />
          )}
        </div>

        {decisions.loading ? (
          <Loading />
        ) : decisions.error ? (
          <ErrorBox error={decisions.error} />
        ) : (
          <GroupBarChart
            title="코드 편집 수락/거부"
            subtitle="채널별"
            right={
              <div className="flex gap-2">
                <Badge tone="positive" dot>수락</Badge>
                <Badge tone="negative" dot>거부</Badge>
              </div>
            }
            rows={decisions.data}
            xKey="group"
            valueKey="n"
            colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"}
          />
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {decisionsByTool.loading ? (
            <Loading />
          ) : decisionsByTool.error ? (
            <ErrorBox error={decisionsByTool.error} />
          ) : (
            <GroupBarChart
              title="도구별 수락/거부"
              subtitle="채널 합산"
              right={
                <div className="flex gap-2">
                  <Badge tone="positive" dot>수락</Badge>
                  <Badge tone="negative" dot>거부</Badge>
                </div>
              }
              rows={decisionsByToolAgg}
              xKey="tool"
              valueKey="n"
              colorFn={(r) => STATUS_COLOR[r.decision] || "var(--ink-400)"}
            />
          )}
          {decisionsByTool.loading ? (
            <Loading />
          ) : decisionsByTool.error ? (
            <ErrorBox error={decisionsByTool.error} />
          ) : (
            <SeriesBarChart
              title="도구별 결정 분포"
              subtitle="수락·거부 누적 비교, 채널 합산"
              rows={(decisionsByTool.data || []).map((r) => ({ ...r, decision: decisionLabel(r.decision) }))}
              xKey="tool"
              seriesKey="decision"
              valueKey="n"
            />
          )}
        </div>

        {active.loading ? <Loading /> : active.error ? <ErrorBox error={active.error} /> : (
          <GroupAreaChart title="활성 사용 시간" subtitle="채널별 추이 (단위: 시간)" rows={activeHours} xKey="t" valueKey="active_seconds" tickFormatter={fmtTick} />
        )}

        {activeSummary.loading || kpi.loading ? (
          <Loading />
        ) : activeSummary.error || kpi.error ? (
          <ErrorBox error={activeSummary.error || kpi.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label="개발자 활성 시간" value={`${userHours.toFixed(1)}시간`} hint="개발자가 직접 사용한 시간, 채널 합산" />
            <StatTile label="Claude Code 작업 시간" value={`${cliHours.toFixed(1)}시간`} hint="Claude Code가 작업한 시간, 채널 합산" />
            <StatTile
              label="자동화 배율"
              value={activeTotals.user > 0 ? `×${(activeTotals.cli / activeTotals.user).toFixed(1)}` : "—"}
              variant="accent"
              hint="개발자 사용 1시간당 Claude Code 작업 시간"
            />
            <StatTile
              label="시간당 추가 코드 라인"
              value={userHours > 0 ? fmt(Math.round(outcomeTotals.loc / userHours)) : "—"}
              hint="추가된 코드 라인을 개발자 활성 시간으로 나눈 값"
            />
          </div>
        )}

        {languages.loading ? (
          <Loading />
        ) : languages.error ? (
          <ErrorBox error={languages.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {shownGroups(languages.data).map((g) => (
              <DataTable
                key={g}
                title={`언어별 코드 편집 — ${g}`}
                subtitle="편집 수 상위 10개 언어"
                help="수락률은 전체 편집 중 수락된 편집의 비율입니다."
                columns={LANGUAGE_COLUMNS}
                rows={langRowsFor(g)}
                exportName={`productivity_languages_${g}`}
              />
            ))}
          </div>
        )}

        {agentic.loading ? (
          <Loading />
        ) : agentic.error ? (
          <ErrorBox error={agentic.error} />
        ) : (
          <GroupAreaChart
            title="프롬프트당 도구 호출 수"
            subtitle="높을수록 한 번의 요청에 더 많은 작업을 위임"
            rows={agentic.data}
            xKey="t"
            valueKey="tool_calls_per_prompt"
            tickFormatter={fmtTick}
          />
        )}

        <TracesBetaPanel
          resp={permissionWait}
          title="권한 승인 대기 시간"
          subtitle="사용자 승인을 기다린 시간, Claude Code 버전별"
          help="값이 클수록 권한 확인 때문에 작업이 오래 멈춘다는 뜻입니다."
          columns={PERMISSION_WAIT_COLUMNS}
          exportName="productivity_permission_wait"
        />
        <TracesBetaPanel
          resp={ttft}
          title="첫 응답 시간 (TTFT)"
          subtitle="모델별 첫 토큰 도착까지 걸린 시간"
          help="채널 간 체감 응답 속도를 비교할 때 보는 지표입니다."
          columns={TTFT_COLUMNS}
          exportName="productivity_ttft"
        />
        <TracesBetaPanel
          resp={interactionBreakdown}
          title="인터랙션 시간 구성"
          subtitle="모델 응답, 도구 실행, 권한 대기가 차지한 비중"
          help="각 비중은 인터랙션 전체 시간에 대한 배수입니다. 여러 작업이 동시에 진행될 수 있고 도구 실행 시간에는 권한 대기가 포함되어, 합계가 100%를 넘을 수 있습니다."
          columns={INTERACTION_BREAKDOWN_COLUMNS}
          exportName="productivity_interaction_breakdown"
        />
      </div>
    </div>
  );
}
