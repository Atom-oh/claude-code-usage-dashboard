import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox, Card } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { SectionLabel } from "../components/SectionLabel.jsx";
import { DualLineChart, SeriesBarChart } from "../components/GroupCharts.jsx";
import { useApi } from "../useApi.js";
import { useRange } from "../RangeContext.jsx";
import { useFilters } from "../FilterContext.jsx";
import { makeTickFmt } from "../fmt.js";

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
  const { from, to, days, intervalHours } = useRange();
  const { model } = useFilters();
  const fmtTick = makeTickFmt(intervalHours);
  const kpi = useApi("/api/overview/kpi");
  const adoption = useApi("/api/adoption/levels");
  const adoptionTs = useApi("/api/adoption/timeseries");
  const costSummary = useApi("/api/cost/summary");
  const costDaily = useApi("/api/cost/by-model-daily");
  const decisions = useApi("/api/productivity/decisions");
  const leaderboard = useApi("/api/users/leaderboard");

  // leaderboard(orgScore·게이지·헤드라인)와 adoptionTs(평균/피크 DAU)도 게이트에 포함 —
  // 빠지면 로딩/실패 중에 "생산성 점수 0/100", "평균 DAU 0.0"이 정상 수치처럼 렌더되고
  // PDF로도 출력된다(경영 보고용 페이지라 특히 위험).
  const loading = kpi.loading || adoption.loading || costSummary.loading || decisions.loading || leaderboard.loading || adoptionTs.loading;
  const error = kpi.error || adoption.error || costSummary.error || decisions.error || leaderboard.error || adoptionTs.error;

  const t = (kpi.data || []).reduce(
    (a, r) => ({
      users: a.users + Number(r.users),
      sessions: a.sessions + Number(r.sessions),
      commits: a.commits + Number(r.commits),
      prs: a.prs + Number(r.prs),
      loc: a.loc + Number(r.lines_of_code),
    }),
    { users: 0, sessions: 0, commits: 0, prs: 0, loc: 0 }
  );
  const d = (decisions.data || []).reduce(
    (a, r) => ({ accept: a.accept + (r.decision === "accept" ? Number(r.n) : 0), total: a.total + Number(r.n) }),
    { accept: 0, total: 0 }
  );
  const acceptRate = d.total > 0 ? d.accept / d.total : 0;
  const cost = (costSummary.data || []).reduce((a, r) => a + Number(r.computed_cost), 0);

  // 파생 지표 — 전부 이 화면 안에서만 쓰는 클라이언트 계산.
  const costPerDev = t.users > 0 ? cost / t.users : 0;
  const dailyAvg = cost / Math.max(1, days);
  const projection30d = dailyAvg * 30;
  const costPerKloc = t.loc > 0 ? cost / (t.loc / 1000) : 0;
  const sessionsPerDevDay = t.users > 0 ? t.sessions / t.users / Math.max(1, days) : 0;
  // 조직 종합 점수 — 리더보드 개인 점수(productivity.js와 동일 공식)의 평균.
  const orgScore = (leaderboard.data || []).length
    ? leaderboard.data.reduce((a, r) => a + Number(r.productivity_score), 0) / leaderboard.data.length
    : 0;

  const avgDau = (adoptionTs.data || []).length
    ? adoptionTs.data.reduce((a, r) => a + r.dau, 0) / adoptionTs.data.length
    : 0;
  const peakDau = (adoptionTs.data || []).reduce((a, r) => Math.max(a, r.dau), 0);

  const headline =
    `지난 ${days}일간 ${fmt(t.users)}명의 개발자가 ${fmt(t.sessions)}개 세션에서 ` +
    `${fmt(t.loc)} 라인(커밋 ${fmt(t.commits)}건, PR ${fmt(t.prs)}건)을 작성했으며 제안 수락률은 ${(acceptRate * 100).toFixed(0)}%입니다. ` +
    `기간 지출은 ${usd(cost)}, 현재 추세로는 30일 기준 ${usd(projection30d)}가 예상됩니다. 조직 생산성 점수는 ${Math.round(orgScore)}/100입니다.`;

  return (
    <div>
      <PageHeader
        title="Executive"
        subtitle={`${from.toLocaleDateString("ko-KR")} → ${to.toLocaleDateString("ko-KR")} (${days}일) — 모든 KPI는 선택 기간 집계`}
        right={
          <div className="flex items-center gap-2 print:hidden">
            <RangePicker />
            <button
              onClick={() => window.print()}
              className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white hover:bg-ink-50 text-ink-600"
            >
              PDF
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
            <div>
              <SectionLabel>People</SectionLabel>
              {/* DAU/MAU는 session.count에 Model attribute가 없어 model 필터가 적용되지
                  않는다 — Productivity/Cost 섹션은 필터되므로 침묵 불일치를 배지로 알린다. */}
              {model && (
                <p className="text-[11px] text-warning-text mt-1">⚠ model 필터는 People 지표에 적용되지 않습니다(전체 모델 기준)</p>
              )}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                <StatTile label="활성 개발자" value={fmt(t.users)} variant="accent" hint="기간 내 세션 1건 이상" />
                <StatTile label="평균 DAU" value={avgDau.toFixed(1)} hint={`피크 ${peakDau}`} />
                <StatTile label="MAU" value={fmt(adoption.data?.mau)} hint={`전체 멤버 ${fmt(adoption.data?.total_members)}`} />
                <StatTile
                  label="월간 도입률"
                  value={adoption.data?.total_members > 0 ? `${((adoption.data.mau / adoption.data.total_members) * 100).toFixed(0)}%` : "—"}
                  hint="MAU ÷ 전체 멤버"
                />
              </div>
            </div>

            <div>
              <SectionLabel>Productivity</SectionLabel>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                <StatTile label="작성 라인" value={fmt(t.loc)} hint={`커밋 ${fmt(t.commits)} · PR ${fmt(t.prs)}`} />
                <StatTile label="제안 수락률" value={`${(acceptRate * 100).toFixed(0)}%`} />
                <StatTile label="세션/개발자/일" value={sessionsPerDevDay.toFixed(1)} />
                <div className="relative overflow-hidden bg-card border border-ink-100 rounded-lg shadow-card p-4 flex items-center gap-4">
                  <ScoreGauge score={orgScore} />
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">생산성 점수</div>
                    <div className="text-[11px] text-ink-400 mt-1">개인 점수 평균 (0–100)</div>
                  </div>
                </div>
              </div>
            </div>

            <div>
              <SectionLabel>Cost</SectionLabel>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                <StatTile label="기간 지출 (계산)" value={usd(cost)} variant="accent" hint={`${usd(costPerDev)}/개발자`} />
                <StatTile label="30일 프로젝션" value={usd(projection30d)} hint={`일평균 ${usd(dailyAvg)} × 30`} />
                <StatTile label="Cost / 1K LOC" value={usd(costPerKloc)} hint="지출 ÷ (라인 ÷ 1000)" />
                <StatTile label="일평균 지출" value={usd(dailyAvg)} />
              </div>
            </div>

            <Card>
              <p className="text-[14px] leading-relaxed text-ink-800">
                <span className="font-semibold">요약:</span> {headline}
              </p>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
              {adoptionTs.loading ? (
                <Loading />
              ) : adoptionTs.error ? (
                <ErrorBox error={adoptionTs.error} />
              ) : (
                <DualLineChart
                  title="일간 활성 유저"
                  rows={adoptionTs.data}
                  xKey="t"
                  tickFormatter={fmtTick}
                  lines={[{ key: "dau", label: "DAU", axis: "left" }]}
                />
              )}
              {costDaily.loading ? (
                <Loading />
              ) : costDaily.error ? (
                <ErrorBox error={costDaily.error} />
              ) : (
                <SeriesBarChart
                  title="일별 지출 (모델별)"
                  rows={costDaily.data}
                  xKey="day"
                  seriesKey="model"
                  valueKey="cost"
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
