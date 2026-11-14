import { localeTag, localize, translate, translateSource, useLocale } from "../i18n/index.js";
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
import { teamSuffix, useTeams, withTeamColumn, withTeams } from "../TeamsContext.jsx";
import { useGroupsShown } from "../useGroupsShown.js";
import { colorFor, GROUP_SEGMENT_ORDER } from "../colors.js";
import { foldLeaderboardByUser, formatActivityScore, ACTIVITY_SCORE_HELP, APPROVAL_HELP } from "../score.js";
import ProductivitySignals from "./ProductivitySignals.jsx";
import { decisionLabel, unclassifiedLabel } from "../labels.js";
import { asSpendRows, sumSpend } from "../spend.js";
import { sumObservedMetric } from "../metricCoverage.js";

const usd = (n) => n == null ? translate("m84dd6e381dca") : `$${Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;

// 비용 셀의 그룹 스택 바 — 한 줄짜리, 색 분할 = 그룹(bedrock/enterprise[/unknown]), 길이 =
// 컬럼 최대 사용자 보고 비용 대비. 확인되지 않은 합계에는 막대를 그리지 않는다.
function CostGroupBar({ split, max }) {
  const _locale = useLocale();
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

const fmt = (n) => n == null ? "—" : Number(n).toLocaleString(localeTag());
const pct = (n) => n == null ? "—" : `${(Number(n) * 100).toFixed(0)}%`;
const STATUS_COLOR = { accept: "var(--positive)", reject: "var(--negative)" };

// 2026-08-11 traces beta 패널(권한대기/TTFT) — 서버가 {unsupported, rows} 모양을 내려준다.
// unsupported=true는 "0"이 아니라 "이 구간엔 해당 스팬이 없음"(베타 미배포 또는 v2.1.214
// 미만)이라는 뜻이라 DataTable의 기본 "데이터 없음"과 구분되는 안내를 별도로 보여준다.
const PERMISSION_WAIT_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "app_version", label: "Claude Code 버전" },
  { key: "p50_wait_ms", label: "p50 대기 (ms)", render: fmt },
  { key: "p95_wait_ms", label: "p95 대기 (ms)", render: fmt },
  { key: "n", label: "샘플 수", render: fmt },
]);

const TTFT_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "model", label: "모델" },
  { key: "p50_ttft_ms", label: "p50 TTFT (ms)", render: fmt },
  { key: "p95_ttft_ms", label: "p95 TTFT (ms)", render: fmt },
  { key: "n", label: "샘플 수", render: fmt },
]);

// 2026-08-31 — 인터랙션 시간 분해. 비중 합계가 1을 넘을 수 있다(자식 스팬은 동시 실행될 수 있고
// tool 스팬 duration_ms는 권한 대기 + 실행을 함께 담는다) — 구성비가 아니라 "인터랙션 총 시간
// 대비 각 종류가 쓴 시간의 배수"다. 100%를 넘는 값이 보이면 버그가 아니다.
const INTERACTION_BREAKDOWN_COLUMNS = localize([
  { key: "group", label: "채널" },
  { key: "interactions", label: "인터랙션 수", render: fmt },
  { key: "p50_interaction_ms", label: "p50 소요 (ms)", render: fmt },
  { key: "p95_interaction_ms", label: "p95 소요 (ms)", render: fmt },
  { key: "llm_share", label: "모델 응답 비중", render: pct, toText: pct },
  { key: "tool_exec_share", label: "도구 실행 비중", render: pct, toText: pct },
  { key: "blocked_share", label: "권한 대기 비중", render: pct, toText: pct },
]);

const LANGUAGE_COLUMNS = localize([
  { key: "language", label: "언어", render: unclassifiedLabel, toText: unclassifiedLabel },
  { key: "edits", label: "편집 수", render: fmt },
  { key: "accept_rate", label: "권한 허용률", render: pct, toText: pct },
]);

function TracesBetaPanel({ resp, title, subtitle, help, columns, exportName }) {
  const _locale = useLocale();
  if (resp.loading) return <Loading />;
  if (resp.error) return <ErrorBox error={resp.error} />;
  if (resp.data?.unsupported) {
    return (
      <DataTable
        title={title}
        subtitle={translate("mc4b581e2627b")}
        help={translate("m1c02908f91d3")}
        columns={columns}
        rows={[]}
        exportName={exportName}
        stale={resp.stale}
      />
    );
  }
  return <DataTable title={title} subtitle={subtitle} help={help} columns={columns} rows={resp.data?.rows || []} exportName={exportName} stale={resp.stale} />;
}

export default function Productivity() {
  const _locale = useLocale();
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
  const teams = useTeams();

  // 사용자별 생산성 표: 유저×그룹 행을 유저 단위로 접고 점수를 재계산(score.js — Executive의
  // 조직 점수와 같은 폴드). 비용은 by-user-model의 보고값을 유저×그룹으로 접는다.
  const scoreDays = Math.max(1, (to - from) / 86400000);
  const costByUser = new Map();
  for (const r of asSpendRows(byUserCost.data || [])) {
    const m = costByUser.get(r.user) || {};
    m[r.group] = sumSpend([{ cost: Object.hasOwn(m, r.group) ? m[r.group] : 0 }, r]);
    costByUser.set(r.user, m);
  }
  const userProductivityRows = foldLeaderboardByUser(leaderboard.data, scoreDays)
    .map((u) => {
      const split = costByUser.get(u.user) || {};
      return { ...u, costByGroup: split, cost: Object.keys(split).length ? sumSpend(Object.values(split).map((cost) => ({ cost }))) : null };
    })
    .sort((a, b) => (a.productivity_score == null) - (b.productivity_score == null) || b.productivity_score - a.productivity_score);
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

  const outcomeTotals = { prs: sumObservedMetric(kpi.data, "prs"), loc: sumObservedMetric(kpi.data, "lines_of_code") };
  const decisionTotals = (decisions.data || []).reduce(
    (acc, r) => ({ accept: acc.accept + (r.decision === "accept" ? Number(r.n) : 0), total: acc.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = decisionTotals.total > 0 ? decisionTotals.accept / decisionTotals.total : null;

  const activeTotals = { user: sumObservedMetric(activeSummary.data, "user_seconds"),
    cli: sumObservedMetric(activeSummary.data, "cli_seconds") };
  const userHours = activeTotals.user == null ? null : activeTotals.user / 3600;
  const cliHours = activeTotals.cli == null ? null : activeTotals.cli / 3600;

  const langRowsFor = (g) =>
    (languages.data || [])
      .filter((r) => r.group === g && Number(r.edits) > 0)
      .map((r) => ({ ...r, accept_rate: Number(r.accepted) / Number(r.edits) }))
      .sort((a, b) => Number(b.edits) - Number(a.edits))
      .slice(0, 10);

  // Top 10은 아래 사용자별 표와 같은 유저 단위 폴드(score.js)를 쓴다 — 유저×그룹 행을 그대로
  // 정렬하면 두 채널을 오간 유저가 같은 이름으로 두 번 오른다. 여러 채널을 쓴 유저만 라벨에
  // 채널 목록을 붙인다.
  const groupsByUser = new Map();
  for (const r of leaderboard.data || []) {
    const set = groupsByUser.get(r.user) || new Set();
    set.add(r.group);
    groupsByUser.set(r.user, set);
  }
  const top10ByScore = userProductivityRows.filter((r) => r.productivity_score != null).slice(0, 10).map((r) => {
    const groups = [...(groupsByUser.get(r.user) || [])].sort();
    const label = groups.length > 1 ? `${maskEmail(r.user)} (${groups.join("+")})` : maskEmail(r.user);
    return { ...r, label: label + teamSuffix(teams, r.user) };
  });

  return (
    <div>
      <PageHeader
        title={translate("mf42bca637cb3")}
        subtitle={translate("ma2e1b970d446")}
        right={<RangePicker />}
      />
      <div className="p-8 flex flex-col gap-4">
        <ProductivitySignals />
        {kpi.loading || decisions.loading ? (
          <Loading />
        ) : kpi.error || decisions.error ? (
          <ErrorBox error={kpi.error || decisions.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label={translate("m3bb7eea13626")} value={kpi.data?.length ? fmt(outcomeTotals.prs) : "—"} variant="accent" />
            <StatTile label={translate("m81ea6a128280")} value={kpi.data?.length ? fmt(outcomeTotals.loc) : "—"} />
            <StatTile label={translate("m928c37dd7e50")} value={pct(acceptRate)} help={translateSource(APPROVAL_HELP)} />
            <StatTile
              label={translate("md2ba40cf73cd")}
              value={decisions.data?.length ? fmt(decisionTotals.total) : "—"}
              hint={translate("m797b8cafc713")}
            />
          </div>
        )}

        {leaderboard.loading ? (
          <Loading />
        ) : leaderboard.error ? (
          <ErrorBox error={leaderboard.error} />
        ) : (
          <HBarList
            title={translate("m462a4adfd34b")}
            subtitle={translate("md61c8caba118")}
            help={translateSource(ACTIVITY_SCORE_HELP)}
            data={top10ByScore.map((r) => ({ ...r, score: Number(r.productivity_score) }))}
            labelKey="label"
            valueKey="score"
          />
        )}

        {leaderboard.loading || leaderboard.error ? null : byUserCost.loading ? (
          <Loading />
        ) : byUserCost.error ? (
          <ErrorBox error={byUserCost.error} />
        ) : (
          <DataTable
            title={translate("m020e65a63b6f")}
            subtitle={translate("m296f47d7d9c5")}
            help={translate("ma7869b1ca074", [translateSource(ACTIVITY_SCORE_HELP)])}
            columns={withTeamColumn([
              { key: "user", label: translate("m1ac6e422b7dc"), render: maskEmail },
              { key: "productivity_score", label: translate("m52542cfd75c0"), render: formatActivityScore, bar: true },
              {
                key: "cost",
                label: translate("m65cd7735272e"),
                render: (v, r) => (
                  <span className="inline-flex items-center gap-2">
                    <span className="min-w-[4rem]">{usd(v)}</span>
                    {v != null && <CostGroupBar split={r.costByGroup} max={userCostMax} />}
                  </span>
                ),
                toText: (v, r) => {
                  if (v == null) return "";
                  const split = GROUP_SEGMENT_ORDER.map((g) => (r.costByGroup?.[g] ? `${g} ${usd(r.costByGroup[g])}` : null))
                    .filter(Boolean)
                    .join(" · ");
                  return split ? `${usd(v)} — ${split}` : usd(v);
                },
              },
              { key: "loc", label: translate("m81ea6a128280"), render: fmt, bar: true },
              { key: "commits", label: translate("ma5d6612cd595"), render: fmt },
              { key: "prs", label: "PR", render: fmt },
              { key: "accept_rate", label: translate("m928c37dd7e50"), render: (value, row) => pct(row.decisions > 0 ? value : null), toText: (value, row) => pct(row.decisions > 0 ? value : null) },
              { key: "sessions", label: translate("me600d4f5926e"), render: fmt },
              { key: "active_days", label: translate("m30b91d8a5785"), render: fmt },
            ], teams)}
            rows={withTeams(userProductivityRows, teams)}
            exportName="productivity_by_user"
            stale={leaderboard.stale || byUserCost.stale}
          />
        )}

        {engagement.loading ? (
          <Loading />
        ) : engagement.error ? (
          <ErrorBox error={engagement.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <DualLineChart
              title={translate("mb66893cb027c")}
              subtitle={translate("md675b25c1f3b")}
              rows={engagement.data}
              xKey="t"
              zoomDisabled={engagement.stale}
              tickFormatter={fmtTick}
              lines={[
                { key: "users", label: translate("m1ac6e422b7dc"), axis: "left" },
                { key: "sessions", label: translate("me600d4f5926e"), axis: "right" },
              ]}
            />
            <DualLineChart
              title={translate("m01f10c9cd708")}
              subtitle={translate("m8e4c88bdd256")}
              rows={engagement.data}
              xKey="t"
              zoomDisabled={engagement.stale}
              tickFormatter={fmtTick}
              lines={[
                { key: "users", label: translate("m1ac6e422b7dc"), axis: "left" },
                { key: "prs_per_user", label: translate("m01f10c9cd708"), axis: "right" },
              ]}
            />
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart
              title={translate("m81c8c032e651")}
              help={translate("m2b22a1c9864b")}
              rows={norm.data}
              valueKey="loc_per_million_tokens"
            />
          )}
          {norm.loading ? <Loading /> : norm.error ? <ErrorBox error={norm.error} /> : (
            <GroupBarChart title={translate("m3590c9eb34e0")} rows={norm.data} valueKey="commits_per_million_tokens" />
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title={translate("md377bcd4903c")} rows={locTrend.data} xKey="t" zoomDisabled={locTrend.stale} valueKey="loc_added" tickFormatter={fmtTick} />
          )}
          {locTrend.loading ? <Loading /> : locTrend.error ? <ErrorBox error={locTrend.error} /> : (
            <GroupAreaChart title={translate("m676dbf1a6b06")} rows={locTrend.data} xKey="t" zoomDisabled={locTrend.stale} valueKey="loc_removed" tickFormatter={fmtTick} />
          )}
        </div>

        {decisions.loading ? (
          <Loading />
        ) : decisions.error ? (
          <ErrorBox error={decisions.error} />
        ) : (
          <GroupBarChart
            title={translate("m4b1fe5163d89")}
            subtitle={translate("mc879db8055fc")}
            right={
              <div className="flex gap-2">
                <Badge tone="positive" dot>{translate("m688200c48345")}</Badge>
                <Badge tone="negative" dot>{translate("me3ecc00b93af")}</Badge>
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
              title={translate("m328cf4c90a1e")}
              subtitle={translate("m8baf32d9c599")}
              right={
                <div className="flex gap-2">
                  <Badge tone="positive" dot>{translate("m688200c48345")}</Badge>
                  <Badge tone="negative" dot>{translate("me3ecc00b93af")}</Badge>
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
              title={translate("mcf866ed32f53")}
              subtitle={translate("m77137c9d3747")}
              rows={(decisionsByTool.data || []).map((r) => ({ ...r, decision: decisionLabel(r.decision) }))}
              xKey="tool"
              seriesKey="decision"
              valueKey="n"
            />
          )}
        </div>

        {active.loading ? <Loading /> : active.error ? <ErrorBox error={active.error} /> : (
          <GroupAreaChart title={translate("mba1ab477a77e")} subtitle={translate("m12514e323812")} rows={activeHours} xKey="t" zoomDisabled={active.stale} valueKey="active_seconds" tickFormatter={fmtTick} />
        )}

        {activeSummary.loading || kpi.loading ? (
          <Loading />
        ) : activeSummary.error || kpi.error ? (
          <ErrorBox error={activeSummary.error || kpi.error} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile label={translate("mefe93359093f")} value={userHours == null ? "—" : translate("m9a58de84ee31", [userHours.toFixed(1)])} hint={translate("m45d1a20d0942")} />
            <StatTile label={translate("me85bac4ab2d8")} value={cliHours == null ? "—" : translate("m9a58de84ee31", [cliHours.toFixed(1)])} hint={translate("m45d1a20d0942")} />
            <StatTile
              label={translate("m3c3f535a641f")}
              value={activeTotals.user > 0 && activeTotals.cli != null ? `×${(activeTotals.cli / activeTotals.user).toFixed(1)}` : "—"}
              variant="accent"
              hint={translate("mde13128436ba")}
            />
            <StatTile
              label={translate("mfec47c59d7f8")}
              value={userHours > 0 && outcomeTotals.loc != null ? fmt(Math.round(outcomeTotals.loc / userHours)) : "—"}
              hint={translate("m9208a513db22")}
            />
          </div>
        )}

        {languages.loading ? (
          <Loading />
        ) : languages.error ? (
          <ErrorBox error={languages.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(languages.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m140169e808f6", [g])}
                subtitle={translate("mc3c56764551b")}
                help={translateSource(APPROVAL_HELP)}
                columns={LANGUAGE_COLUMNS}
                rows={langRowsFor(g)}
                exportName={`productivity_languages_${g}`}
                stale={languages.stale}
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
            title={translate("m4a68fba9a6b6")}
            subtitle={translate("m758b5e927ba1")}
            rows={agentic.data}
            xKey="t"
            zoomDisabled={agentic.stale}
            valueKey="tool_calls_per_prompt"
            tickFormatter={fmtTick}
          />
        )}

        <TracesBetaPanel
          resp={permissionWait}
          title={translate("ma0f69869f2ce")}
          subtitle={translate("m1029ec1abe88")}
          help={translate("m4712d04b5328")}
          columns={PERMISSION_WAIT_COLUMNS}
          exportName="productivity_permission_wait"
        />
        <TracesBetaPanel
          resp={ttft}
          title={translate("m3cadec8f0efb")}
          subtitle={translate("m41f1f59e9594")}
          help={translate("m30ebf95b8d3a")}
          columns={TTFT_COLUMNS}
          exportName="productivity_ttft"
        />
        <TracesBetaPanel
          resp={interactionBreakdown}
          title={translate("m6c492e213b8b")}
          subtitle={translate("mf054bfaac328")}
          help={translate("md629dc8a547f")}
          columns={INTERACTION_BREAKDOWN_COLUMNS}
          exportName="productivity_interaction_breakdown"
        />
      </div>
    </div>
  );
}
