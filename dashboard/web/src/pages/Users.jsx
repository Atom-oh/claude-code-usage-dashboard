import { useEffect, useState } from "react";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { UserDrawer } from "../components/UserDrawer.jsx";
import { HBarList } from "../components/GroupCharts.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { GROUP_ORDER, colorFor, FAMILY_LEGEND_ORDER, familyColorFor, modelFamily } from "../colors.js";
import { topPerUser } from "../pivot.js";
import { useApi } from "../useApi.js";
import { maskEmail } from "../fmt.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const usd = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (n) => `${(Number(n) * 100).toFixed(0)}%`;

// bedrock/enterprise 대결 밴드 — 이 대시보드의 정체성(A/B 실험)을 Users 페이지 상단에도 드러낸다.
// 검색창(q) 필터는 적용하지 않는다 — 그룹 전체의 인원/수락률 등 요약 지표라 이름 검색과 무관해야 함.
// 인원(count)은 straddler(두 그룹 모두 세션이 있는 유저)를 양쪽에 셀 수 있다 — leaderboard가
// 유저×그룹으로 행이 갈라져 있기 때문(GROUP_ORDER 합계 ≥ distinct 유저 수).
function GroupFaceOff({ rows }) {
  const stats = GROUP_ORDER.map((g) => {
    const grows = (rows || []).filter((r) => r.group === g);
    const decisions = grows.reduce((s, r) => s + Number(r.decisions || 0), 0);
    const accepted = grows.reduce((s, r) => s + Number(r.accepted || 0), 0);
    return {
      group: g,
      count: grows.length,
      avgScore: grows.length ? grows.reduce((s, r) => s + Number(r.productivity_score || 0), 0) / grows.length : 0,
      sessions: grows.reduce((s, r) => s + Number(r.sessions || 0), 0),
      // 행별 accept_rate 단순 평균이 아니라 accepted/decisions 가중 평균 — 결정 수가 다른 유저를 동일 비중으로 섞지 않는다.
      acceptRate: decisions > 0 ? accepted / decisions : 0,
    };
  });

  return (
    <Card padded={false}>
      <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-ink-100">
        {stats.map((s, i) => (
          <div key={s.group} className="relative flex-1">
            {i === 1 && (
              <span className="absolute -left-3 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-ink-100 bg-card text-[10px] font-semibold text-ink-400 md:flex">
                vs
              </span>
            )}
            <div className="p-4" style={{ background: `color-mix(in srgb, ${colorFor(s.group)} 8%, transparent)` }}>
              <div className="mb-3 flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colorFor(s.group) }} />
                <span className="text-[13px] font-semibold capitalize text-ink-800">{s.group}</span>
              </div>
              {s.count === 0 ? (
                <div className="text-[12px] text-ink-400">데이터 없음</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[11px] text-ink-500">인원</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{fmt(s.count)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-500">평균 생산성 점수</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{s.avgScore.toFixed(1)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-500">세션</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{fmt(s.sessions)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-500">수락률</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{pct(s.acceptRate)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Users() {
  const [q, setQ] = useState("");
  // 클릭한 유저 email+group만 저장하고 헤더/StatTile용 row는 현재 leaderboard에서 파생한다 — row
  // 객체를 통째로 스냅샷하면 드로어를 연 채 기간을 바꿀 때 상단 타일(리더보드 값)과 하단 차트(재조회)의
  // 모수가 어긋난다. 기간 변경 시 leaderboard가 재조회되면 타일도 자동 갱신되고, 새 기간에 해당
  // 유저가 없으면 row=undefined라 드로어가 자연스럽게 닫힌다. group까지 저장하는 이유: 리더보드가
  // 유저×그룹으로 행이 갈라져 있어(userLeaderboard) email만으로는 straddler의 행이 모호하다.
  const [selected, setSelected] = useState(null); // { user, group } | null
  const leaderboard = useApi("/api/users/leaderboard");
  const tools = useApi("/api/users/tools");
  const skills = useApi("/api/users/skills");
  // includeUnknown=1 — 계열별 평균은 group으로 나누지 않고 전 행을 합산하는 총계 지표라
  // unknown 세션도 포함해야 한다(queries.js filterCond 정책표). 기본값은 unknown을 제외한다.
  const byUserModel = useApi("/api/cost/by-user-model", { includeUnknown: 1 });

  // 필터/기간 변경으로 선택 행이 leaderboard에서 사라지면 selected를 비운다 — 안 그러면
  // 나중에 그 행이 다시 나타났을 때(예: 필터를 되돌림) 재클릭 없이 드로어가 조용히 재오픈된다.
  useEffect(() => {
    if (selected && leaderboard.data && !leaderboard.data.some((r) => r.user === selected.user && r.group === selected.group)) {
      setSelected(null);
    }
  }, [selected, leaderboard.data]);

  const top10For = (g) =>
    (leaderboard.data || [])
      .filter((r) => r.group === g)
      .sort((a, b) => Number(b.productivity_score) - Number(a.productivity_score))
      .slice(0, 10)
      .map((r) => ({ ...r, score: Number(r.productivity_score) }));

  const topTool = topPerUser(tools.data, "tool", "uses");
  const topSkill = topPerUser(skills.data, "skill", "invocations");

  // 모델 계열별 "사용자당 평균 지출" — 계열마다 그걸 쓴 유저 수가 달라서 총지출로는 비교가 안 된다.
  // 분자·분모를 같은 by-user-model 행에서 뽑아 모수를 일치시킨다. 한 유저가 여러 계열을 쓰면 각
  // 계열의 분모에 모두 들어간다 — "그 계열을 쓴 사용자당 평균"이라는 정의 그대로라 합계는 전체
  // 유저 수와 다를 수 있다. 계열 순서는 데이터 값이 아니라 FAMILY_LEGEND_ORDER 고정(colors.js와
  // 같은 규칙). 단가표에 없는 모델은 cost=null이라 합계에서 빠지므로 힌트로 알린다.
  // 분모는 priced 행(cost !== null)의 유저만 센다 — 단가표에 없는 모델은 withComputedCost가
  // cost: null을 주는데, 분자에서만 0으로 빼고 분모에는 남기면 그 모델만 쓴 유저가 평균을
  // 끌어내린다(리뷰에서 MAJOR로 확인). 분자·분모를 같은 priced 집합에서 뽑아 모수를 맞춘다.
  const familyStats = FAMILY_LEGEND_ORDER.map((fam) => {
    const frows = (byUserModel.data || []).filter((r) => modelFamily(r.model) === fam);
    const priced = frows.filter((r) => r.cost !== null);
    const users = new Set(priced.map((r) => r.user)).size;
    const cost = priced.reduce((s, r) => s + Number(r.cost), 0);
    return { fam, users, cost, avg: users ? cost / users : 0, unpriced: priced.length < frows.length };
  }).filter((s) => s.users > 0);

  const rows = (leaderboard.data || [])
    .map((r) => ({
      ...r,
      top_tool: topTool.get(`${r.user}|${r.group}`)?.key ?? "—",
      top_skill: topSkill.get(`${r.user}|${r.group}`)?.key ?? "—",
    }))
    .filter((r) => r.user.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="유저별 생산성 점수 + 무엇을 썼는지. 정렬은 헤더 클릭."
        right={
          <div className="flex items-center gap-2">
            <RangePicker />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="이메일 검색..."
              className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 bg-white focus:border-brand-500 focus:outline-none w-56"
            />
          </div>
        }
      />
      <div className="p-8 flex flex-col gap-4">
        {leaderboard.loading ? (
          <Loading />
        ) : leaderboard.error ? (
          <ErrorBox error={leaderboard.error} />
        ) : (
          <>
            <GroupFaceOff rows={leaderboard.data} />
            <div className="grid gap-4 md:grid-cols-2">
              {GROUP_ORDER.map((g) => {
                const data = top10For(g);
                return data.length ? (
                  <HBarList
                    key={g}
                    title={`Top 10 — 생산성 점수 — ${g}`}
                    subtitle="아래 리더보드 행을 클릭하면 유저 상세(히트맵·일별 추이)가 열립니다"
                    data={data.map((d) => ({ ...d, user: maskEmail(d.user) }))}
                    labelKey="user"
                    valueKey="score"
                    color={colorFor(g)}
                  />
                ) : (
                  <Card key={g} title={`Top 10 — 생산성 점수 — ${g}`}>
                    <div className="py-6 text-center text-[13px] text-ink-400">표시할 데이터가 없습니다</div>
                  </Card>
                );
              })}
            </div>
          </>
        )}

        {/* 자체 게이트 — leaderboard와 데이터 소스가 달라 한쪽 로딩/에러가 다른 쪽 렌더를 묶지 않게 한다. */}
        {byUserModel.loading ? (
          <Loading />
        ) : byUserModel.error ? (
          <ErrorBox error={byUserModel.error} />
        ) : familyStats.length ? (
          <Card
            title="모델 계열별 사용자당 평균 지출"
            subtitle="계열을 실제로 쓴 유저 수로 나눈 값 — 계열별 사용자 수가 달라 총지출로는 비교되지 않는다. 한 유저가 여러 계열을 쓰면 각 계열에 모두 계수된다. 단가표에 없는 모델은 분자·분모에서 함께 제외."
          >
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {familyStats.map((s) => (
                <StatTile
                  key={s.fam}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full" style={{ background: familyColorFor(s.fam) }} />
                      {s.fam}
                    </span>
                  }
                  value={usd(s.avg)}
                  hint={`${fmt(s.users)}명 · 총 ${usd(s.cost)}${s.unpriced ? " — 미산정 모델은 분자·분모 모두 제외" : ""}`}
                />
              ))}
            </div>
          </Card>
        ) : null}

        {leaderboard.loading
          ? null
          : leaderboard.error
            ? null
            : GROUP_ORDER.map((g) => (
                <DataTable
                  key={g}
                  title={`유저별 생산성 리더보드 — ${g}`}
                  onRowClick={(r) => setSelected({ user: r.user, group: r.group })}
                  subtitle="점수 = 100 × (0.30×LOC/day + 0.25×수락률 + 0.20×commits/day + 0.15×활성일비율 + 0.10×sessions/day), 각 /day 항목은 절대 상한(캡)으로 정규화 — 캡 값은 초기 추정치"
                  columns={[
                    { key: "user", label: "유저", render: maskEmail },
                    { key: "productivity_score", label: "생산성 점수", render: (v) => v.toFixed(1) },
                    { key: "sessions", label: "세션", render: fmt },
                    { key: "input_tokens", label: "입력 토큰", render: fmt },
                    { key: "output_tokens", label: "출력 토큰", render: fmt },
                    { key: "tokens", label: "전체 토큰", render: fmt },
                    { key: "loc", label: "추가 라인", render: fmt },
                    { key: "prs", label: "PR", render: fmt },
                    { key: "commits", label: "커밋", render: fmt },
                    { key: "accept_rate", label: "수락률", render: pct },
                    { key: "active_days", label: "활성일", render: fmt },
                    { key: "top_tool", label: "주요 도구" },
                    { key: "top_skill", label: "주요 스킬" },
                  ]}
                  rows={rows.filter((r) => r.group === g)}
                />
              ))}

        {tools.loading ? (
          <Loading />
        ) : tools.error ? (
          <ErrorBox error={tools.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {GROUP_ORDER.map((g) => (
              <DataTable
                key={g}
                title={`유저별 도구 사용 내역 — ${g}`}
                columns={[
                  { key: "user", label: "유저", render: maskEmail },
                  { key: "tool", label: "도구" },
                  { key: "uses", label: "사용 횟수", render: fmt },
                ]}
                rows={(tools.data || []).filter((r) => r.group === g)}
              />
            ))}
          </div>
        )}

        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {GROUP_ORDER.map((g) => (
              <DataTable
                key={g}
                title={`유저별 Skill 사용 내역 — ${g}`}
                columns={[
                  { key: "user", label: "유저", render: maskEmail },
                  { key: "skill", label: "Skill" },
                  { key: "invocations", label: "호출 수", render: fmt },
                ]}
                rows={(skills.data || []).filter((r) => r.group === g)}
              />
            ))}
          </div>
        )}
      </div>
      <UserDrawer
        row={selected ? (leaderboard.data || []).find((r) => r.user === selected.user && r.group === selected.group) || null : null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
