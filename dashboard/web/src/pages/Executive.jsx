import { localeTag, localize, translate, translateSource, useLocale } from "../i18n/index.js";
import { useMemo, useState } from "react";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox, Card } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { SectionLabel } from "../components/SectionLabel.jsx";
import { DualLineChart, DumbbellChart } from "../components/GroupCharts.jsx";
import { ModelCostTrend } from "../components/ModelCostTrend.jsx";
import { SegmentedControl } from "../components/SegmentedControl.jsx";
import ABScoreboard, { fmtValue, DeltaBars } from "../components/ABScoreboard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { useGroupsShown } from "../useGroupsShown.js";
import { makeTickFmt, formatDuration } from "../fmt.js";
import { GROUP_ORDER, modelColorFor } from "../colors.js";
import { foldLeaderboardByUser, averageActivityScore, ACTIVITY_SCORE_HELP, APPROVAL_HELP } from "../score.js";
import { asSpendRows, sumSpend, SPEND_HELP } from "../spend.js";
import { fromByModelDaily, modelLabel } from "../modelCostTrend.js";
import { sumObservedMetric } from "../metricCoverage.js";

const COST_BUCKETS = localize([{ value: "1", label: "시간별" }, { value: "24", label: "일간" }, { value: "168", label: "주간" }]);

const fmt = (n) => n == null ? "—" : Number(n).toLocaleString(localeTag());
const usd = (n) => n == null ? translate("m84dd6e381dca") : `$${Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 0 })}`;

