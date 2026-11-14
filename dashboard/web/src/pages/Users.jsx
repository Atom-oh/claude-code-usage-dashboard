import { localeTag, translate, translateSource, useLocale } from "../i18n/index.js";
import { useEffect, useState } from "react";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { UserDetail } from "../components/UserDetail.jsx";
import { HBarList } from "../components/GroupCharts.jsx";
import { StatTile } from "../components/StatTile.jsx";
import EmptyState from "../components/EmptyState.jsx";
import { colorFor, FAMILY_LEGEND_ORDER, familyColorFor, modelFamily } from "../colors.js";
import { topPerUser, groupLabel } from "../pivot.js";
import { useGroupsShown } from "../useGroupsShown.js";
import { useApi } from "../useApi.js";
import { useConfig } from "../ConfigContext.jsx";
import { useRange } from "../RangeContext.jsx";
import { maskEmail } from "../fmt.js";
import { asSpendRows, sumSpend, SPEND_HELP } from "../spend.js";
import { ACTIVITY_SCORE_HELP, averageActivityScore, formatActivityScore } from "../score.js";
import { teamSuffix, useTeams, withTeamColumn, withTeams } from "../TeamsContext.jsx";

const fmt = (n) => Number(n || 0).toLocaleString(localeTag());
const usd = (n) => n == null ? translate("m84dd6e381dca") : `$${Number(n).toLocaleString(localeTag(), { maximumFractionDigits: 2 })}`;
const pct = (n) => n == null ? "—" : `${(Number(n) * 100).toFixed(0)}%`;

