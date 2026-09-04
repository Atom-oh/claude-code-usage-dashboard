import { Badge } from "../components/Badge.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { GroupAreaChart, GroupBarChart, DualLineChart, SeriesBarChart, HBarList } from "../components/GroupCharts.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { BarTip } from "../components/BarTip.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useConfig } from "../ConfigContext.jsx";
import { useRange } from "../RangeContext.jsx";
import { makeTickFmt, maskEmail } from "../fmt.js";
import { groupsShown } from "../pivot.js";
import { colorFor, GROUP_SEGMENT_ORDER } from "../colors.js";
import { foldLeaderboardByUser } from "../score.js";

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
  { key: "group", label: "그룹" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "p50_wait_ms", label: "p50 대기(ms)", render: fmt },
  { key: "p95_wait_ms", label: "p95 대기(ms)", render: fmt },
  { key: "n", label: "샘플 수", render: fmt },
];

const TTFT_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "model", label: "모델" },
  { key: "p50_ttft_ms", label: "p50 TTFT(ms)", render: fmt },
  { key: "p95_ttft_ms", label: "p95 TTFT(ms)", render: fmt },
  { key: "n", label: "샘플 수", render: fmt },
];

// 2026-08-31 — 인터랙션 시간 분해. 비중 합계가 1을 넘을 수 있다(자식 스팬은 동시 실행될 수 있고
// tool 스팬 duration_ms는 권한 대기 + 실행을 함께 담는다) — 구성비가 아니라 "인터랙션 총 시간
// 대비 각 종류가 쓴 시간의 배수"다. 100%를 넘는 값이 보이면 버그가 아니다.
const INTERACTION_BREAKDOWN_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "interactions", label: "인터랙션 수", render: fmt },
  { key: "p50_interaction_ms", label: "p50 소요(ms)", render: fmt },
  { key: "p95_interaction_ms", label: "p95 소요(ms)", render: fmt },
  { key: "llm_share", label: "LLM 비중", render: pct, toText: pct },
  { key: "tool_exec_share", label: "툴 실행 비중", render: pct, toText: pct },
  { key: "blocked_share", label: "권한 대기 비중", render: pct, toText: pct },
];

const LANGUAGE_COLUMNS = [
  { key: "language", label: "언어" },
  { key: "edits", label: "편집", render: fmt },
  { key: "accept_rate", label: "수락률", render: pct, toText: pct },
];

function TracesBetaPanel({ resp, title, subtitle, columns, exportName }) {
  if (resp.loading) return <Loading />;
  if (resp.error) return <ErrorBox error={resp.error} />;
  if (resp.data?.unsupported) {
    return (
      <DataTable
        title={title}
        subtitle={`${subtitle} — 데이터 없음: traces beta(CLAUDE_CODE_ENHANCED_TELEMETRY_BETA)가 아직 이 구간에 배포되지 않았거나${resp.data.minVersion ? `, 이 스팬 자체가 Claude Code v${resp.data.minVersion} 미만에서는 나오지 않습니다` : "요"} — 0이 아니라 "미수집"입니다.`}
        columns={columns}
        rows={[]}
        exportName={exportName}
      />
    );
  }
  return <DataTable title={title} subtitle={subtitle} columns={columns} rows={resp.data?.rows || []} exportName={exportName} />;
}

