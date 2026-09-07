import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox, Card } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { SectionLabel } from "../components/SectionLabel.jsx";
import { DualLineChart, SeriesBarChart, DumbbellChart } from "../components/GroupCharts.jsx";
import ABScoreboard, { fmtValue, DeltaBars } from "../components/ABScoreboard.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { useConfig } from "../ConfigContext.jsx";
import { useGroupsShown } from "../useGroupsShown.js";
import { makeTickFmt, formatDuration } from "../fmt.js";
import { GROUP_ORDER, modelColorFor, byModelLegendOrder } from "../colors.js";
import { foldLeaderboardByUser } from "../score.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// 생산성 점수 링 게이지 — SVG 원 2개, 점수에 따라 색상 램프.
function ScoreGauge({ score }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const color = score >= 70 ? "var(--positive)" : score >= 40 ? "var(--brand-500)" : "var(--negative)";
  return (
    <div className="relative h-16 w-16">
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--ink-100)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center tabular text-[18px] font-semibold text-ink-800">{Math.round(score)}</div>
    </div>
  );
}

export default function Executive() {
  const { from, to, intervalHours } = useRange();
  const { group, model } = useFilters();
  const { groupMode } = useConfig();
  const shownGroups = useGroupsShown();
  // 채널 필터가 걸렸으면 맞세울 상대가 없다 — single 모드와 같은 단일 지표 레이아웃을 쓴다.
  const focusGroup = GROUP_ORDER.includes(group) ? group : null;
  const fmtTick = makeTickFmt(intervalHours);
  const fmtDaily = makeTickFmt(24); // adoptionTs는 항상 일별 버킷 — range 해상도를 따르지 않는다
  const kpi = useApi("/api/overview/kpi");
  const activeUsers = useApi("/api/overview/active-users");
  const adoption = useApi("/api/adoption/levels");
  const adoptionTs = useApi("/api/adoption/timeseries");
  const costSummary = useApi("/api/cost/summary");
  const costDaily = useApi("/api/cost/by-model-daily");
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
  // 활성 개발자 수는 ungrouped uniq — 세션 그레인 판별상 그룹별 users 합산은 중복 카운트된다.
  const users = activeUsers.data?.users ?? 0;
  const d = (decisions.data || []).reduce(
    (a, r) => ({ accept: a.accept + (r.decision === "accept" ? Number(r.n) : 0), total: a.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = d.total > 0 ? d.accept / d.total : 0;
  const cost = (costSummary.data || []).reduce((a, r) => a + Number(r.computed_cost), 0);
  // 단가표에 없는 모델의 토큰은 계산 비용에서 통째로 빠진다 — 지출 타일이 하한선임을 이
  // 화면에서도 알 수 있어야 한다(Cost 페이지는 이미 그룹별로 같은 값을 노출한다).
  const unpricedTokens = (costSummary.data || []).reduce((a, r) => a + Number(r.unpriced_tokens || 0), 0);

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
      ? d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString("ko-KR");
  // cost(costSummary)와 users(activeUsers)는 둘 다 excludeUnknown:false라 같은 모수(unknown
  // 세션 포함)를 쓴다(queries.js filterCond 주석 참조) — 분자·분모가 어긋나지 않는다.
  const costPerDev = users > 0 ? cost / users : 0;
  const dailyAvg = cost / daysInRange;
  const projection30d = dailyAvg * 30;
  const costPerKloc = t.loc > 0 ? cost / (t.loc / 1000) : 0;
  const sessionsPerDevDay = users > 0 ? t.sessions / users / daysInRange : 0;
  // 조직 종합 점수 — 유저 단위 폴드+재계산은 score.js가 소유한다(왜 그룹별 점수 평균이 아닌지,
  // 왜 scoreDays 하한이 1일인지는 그 파일의 주석 참고). Productivity의 사용자별 테이블과 같은
  // 폴드를 공유해야 두 화면의 점수가 어긋나지 않는다.
  const scoreDays = Math.max(1, (to - from) / 86400000);
  const perUserScores = foldLeaderboardByUser(leaderboard.data, scoreDays).map((u) => u.productivity_score);
  const orgScore = perUserScores.length ? perUserScores.reduce((a, s) => a + s, 0) / perUserScores.length : 0;

  const avgDau = (adoptionTs.data || []).length
    ? adoptionTs.data.reduce((a, r) => a + r.dau, 0) / adoptionTs.data.length
    : 0;
  const peakDau = (adoptionTs.data || []).reduce((a, r) => Math.max(a, r.dau), 0);

  // 스코어보드는 그룹 판별된 세션만 맞세운다(unknown 그룹 행 제외) — 위 합계 StatTile들
  // (users/cost 등, excludeUnknown:false)과 모수가 다른 게 의도. 없는 그룹 값은 null → '—'.
  const pickAB = (rows, key) => {
    const v = (grp) => {
      const r = (rows || []).find((x) => x.group === grp);
      return r ? Number(r[key]) : null;
    };
    return { bedrock: v("bedrock"), enterprise: v("enterprise") };
  };
  const abDevs = { bedrock: Number(activeUsers.data?.bedrock_users ?? 0), enterprise: Number(activeUsers.data?.enterprise_users ?? 0) };
  const abCost = pickAB(costSummary.data, "computed_cost");
  const abLoc = pickAB(kpi.data, "lines_of_code");
  // active_time.total의 TokenType은 'user'(사람 상호작용 시간)/'cli'(Claude 구동 시간) 분리
  // (실측 7d: cli 123h vs user 2.8h) — "개발자 활성 시간"은 user 쪽, 자동화 배율은 cli÷user.
  const abUserSec = pickAB(activeTime.data, "user_seconds");
  const abCliSec = pickAB(activeTime.data, "cli_seconds");
  const abAcceptRate = (grp) => {
    const g = (decisions.data || []).filter((r) => r.group === grp);
    const total = g.reduce((a, r) => a + Number(r.n), 0);
    return total > 0 ? g.reduce((a, r) => a + (r.decision === "accept" ? Number(r.n) : 0), 0) / total : null;
  };
  const abCostPerDev = (grp) => (abDevs[grp] > 0 && abCost[grp] != null ? abCost[grp] / abDevs[grp] : null);
  const abAutoRatio = (grp) => (abUserSec[grp] > 0 ? abCliSec[grp] / abUserSec[grp] : null);
  const scoreboardRows = [
    { label: "활성 개발자", bedrock: abDevs.bedrock, enterprise: abDevs.enterprise, format: "number", betterIs: "high" },
    { label: "기간 비용", bedrock: abCost.bedrock, enterprise: abCost.enterprise, format: "usd", betterIs: null },
    { label: "개발자당 비용", bedrock: abCostPerDev("bedrock"), enterprise: abCostPerDev("enterprise"), format: "usd", betterIs: "low" },
    { label: "추가 코드 라인", bedrock: abLoc.bedrock, enterprise: abLoc.enterprise, format: "number", betterIs: "high" },
    { label: "제안 수락률", bedrock: abAcceptRate("bedrock"), enterprise: abAcceptRate("enterprise"), format: "pct", betterIs: "high" },
    { label: "개발자 활성 시간", bedrock: abUserSec.bedrock != null ? abUserSec.bedrock / 3600 : null, enterprise: abUserSec.enterprise != null ? abUserSec.enterprise / 3600 : null, format: "hours", betterIs: null },
    { label: "자동화 배율", bedrock: abAutoRatio("bedrock"), enterprise: abAutoRatio("enterprise"), format: "number", betterIs: "high" },
  ];

  // single 모드에선 맞세울 상대가 없다 — 데이터가 있는 그룹의 값을 그대로 하나만 보여준다.
  // 포맷은 ABScoreboard의 fmtValue를 그대로 쓴다(pct는 0~1 분율 계약, $10 미만은 센트 유지).
  const singleValue = (row) => {
    const g = shownGroups(kpi.data || [])[0];
    return fmtValue(row[g] ?? row.bedrock ?? row.enterprise, row.format);
  };

  // single 모드 StatTile의 help 문구 — scoreboardRows(ABScoreboard와 공유)에 필드를 얹는 대신
  // label로 조회하는 별도 맵으로 둔다. docs/metrics.md의 정의 문장과 동일한 어휘를 쓴다.
  const SCOREBOARD_HELP = {
    "활성 개발자": "선택한 기간에 세션이 1건 이상 있었던 개발자 수입니다. 채널이 판별된 세션만 집계합니다.",
    "기간 비용": "토큰 사용량에 모델 단가를 적용해 계산한 기간 비용입니다. 채널이 판별된 세션만 집계합니다.",
    "개발자당 비용": "채널별 비용을 해당 채널의 활성 개발자 수로 나눈 값입니다.",
    "추가 코드 라인": "선택한 기간에 추가된 코드 라인 수의 합계입니다.",
    "제안 수락률": "Claude Code가 제안한 코드 편집 중 수락된 비율입니다.",
    "개발자 활성 시간": "개발자가 Claude Code와 직접 상호작용한 시간입니다. Claude Code가 작업을 수행한 시간은 포함하지 않습니다.",
    "자동화 배율": "Claude Code가 작업을 수행한 시간을 개발자 활성 시간으로 나눈 값입니다.",
  };

  const headline =
    `선택한 ${formatDuration(daysInRange)} 동안 ${fmt(users)}명의 개발자가 ${fmt(t.sessions)}개 세션에서 ` +
    `코드 ${fmt(t.loc)}라인(커밋 ${fmt(t.commits)}건, PR ${fmt(t.prs)}건)을 작성했으며 제안 수락률은 ${(acceptRate * 100).toFixed(0)}%입니다. ` +
    `기간 비용은 ${usd(cost)}이며, 현재 추세가 이어지면 30일 기준 ${usd(projection30d)}로 예상됩니다. 조직 생산성 점수는 ${Math.round(orgScore)}/100입니다.`;

  // 섹션별로 게이트한다 — 페이지 전체를 가리면 일부만 비어 있을 때도 아무것도 안 보이고,
  // 반대로 게이트가 없으면 신규 설치가 "$0", "0%", "활성 개발자 0"을 실제 측정값처럼 보여준다.
  const peopleEmpty = users === 0 && (adoptionTs.data || []).length === 0 && !adoption.data?.mau;
  const productivityEmpty = (kpi.data || []).length === 0 && (decisions.data || []).length === 0 && (leaderboard.data || []).length === 0;
  const costEmpty = (costSummary.data || []).length === 0;
  const allEmpty = peopleEmpty && productivityEmpty && costEmpty;

  return (
    <div>
      <PageHeader
        title="Executive"
        subtitle={`${formatRangeBoundary(from)} → ${formatRangeBoundary(to)} (${formatDuration(daysInRange)}) 기준`}
        right={
          <div className="flex items-center gap-2 print:hidden">
            <RangePicker />
            <button
              onClick={() => window.print()}
              className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white hover:bg-ink-50 text-ink-600"
            >
              PDF 저장
            </button>
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
                title={focusGroup ? `핵심 지표 — ${focusGroup}` : "핵심 지표"}
                subtitle={focusGroup ? "상단 채널 필터 적용 · 채널이 판별된 세션 기준" : "채널이 판별된 세션 기준, 미분류 세션 제외"}
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
                    <span className="block text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400 mb-0.5">A/B 실험 현황</span>
                    Bedrock vs Enterprise 스코어보드
                  </>
                }
                subtitle="채널이 판별된 세션 기준, 미분류 세션 제외"
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
              <SectionLabel>사용자</SectionLabel>
              {/* DAU/MAU는 session.count에 Model attribute가 없어 model 필터가 적용되지
                  않는다 — Productivity/Cost 섹션은 필터되므로 침묵 불일치를 배지로 알린다. */}
              {model && (
                <p className="text-[11px] text-warning-text mt-1">모델 필터는 사용자 지표에 적용되지 않습니다. 아래 값은 전체 모델 기준입니다.</p>
              )}
              {peopleEmpty ? (
                <EmptyState className="mt-2" />
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                  <StatTile
                    label="활성 개발자"
                    value={fmt(users)}
                    variant="accent"
                    hint="기간 내 세션 1건 이상"
                    help="선택한 기간에 세션이 1건 이상 있었던 개발자 수입니다. 채널이 판별되지 않은 세션도 포함합니다."
                  />
                  <StatTile
                    label="평균 DAU"
                    value={avgDau.toFixed(1)}
                    hint={`최대 ${peakDau}`}
                    help="선택한 기간의 일간 활성 사용자 수 평균입니다."
                  />
                  <StatTile
                    label="MAU"
                    value={fmt(adoption.data?.mau)}
                    hint={`전체 사용자 ${fmt(adoption.data?.total_members)}`}
                    help="기간 종료 시점 기준 최근 30일 안에 세션이 있었던 사용자 수입니다."
                  />
                  <StatTile
                    label="월간 도입률"
                    value={adoption.data?.total_members > 0 ? `${((adoption.data.mau / adoption.data.total_members) * 100).toFixed(0)}%` : "—"}
                    hint="MAU ÷ 전체 사용자"
                    help="MAU를 기간 종료 시점까지 텔레메트리에 기록된 전체 사용자 수로 나눈 비율입니다."
                  />
                </div>
              )}
            </div>

            <div>
              <SectionLabel>생산성</SectionLabel>
              {productivityEmpty ? (
                <EmptyState className="mt-2" />
              ) : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                  <StatTile
                    label="추가 코드 라인"
                    value={fmt(t.loc)}
                    hint={`커밋 ${fmt(t.commits)} · PR ${fmt(t.prs)}`}
                    help="선택한 기간에 추가된 코드 라인 수의 합계입니다."
                  />
                  <StatTile
                    label="제안 수락률"
                    value={`${(acceptRate * 100).toFixed(0)}%`}
                    help="Claude Code가 제안한 코드 편집 중 수락된 비율입니다."
                  />
                  <StatTile
                    label="개발자당 일평균 세션"
                    value={sessionsPerDevDay.toFixed(1)}
                    help="세션 수를 활성 개발자 수와 기간의 일수로 나눈 값입니다."
                  />
                  <div className="relative overflow-hidden bg-card border border-ink-100 rounded-lg shadow-card p-4 flex items-center gap-4">
                    <ScoreGauge score={orgScore} />
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">생산성 점수</div>
                      <div className="text-[11px] text-ink-400 mt-1">사용자별 점수 평균 (0–100)</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <SectionLabel>비용</SectionLabel>
              {costEmpty ? (
                <EmptyState className="mt-2" />
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                    <StatTile
                      label="기간 비용"
                      value={usd(cost)}
                      variant="accent"
                      hint={unpricedTokens > 0 ? `개발자당 ${usd(costPerDev)} · 단가 미등록 토큰 ${fmt(unpricedTokens)}개 제외` : `개발자당 ${usd(costPerDev)}`}
                      help="토큰 사용량에 모델 단가를 적용해 계산한 기간 비용으로, 채널이 판별되지 않은 세션도 포함합니다. 수집된 사용량으로 계산한 비용이며 실제 청구액과 다를 수 있습니다."
                    />
                    <StatTile
                      label="30일 예상 비용"
                      value={usd(projection30d)}
                      hint={`일평균 ${usd(dailyAvg)} × 30일`}
                      help="선택한 기간의 일평균 비용을 30일 기준으로 환산한 값입니다."
                    />
                    <StatTile
                      label="코드 1,000라인당 비용"
                      value={usd(costPerKloc)}
                      help="기간 비용을 추가된 코드 라인 수로 나눠 1,000라인 기준으로 환산한 값입니다."
                    />
                    <StatTile
                      label="일평균 비용"
                      value={usd(dailyAvg)}
                      help="기간 비용을 기간의 일수로 나눈 값입니다."
                    />
                  </div>
                  {/* 전기간 대비는 항목별 before→after — 덤벨이 그 일의 기본형(dataviz). 미산정
                      모델(cost null)은 DumbbellChart가 걸러낸다. */}
                  {!costCompare.loading && !costCompare.error && (
                    <div className="mt-4">
                      <DumbbellChart
                        title="모델별 비용 — 전기간 대비"
                        subtitle="회색 점은 직전 같은 길이의 기간, 색 점은 이번 기간"
                        valuePrefix="$"
                        colorOf={modelColorFor}
                        data={(costCompare.data || [])
                          .filter((r) => r.cost !== null)
                          .map((r) => ({ label: r.model, prev: r.prev_cost, cur: r.cost }))
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
                  <span className="font-semibold">요약:</span> {headline}
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
                  title="일간 활성 사용자"
                  rows={adoptionTs.data}
                  xKey="t"
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
                <SeriesBarChart
                  title="모델별 비용 추이"
                  rows={costDaily.data}
                  xKey="day"
                  seriesKey="model"
                  valueKey="cost"
                  colorOf={modelColorFor}
                  seriesSort={byModelLegendOrder}
                  tickFormatter={fmtTick}
                  valuePrefix="$"
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