// bedrock/enterprise 대결 밴드 — 이 대시보드의 정체성(A/B 실험)을 Users 페이지 상단에도 드러낸다.
// 검색창(q) 필터는 적용하지 않는다 — 그룹 전체의 인원/수락률 등 요약 지표라 이름 검색과 무관해야 함.
// 인원(count)은 straddler(두 그룹 모두 세션이 있는 유저)를 양쪽에 셀 수 있다 — leaderboard가
// 유저×그룹으로 행이 갈라져 있기 때문(GROUP_ORDER 합계 ≥ distinct 유저 수).
function GroupFaceOff({ rows }) {
  const _locale = useLocale();
  const { groupMode } = useConfig();
  const shownGroups = useGroupsShown();
  const stats = shownGroups(rows).map((g) => {
    const grows = (rows || []).filter((r) => r.group === g);
    const decisions = grows.reduce((s, r) => s + Number(r.decisions || 0), 0);
    const accepted = grows.reduce((s, r) => s + Number(r.accepted || 0), 0);
    return {
      group: g,
      count: grows.length,
      avgScore: averageActivityScore(grows),
      sessions: grows.reduce((s, r) => s + Number(r.sessions || 0), 0),
      // 행별 accept_rate 단순 평균이 아니라 accepted/decisions 가중 평균 — 결정 수가 다른 유저를 동일 비중으로 섞지 않는다.
      acceptRate: decisions > 0 ? accepted / decisions : null,
    };
  });

  return (
    <Card padded={false} title={groupLabel(groupMode, undefined, translate("m15f108bcf538"))} help={translateSource(ACTIVITY_SCORE_HELP)}>
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
                <span className="text-[13px] font-semibold text-ink-800">{s.group}</span>
              </div>
              {s.count === 0 ? (
                <div className="text-[12px] text-ink-400">{translate("ma978eff66bcc")}</div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[11px] text-ink-500">{translate("m1ac6e422b7dc")}</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{fmt(s.count)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-500">{translate("m9306e9f1c975")}</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{formatActivityScore(s.avgScore)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-500">{translate("me600d4f5926e")}</div>
                    <div className="tabular text-[16px] font-semibold text-ink-800">{fmt(s.sessions)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-ink-500">{translate("m928c37dd7e50")}</div>
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
  const _locale = useLocale();
  const [q, setQ] = useState("");
  const shownGroups = useGroupsShown();
  // Store only the clicked user+group: the leaderboard splits rows by user×group, so the email alone
  // is ambiguous for a user in both groups. The detail opens in-page below the leaderboard tables.
  const [selected, setSelected] = useState(null); // { user, group } | null
  const leaderboard = useApi("/api/users/leaderboard");
  const tools = useApi("/api/users/tools");
  const skills = useApi("/api/users/skills");
  // includeUnknown=1 — 계열별 평균은 group으로 나누지 않고 전 행을 합산하는 총계 지표라
  // unknown 세션도 포함해야 한다(queries.js filterCond 정책표). 기본값은 unknown을 제외한다.
  const byUserModel = useApi("/api/cost/by-user-model", { includeUnknown: 1 });
  const teams = useTeams();
  // The unified detail covers every enabled client; this page has no client selection of its own.
  const { enabledClients } = useConfig();
  const { intervalHours } = useRange();

  // 필터/기간 변경으로 선택 행이 leaderboard에서 사라지면 selected를 비운다 — 안 그러면
  // 나중에 그 행이 다시 나타났을 때(예: 필터를 되돌림) 재클릭 없이 상세가 조용히 재오픈된다.
  useEffect(() => {
    if (selected && leaderboard.data && !leaderboard.data.some((r) => r.user === selected.user && r.group === selected.group)) {
      setSelected(null);
    }
  }, [selected, leaderboard.data]);

  const top10For = (g) =>
    (leaderboard.data || [])
      .filter((r) => r.group === g && r.productivity_score != null)
      .sort((a, b) => Number(b.productivity_score) - Number(a.productivity_score))
      .slice(0, 10)
      .map((r) => ({ ...r, score: Number(r.productivity_score) }));

  const topTool = topPerUser(tools.data, "tool", "uses");
  const topSkill = topPerUser(skills.data, "skill", "invocations");

  // 모델 계열별 "사용자당 평균 지출" — 계열마다 그걸 쓴 유저 수가 달라서 총지출로는 비교가 안 된다.
  // 분자·분모를 같은 by-user-model 행에서 뽑아 모수를 일치시킨다. 한 유저가 여러 계열을 쓰면 각
  // 계열의 분모에 모두 들어간다 — "그 계열을 쓴 사용자당 평균"이라는 정의 그대로라 합계는 전체
  // 유저 수와 다를 수 있다. 계열 순서는 데이터 값이 아니라 FAMILY_LEGEND_ORDER 고정(colors.js와
  // 같은 규칙). 보고값이 불완전한 계열은 부분합을 전체 사용자 수로 나누지 않는다.
  const spendRows = asSpendRows(byUserModel.data || []);
  const familyStats = FAMILY_LEGEND_ORDER.map((fam) => {
    const frows = spendRows.filter((r) => modelFamily(r.model) === fam);
    const users = new Set(frows.map((r) => r.user)).size;
    const cost = sumSpend(frows);
    return { fam, users, cost, avg: users && cost != null ? cost / users : null };
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
        title={translate("m6b0cc904d081")}
        subtitle={translate("m151086478c4e")}
        right={
          <div className="flex items-center gap-2">
            <RangePicker />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={translate("m735c008bd6ed")}
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
            <div className="group-grid">
              {shownGroups(leaderboard.data).map((g) => {
                const data = top10For(g);
                return data.length ? (
                  <HBarList
                    key={g}
                    title={translate("m668ea2ecdde5", [g])}
                    help={translateSource(ACTIVITY_SCORE_HELP)}
                    subtitle={translate("m04256f41edaa")}
                    data={data.map((d) => ({ ...d, user: maskEmail(d.user) + teamSuffix(teams, d.user) }))}
                    labelKey="user"
                    valueKey="score"
                    color={colorFor(g)}
                  />
                ) : (
                  <Card key={g} title={translate("m668ea2ecdde5", [g])}>
                    <EmptyState />
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
            title={translate("m6e77034ae9ff")}
            subtitle={translate("ma11330a31ecd")}
            help={translate("m5f4279dabbe0", [translateSource(SPEND_HELP)])}
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
                  hint={s.cost == null ? translate("m311879f75bff", [fmt(s.users)]) : translate("ma1cd76b536a3", [fmt(s.users), usd(s.cost)])}
                />
              ))}
            </div>
          </Card>
        ) : null}

        {leaderboard.loading
          ? null
          : leaderboard.error
            ? null
            : shownGroups(leaderboard.data).map((g) => (
                <DataTable
                  key={g}
                  title={translate("mcddf555253c7", [g])}
                  onRowClick={(r) => setSelected({ user: r.user, group: r.group })}
                  isRowSelected={(r) => selected?.user === r.user && selected?.group === r.group}
                  subtitle={translate("m2e911a610182")}
                  help={translateSource(ACTIVITY_SCORE_HELP)}
                  columns={withTeamColumn([
                    { key: "user", label: translate("m1ac6e422b7dc"), render: maskEmail },
                    { key: "productivity_score", label: translate("m52542cfd75c0"), render: formatActivityScore },
                    { key: "sessions", label: translate("me600d4f5926e"), render: fmt },
                    { key: "input_tokens", label: translate("me10fd8ddfcf8"), render: fmt },
                    { key: "output_tokens", label: translate("m6f31589138ca"), render: fmt },
                    { key: "tokens", label: translate("m950ed890e8a3"), render: fmt },
                    { key: "loc", label: translate("m81ea6a128280"), render: fmt },
                    { key: "prs", label: "PR", render: fmt },
                    { key: "commits", label: translate("ma5d6612cd595"), render: fmt },
                    { key: "accept_rate", label: translate("m928c37dd7e50"), render: (value, row) => row.decisions > 0 ? pct(value) : "—", toText: (value, row) => row.decisions > 0 ? pct(value) : "—" },
                    { key: "active_days", label: translate("m30b91d8a5785"), render: fmt },
                    { key: "top_tool", label: translate("m6e148803a112") },
                    { key: "top_skill", label: translate("mc8fa6d681bd8") },
                  ], teams)}
                  rows={withTeams(rows.filter((r) => r.group === g), teams)}
                  exportName={`users_leaderboard_${g}`}
                  stale={leaderboard.stale || tools.stale || skills.stale}
                />
              ))}

        {selected && <UserDetail key={`${selected.user}|${selected.group}`} user={selected.user} clients={enabledClients}
          group={selected.group} hours={intervalHours} parentRange={null} stale={leaderboard.stale}
          onClose={() => setSelected(null)} />}

        {tools.loading ? (
          <Loading />
        ) : tools.error ? (
          <ErrorBox error={tools.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(tools.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m7739bb4c9736", [g])}
                columns={withTeamColumn([
                  { key: "user", label: translate("m1ac6e422b7dc"), render: maskEmail },
                  { key: "tool", label: translate("m36c416ead2ce") },
                  { key: "uses", label: translate("mc119b7984b53"), render: fmt },
                ], teams)}
                rows={withTeams((tools.data || []).filter((r) => r.group === g), teams)}
                exportName={`users_tools_${g}`}
                stale={tools.stale}
              />
            ))}
          </div>
        )}

        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(skills.data).map((g) => (
              <DataTable
                key={g}
                title={translate("m8a166e4d9f68", [g])}
                help={translate("m6a73f7b3603b")}
                columns={withTeamColumn([
                  { key: "user", label: translate("m1ac6e422b7dc"), render: maskEmail },
                  { key: "skill", label: "Skill" },
                  { key: "invocations", label: translate("mc119b7984b53"), render: fmt },
                ], teams)}
                rows={withTeams((skills.data || []).filter((r) => r.group === g), teams)}
                exportName={`users_skills_${g}`}
                stale={skills.stale}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