export default function Productivity() {
  const { groupMode } = useConfig();
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
        subtitle="비용(cost.usage)은 근사치라 A/B 비교에 쓰지 않는다 — 토큰 정규화 지표로 대체"
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
            <StatTile label="작성된 라인 수" value={fmt(outcomeTotals.loc)} />
            <StatTile label="제안 수락률" value={`${(acceptRate * 100).toFixed(0)}%`} />
            <StatTile
              label="수락된 라인 수"
              value={fmt(Math.round(outcomeTotals.loc * acceptRate))}
              hint="추정치: 작성 라인 × 수락률"
            />
          </div>
        )}

        {leaderboard.loading ? (
          <Loading />
        ) : leaderboard.error ? (
          <ErrorBox error={leaderboard.error} />
        ) : (
          <HBarList
            title="사용자별 생산성 — Top 10"
            subtitle="점수 = 100 × (0.30×LOC/day + 0.25×수락률 + 0.20×commits/day + 0.15×활성일비율 + 0.10×sessions/day) — 유저×그룹별 행(두 그룹을 오간 유저는 그룹당 1행)"
            data={top10ByScore.map((r) => ({ ...r, score: Number(r.productivity_score) }))}
            labelKey="label"
            valueKey="score"
          />
        )}

        {leaderboard.loading ? null : leaderboard.error ? null : (
          <DataTable
            title="사용자별 생산성"
            subtitle="유저당 1행(두 그룹을 오간 유저는 raw 지표 합산 후 점수 재계산 — score.js) · 비용 막대: 색 분할 = 그룹, 길이 = 최대 사용자 대비"
            columns={[
              { key: "user", label: "유저", render: maskEmail },
              { key: "productivity_score", label: "생산성 점수", render: (v) => Number(v).toFixed(1), bar: true },
              {
                key: "cost",
                label: "비용 (계산)",
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
              { key: "loc", label: "추가 라인", render: fmt, bar: true },
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
              title="도입률"
              subtitle="사용자 수 vs 세션 수"
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
              subtitle="사용자 수 vs 사용자당 PR 수"
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
            <GroupBarChart title="추가 라인 / 백만 토큰" rows={norm.data} valueKey="loc_per_million_tokens" />
          )}
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title="커밋 / 백만 토큰" rows={norm.data} valueKey="commits_per_million_tokens" />
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title="추가된 라인 (일별)" rows={locTrend.data} xKey="t" valueKey="loc_added" tickFormatter={fmtTick} />
          )}
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title="제거된 라인 (일별)" rows={locTrend.data} xKey="t" valueKey="loc_removed" tickFormatter={fmtTick} />
          )}
        </div>

        {decisions.loading ? (
          <Loading />
        ) : decisions.error ? (
          <ErrorBox error={decisions.error} />
        ) : (
          <GroupBarChart
            title="코드 편집 수락/거부"
            subtitle="그룹별"
            right={
              <div className="flex gap-2">
                <Badge tone="positive" dot>accept</Badge>
                <Badge tone="negative" dot>reject</Badge>
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
              subtitle="실측: Edit / Write (multi_edit·notebook_edit은 위 값 미확인)"
              right={
                <div className="flex gap-2">
                  <Badge tone="positive" dot>accept</Badge>
                  <Badge tone="negative" dot>reject</Badge>
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
              title="툴 별 수락/거부"
              subtitle="edit / multi_edit / write / notebook_edit — 그룹 합산"
              rows={decisionsByTool.data}
              xKey="tool"
              seriesKey="decision"
              valueKey="n"
            />
          )}
        </div>

        {active.loading ? <Loading /> : active.error ? <ErrorBox error={active.error} /> : (
          <GroupAreaChart title="활성 사용 시간" subtitle="시간, 그룹별 시계열" rows={activeHours} xKey="t" valueKey="active_seconds" tickFormatter={fmtTick} />
        )}

        {activeSummary.loading || kpi.loading ? (
          <Loading />
        ) : activeSummary.error || kpi.error ? (
          <ErrorBox error={activeSummary.error || kpi.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label="개발자 활성 시간" value={`${userHours.toFixed(1)}h`} hint="active_time.total 중 user 시간, 그룹 합산" />
            <StatTile label="CLI 구동 시간" value={`${cliHours.toFixed(1)}h`} hint="active_time.total 중 cli 시간, 그룹 합산" />
            <StatTile
              label="자동화 배율"
              value={activeTotals.user > 0 ? `×${(activeTotals.cli / activeTotals.user).toFixed(1)}` : "—"}
              variant="accent"
              hint="개발자가 지켜본 1시간당 CLI가 일한 시간"
            />
            <StatTile
              label="시간당 작성 라인"
              value={userHours > 0 ? fmt(Math.round(outcomeTotals.loc / userHours)) : "—"}
              hint="작성 라인 ÷ 개발자 활성 시간"
            />
          </div>
        )}

        {languages.loading ? (
          <Loading />
        ) : languages.error ? (
          <ErrorBox error={languages.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, languages.data).map((g) => (
              <DataTable
                key={g}
                title={`언어별 코드 편집 — ${g}`}
                subtitle="편집 수 상위 10개 언어 — 수락률 = accept 결정 ÷ 전체 편집"
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
            title="에이전틱함"
            subtitle="프롬프트 1개당 평균 툴 호출 수 — 높을수록 더 많이 위임하는 것 (user_prompt 이벤트 실측 필요)"
            rows={agentic.data}
            xKey="t"
            valueKey="tool_calls_per_prompt"
            tickFormatter={fmtTick}
          />
        )}

        <TracesBetaPanel
          resp={permissionWait}
          title="권한 대기 오버헤드"
          subtitle="claude_code.tool.blocked_on_user 대기 시간 — 크면 권한 설정이 생산성을 깎고 있다는 뜻"
          columns={PERMISSION_WAIT_COLUMNS}
          exportName="productivity_permission_wait"
        />
        <TracesBetaPanel
          resp={ttft}
          title="TTFT (첫 토큰까지 시간)"
          subtitle="Bedrock vs Enterprise 체감 응답성 비교에 가장 직접적인 지표"
          columns={TTFT_COLUMNS}
          exportName="productivity_ttft"
        />
        <TracesBetaPanel
          resp={interactionBreakdown}
          title="인터랙션 시간 분해"
          subtitle="느린 원인이 모델(llm_request)인지, 툴 실행(tool.execution)인지, 권한 대기(tool.blocked_on_user)인지를 가른다 — 비중 합계는 1을 넘을 수 있다"
          columns={INTERACTION_BREAKDOWN_COLUMNS}
          exportName="productivity_interaction_breakdown"
        />
      </div>
    </div>
  );
}