// 생산성 점수 링 게이지 — SVG 원 2개, 점수에 따라 색상 램프.
function ScoreGauge({ score }) {
  const _locale = useLocale();
  const r = 26;
  const c = 2 * Math.PI * r;
  const color = score == null ? "var(--ink-300)" : score >= 70 ? "var(--positive)" : score >= 40 ? "var(--brand-500)" : "var(--negative)";
  return (
    <div className="relative h-16 w-16">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ink-100)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${((score ?? 0) / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center tabular text-[18px] font-semibold text-ink-800">{score == null ? "—" : Math.round(score)}</div>
    </div>
  );
}

export default function Executive() {
  const _locale = useLocale();
  const { from, to } = useRange();
  const { group, model } = useFilters();
  const { groupMode } = useConfig();
  const shownGroups = useGroupsShown();
  // 채널 필터가 걸렸으면 맞세울 상대가 없다 — single 모드와 같은 단일 지표 레이아웃을 쓴다.
  const focusGroup = GROUP_ORDER.includes(group) ? group : null;
  const fmtDaily = makeTickFmt(24); // adoptionTs는 항상 일별 버킷 — range 해상도를 따르지 않는다
  const kpi = useApi("/api/overview/kpi");
  const activeUsers = useApi("/api/overview/active-users");
  const adoption = useApi("/api/adoption/levels");
  const adoptionTs = useApi("/api/adoption/timeseries");
  const costSummary = useApi("/api/cost/summary");
  // Model cost trend bucket: 24h up to 30 days, 168h above (ranges are capped at 90 days). A manual
  // pick belongs to the range it was made in, so a range change restores the default in the same
  // render instead of requesting the old bucket first.
  const rangeKey = `${from.getTime()}|${to.getTime()}`;
  const [costPick, setCostPick] = useState(null);
  const costHours = costPick?.key === rangeKey ? costPick.hours : (to - from) / 86400000 > 30 ? 168 : 24;
  const costDaily = useApi("/api/cost/by-model-daily", { intervalHours: costHours });
  const costCells = useMemo(() => fromByModelDaily(costDaily.data), [costDaily.data, _locale]);
  const userDaily = useApi("/api/cost/by-user-daily", { intervalHours: costHours });
  const userCells = useMemo(() => fromByModelDaily(userDaily.data, { dimension: "user" }), [userDaily.data, _locale]);
  const costCompare = useApi("/api/cost/by-model-compare");
  const decisions = useApi("/api/productivity/decisions");
  const leaderboard = useApi("/api/users/leaderboard");
  const activeTime = useApi("/api/productivity/active-time-summary");

  // leaderboard(orgScore·게이지·헤드라인), adoptionTs(평균/피크 DAU), activeUsers(개발자 수·costPerDev)도
  // 게이트에 포함 — 빠지면 로딩/실패 중에 "생산성 점수 0/100", "활성 개발자 0" 같은 값이 정상 수치처럼
  // 렌더되고 PDF로도 출력된다(경영 보고용 페이지라 특히 위험).
  const loading = kpi.loading || activeUsers.loading || adoption.loading || costSummary.loading || decisions.loading || leaderboard.loading || adoptionTs.loading || activeTime.loading;
  const error = kpi.error || activeUsers.error || adoption.error || costSummary.error || decisions.error || leaderboard.error || adoptionTs.error || activeTime.error;

  const t = (kpi.data || []).reduce(
    (a, r) => ({
      sessions: a.sessions + Number(r.sessions),
      commits: a.commits + Number(r.commits),
      prs: a.prs + Number(r.prs),
      loc: a.loc + Number(r.lines_of_code),
    }),
    { sessions: 0, commits: 0, prs: 0, loc: 0 }
  );
  t.commits = sumObservedMetric(kpi.data, "commits");
  t.prs = sumObservedMetric(kpi.data, "prs");
  t.loc = sumObservedMetric(kpi.data, "lines_of_code");
  // 활성 개발자 수는 ungrouped uniq — 세션 그레인 판별상 그룹별 users 합산은 중복 카운트된다.
  const users = activeUsers.data?.users ?? 0;
  const d = (decisions.data || []).reduce(
    (a, r) => ({ accept: a.accept + (r.decision === "accept" ? Number(r.n) : 0), total: a.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = d.total > 0 ? d.accept / d.total : 0;
  const spendSummary = asSpendRows(costSummary.data || []);
  const cost = sumSpend(spendSummary);

  // 파생 지표 — 전부 이 화면 안에서만 쓰는 클라이언트 계산.
  // days(마지막 프리셋 값)가 아니라 실제 (to-from) 일수를 써야 한다 — 커스텀 드래그 줌 모드에서는
  // from/to가 줌 구간으로 바뀌어도 days는 마지막 프리셋 값(예: 2)에 머물러 있어, days로 나누면
  // 10분 줌에도 "일평균"이 2일 기준으로 계산되는 회귀였다(리뷰에서 MAJOR로 확인 — Cost.jsx는
  // 이미 (to-from) 기준으로 고쳐졌지만 이 페이지는 그대로 남아 있었음).
  const daysInRange = Math.max(1 / 1440, (to - from) / 86400000);
  // sub-day 커스텀 줌(드래그 줌)에서 날짜만 보여주면 from/to가 같은 날짜로 찍혀 구간이 안 보인다
  // (예: 10분 줌이 "7/12 → 7/12"로만 표시) — 1일 미만이면 시각까지 함께 보여준다.
  const formatRangeBoundary = (d) =>
    daysInRange < 1
      ? d.toLocaleString(localeTag(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(localeTag());
  // cost(costSummary)와 users(activeUsers)는 둘 다 excludeUnknown:false라 같은 모수(unknown
  // 세션 포함)를 쓴다(queries.js filterCond 주석 참조) — 분자·분모가 어긋나지 않는다.
  const costPerDev = cost != null && users > 0 ? cost / users : null;
  const dailyAvg = cost == null ? null : cost / daysInRange;
  const projection30d = dailyAvg == null ? null : dailyAvg * 30;
  const costPerKloc = cost != null && t.loc > 0 ? cost / (t.loc / 1000) : null;
  const sessionsPerDevDay = users > 0 ? t.sessions / users / daysInRange : 0;
  // 조직 종합 점수 — 유저 단위 폴드+재계산은 score.js가 소유한다(왜 그룹별 점수 평균이 아닌지,
  // 왜 scoreDays 하한이 1일인지는 그 파일의 주석 참고). Productivity의 사용자별 테이블과 같은
  // 폴드를 공유해야 두 화면의 점수가 어긋나지 않는다.
  const scoreDays = Math.max(1, (to - from) / 86400000);
  const orgScore = averageActivityScore(foldLeaderboardByUser(leaderboard.data, scoreDays));

  const avgDau = (adoptionTs.data || []).length
    ? adoptionTs.data.reduce((a, r) => a + r.dau, 0) / adoptionTs.data.length
    : 0;
  const peakDau = (adoptionTs.data || []).reduce((a, r) => Math.max(a, r.dau), 0);

  // 스코어보드는 그룹 판별된 세션만 맞세운다(unknown 그룹 행 제외) — 위 합계 StatTile들
  // (users/cost 등, excludeUnknown:false)과 모수가 다른 게 의도. 없는 그룹 값은 null → '—'.
  const pickAB = (rows, key) => {
    const v = (grp) => {
      const r = (rows || []).find((x) => x.group === grp);
      return r?.[key] == null ? null : Number(r[key]);
    };
    return { bedrock: v("bedrock"), enterprise: v("enterprise") };
  };
  const abDevs = { bedrock: Number(activeUsers.data?.bedrock_users ?? 0), enterprise: Number(activeUsers.data?.enterprise_users ?? 0) };
  const abCost = pickAB(spendSummary, "cost");
  const abLoc = pickAB(kpi.data?.map((row) => ({
    ...row, lines_of_code: sumObservedMetric([row], "lines_of_code"),
  })), "lines_of_code");
  // active_time.total의 TokenType은 'user'(사람 상호작용 시간)/'cli'(Claude 구동 시간) 분리
  // (실측 7d: cli 123h vs user 2.8h) — "개발자 활성 시간"은 user 쪽, 자동화 배율은 cli÷user.
  const abUserSec = pickAB(activeTime.data?.map((row) => ({
    ...row, user_seconds: sumObservedMetric([row], "user_seconds"),
  })), "user_seconds");
  const abCliSec = pickAB(activeTime.data?.map((row) => ({
    ...row, cli_seconds: sumObservedMetric([row], "cli_seconds"),
  })), "cli_seconds");
  const abAcceptRate = (grp) => {
    const g = (decisions.data || []).filter((r) => r.group === grp);
    const total = g.reduce((a, r) => a + Number(r.n), 0);
    return total > 0 ? g.reduce((a, r) => a + (r.decision === "accept" ? Number(r.n) : 0), 0) / total : null;
  };
  const abCostPerDev = (grp) => (abDevs[grp] > 0 && abCost[grp] != null ? abCost[grp] / abDevs[grp] : null);
  const abAutoRatio = (grp) => (abUserSec[grp] > 0 && abCliSec[grp] != null ? abCliSec[grp] / abUserSec[grp] : null);
  const scoreboardRows = [
    { label: translate("m58fb8b612664"), bedrock: abDevs.bedrock, enterprise: abDevs.enterprise, format: "number", betterIs: "high" },
    { label: translate("mb3349a79f4ca"), bedrock: abCost.bedrock, enterprise: abCost.enterprise, format: "usd", betterIs: null },
    { label: translate("m5c615b8ee780"), bedrock: abCostPerDev("bedrock"), enterprise: abCostPerDev("enterprise"), format: "usd", betterIs: "low" },
    { label: translate("m81ea6a128280"), bedrock: abLoc.bedrock, enterprise: abLoc.enterprise, format: "number", betterIs: "high" },
    { label: translate("m928c37dd7e50"), bedrock: abAcceptRate("bedrock"), enterprise: abAcceptRate("enterprise"), format: "pct", betterIs: null },
    { label: translate("mefe93359093f"), bedrock: abUserSec.bedrock != null ? abUserSec.bedrock / 3600 : null, enterprise: abUserSec.enterprise != null ? abUserSec.enterprise / 3600 : null, format: "hours", betterIs: null },
    { label: translate("m3c3f535a641f"), bedrock: abAutoRatio("bedrock"), enterprise: abAutoRatio("enterprise"), format: "number", betterIs: null },
  ];

  // single 모드에선 맞세울 상대가 없다 — 데이터가 있는 그룹의 값을 그대로 하나만 보여준다.
  // 포맷은 ABScoreboard의 fmtValue를 그대로 쓴다(pct는 0~1 분율 계약, $10 미만은 센트 유지).
  const singleValue = (row) => {
    const g = shownGroups(kpi.data || [])[0];
    return fmtValue(row[g], row.format);
  };

  // single 모드 StatTile의 help 문구 — scoreboardRows(ABScoreboard와 공유)에 필드를 얹는 대신
  // label로 조회하는 별도 맵으로 둔다. docs/metrics.md의 정의 문장과 동일한 어휘를 쓴다.
  const SCOREBOARD_HELP = {
    "활성 개발자": translate("me4687cbbf062"),
    "기간 비용": translateSource(SPEND_HELP),
    "개발자당 비용": translate("m4d1db515feee"),
    "추가 코드 라인": translate("m611508110776"),
    "권한 허용률": translateSource(APPROVAL_HELP),
    "개발자 활성 시간": translate("m26c6d8a3d58b"),
    "CLI / 사용자 활성 시간": translate("mf220a6fe077b"),
  };

  const headline =
    translate("m1d0677e7180f", [formatDuration(daysInRange), fmt(users), fmt(t.sessions)]) +
    translate("mf763ce6c70e9", [fmt(t.loc), fmt(t.commits), fmt(t.prs), d.total > 0 ? `${(acceptRate * 100).toFixed(0)}%` : translate("mdc0c487c9693")]) +
    translate("m95d23e222fe6", [usd(cost), usd(projection30d), orgScore == null ? translate("mdc0c487c9693") : `${Math.round(orgScore)}/100`]);

  // 섹션별로 게이트한다 — 페이지 전체를 가리면 일부만 비어 있을 때도 아무것도 안 보이고,
  // 반대로 게이트가 없으면 신규 설치가 "$0", "0%", "활성 개발자 0"을 실제 측정값처럼 보여준다.
  const peopleEmpty = users === 0 && (adoptionTs.data || []).length === 0 && !adoption.data?.mau;
  const productivityEmpty = (kpi.data || []).length === 0 && (decisions.data || []).length === 0 && (leaderboard.data || []).length === 0;
  const costEmpty = (costSummary.data || []).length === 0;
  const allEmpty = peopleEmpty && productivityEmpty && costEmpty;

  return (
    <div>
      <PageHeader
        title={translate("mf7fb9001d913")}
        subtitle={translate("m560ebaea3849", [formatRangeBoundary(from), formatRangeBoundary(to), formatDuration(daysInRange)])}
        right={
          <div className="flex items-center gap-2 print:hidden">
            <RangePicker />
            <button
              onClick={() => window.print()}
              className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white hover:bg-ink-50 text-ink-600"
            >{translate("m84c20a98e3ff")}</button>
          </div>
        }
      />
      <div className="p-8 flex flex-col gap-5">
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorBox error={error} />
        ) : (
          <>
            {groupMode === "single" || focusGroup ? (
              <Card
                title={focusGroup ? translate("mab3b1fb014c6", [focusGroup]) : translate("mab8a47f2ab01")}
                subtitle={focusGroup ? translate("mcc0ac46b33e2") : translate("mc73feae8d982")}
              >
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {scoreboardRows.map((row) => (
                    <StatTile key={row.label} label={row.label} value={singleValue(row)} help={SCOREBOARD_HELP[row.label]} />
                  ))}
                </div>
              </Card>
            ) : (
              <Card
                title={
                  <>
                    <span className="block text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400 mb-0.5">{translate("m6f166fc7a12d")}</span>{translate("mb709eb065739")}</>
                }
                subtitle={translate("mc73feae8d982")}
              >
                <ABScoreboard rows={scoreboardRows} />
                {/* 스코어보드는 지표당 절대값, 아래 다이버징 바는 지표 간 "격차 크기" 비교 —
                    같은 rows를 두 형태가 나눠 맡는다(중복이 아니라 역할 분담). */}
                <div className="mt-5 border-t border-ink-100 pt-4">
                  <DeltaBars rows={scoreboardRows} />
                </div>
              </Card>
            )}

            <div>
              <SectionLabel>{translate("m1ac6e422b7dc")}</SectionLabel>
              {/* DAU/MAU는 session.count에 Model attribute가 없어 model 필터가 적용되지
                  않는다 — Productivity/Cost 섹션은 필터되므로 침묵 불일치를 배지로 알린다. */}
              {model && (
                <p className="text-[11px] text-warning-text mt-1">{translate("mbd324d40f5a6")}</p>
              )}
              {peopleEmpty ? (
                <EmptyState className="mt-2" />
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                  <StatTile
                    label={translate("m58fb8b612664")}
                    value={fmt(users)}
                    variant="accent"
                    hint={translate("mcba9378102d7")}
                    help={translate("m5776e7a3c599")}
                  />
                  <StatTile
                    label={translate("m204276e29df5")}
                    value={avgDau.toFixed(1)}
                    hint={translate("mb5d991df1d0f", [peakDau])}
                    help={translate("ma4be161d9d50")}
                  />
                  <StatTile
                    label="MAU"
                    value={fmt(adoption.data?.mau)}
                    hint={translate("mdeff26065086", [fmt(adoption.data?.total_members)])}
                    help={translate("mc696b847d43a")}
                  />
                  <StatTile
                    label={translate("me46e89c51d2b")}
                    value={adoption.data?.total_members > 0 ? `${((adoption.data.mau / adoption.data.total_members) * 100).toFixed(0)}%` : "—"}
                    hint={translate("mde3df2dce804")}
                    help={translate("mcf1fbeb99cc7")}
                  />
                </div>
              )}
            </div>

            <div>
              <SectionLabel>{translate("m97e833011434")}</SectionLabel>
              {productivityEmpty ? (
                <EmptyState className="mt-2" />
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                  <StatTile
                    label={translate("m81ea6a128280")}
                    value={fmt(t.loc)}
                    hint={translate("md1cc2fee1b6a", [fmt(t.commits), fmt(t.prs)])}
                    help={translate("m611508110776")}
                  />
                  <StatTile
                    label={translate("m928c37dd7e50")}
                    value={d.total > 0 ? `${(acceptRate * 100).toFixed(0)}%` : "—"}
                    help={translateSource(APPROVAL_HELP)}
                  />
                  <StatTile
                    label={translate("me2de08f0eb7a")}
                    value={sessionsPerDevDay.toFixed(1)}
                    help={translate("m55cf768e10cb")}
                  />
                  <div title={translateSource(ACTIVITY_SCORE_HELP)} className="relative overflow-hidden bg-card border border-ink-100 rounded-lg shadow-card p-4 flex items-center gap-4">
                    <ScoreGauge score={orgScore} />
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{translate("m52542cfd75c0")}</div>
                      <div className="text-[11px] text-ink-400 mt-1">{translate("md6658609969c")}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <SectionLabel>{translate("m24423dd67b3a")}</SectionLabel>
              {costEmpty ? (
                <EmptyState className="mt-2" />
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                    <StatTile
                      label={translate("mb3349a79f4ca")}
                      value={usd(cost)}
                      variant="accent"
                      hint={cost == null ? translate("me9ee0d313d83") : translate("m799bfdfaaf0c", [usd(costPerDev)])}
                      help={translateSource(SPEND_HELP)}
                    />
                    <StatTile
                      label={translate("m0b693e4cf87c")}
                      value={usd(projection30d)}
                      hint={translate("m261fb803c499", [usd(dailyAvg)])}
                      help={translate("md0e101b2e5eb")}
                    />
                    <StatTile
                      label={translate("m3a8baa9d9339")}
                      value={usd(costPerKloc)}
                      help={translate("mcf2a977ec968")}
                    />
                    <StatTile
                      label={translate("ma196eb4073bd")}
                      value={usd(dailyAvg)}
                      help={translate("m122589cc59db")}
                    />
                  </div>
                  {/* 두 기간의 보고값이 모두 확인된 모델만 비교한다. */}
                  {!costCompare.loading && !costCompare.error && (
                    <div className="mt-4">
                      <DumbbellChart
                        title={translate("mb32003ca5083")}
                        subtitle={translate("me29599354cae")}
                        valuePrefix="$"
                        colorOf={modelColorFor}
                        data={asSpendRows(costCompare.data || [])
                          .filter((r) => r.cost != null && r.prev_cost != null)
                          .map((r) => ({ label: modelLabel(r.model), prev: r.prev_cost, cur: r.cost }))
                          .sort((a, b) => Number(b.cur) - Number(a.cur))
                          .slice(0, 10)}
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            <Card>
              {allEmpty ? (
                <EmptyState />
              ) : (
                <p className="text-[14px] leading-relaxed text-ink-800">
                  <span className="font-semibold">{translate("mb4b1e5ae297e")}</span> {headline}
                </p>
              )}
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {adoptionTs.loading ? (
                <Loading />
              ) : adoptionTs.error ? (
                <ErrorBox error={adoptionTs.error} />
              ) : (
                <DualLineChart
                  title={translate("m9a36cd9caa89")}
                  rows={adoptionTs.data}
                  xKey="t"
                  zoomDisabled={adoptionTs.stale}
                  tickFormatter={fmtDaily}
                  bucketHours={24}
                  lines={[{ key: "dau", label: "DAU", axis: "left" }]}
                />
              )}
              {costDaily.loading ? (
                <Loading />
              ) : costDaily.error ? (
                <ErrorBox error={costDaily.error} />
              ) : (
                <ModelCostTrend
                  title={translate("m25cddb8e4cf4")}
                  right={<SegmentedControl options={COST_BUCKETS} value={String(costHours)}
                    onChange={(v) => setCostPick({ key: rangeKey, hours: Number(v) })} />}
                  cells={costCells}
                  help={translateSource(SPEND_HELP)}
                  basis={translate("ma029ac069435")}
                  xKey="t"
                  pinned={model ? [model] : undefined}
                  bucketHours={costHours}
                  zoomDisabled={costDaily.stale}
                  clampRange={[from, null]}
                />
              )}
              {userDaily.loading ? (
                <Loading />
              ) : userDaily.error ? (
                <ErrorBox error={userDaily.error} />
              ) : (
                <ModelCostTrend
                  title={translate("mafd8327e1623")}
                  subtitle={translate("m7d08d8867934")}
                  cells={userCells}
                  help={translateSource(SPEND_HELP)}
                  basis={translate("ma029ac069435")}
                  xKey="t"
                  dimension="user"
                  bucketHours={costHours}
                  zoomDisabled={userDaily.stale}
                  clampRange={[from, null]}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
