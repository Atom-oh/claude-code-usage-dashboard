import { useState } from "react";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { topPerUser } from "../pivot.js";
import { useApi } from "../useApi.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (n) => `${(Number(n) * 100).toFixed(0)}%`;

export default function Users() {
  const [q, setQ] = useState("");
  const leaderboard = useApi("/api/users/leaderboard");
  const tools = useApi("/api/users/tools");
  const skills = useApi("/api/users/skills");

  const topTool = topPerUser(tools.data, "tool", "uses");
  const topSkill = topPerUser(skills.data, "skill", "invocations");

  const rows = (leaderboard.data || [])
    .map((r) => ({
      ...r,
      top_tool: topTool.get(r.user)?.key ?? "—",
      top_skill: topSkill.get(r.user)?.key ?? "—",
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
          <DataTable
            title="유저별 생산성 리더보드"
            subtitle="점수 = 100 × (0.30×LOC/day + 0.25×수락률 + 0.20×commits/day + 0.15×활성일비율 + 0.10×sessions/day), 각 /day 항목은 절대 상한(캡)으로 정규화 — 캡 값은 초기 추정치"
            columns={[
              { key: "group", label: "그룹" },
              { key: "user", label: "유저" },
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
            rows={rows}
          />
        )}

        {tools.loading ? (
          <Loading />
        ) : tools.error ? (
          <ErrorBox error={tools.error} />
        ) : (
          <DataTable
            title="유저별 도구 사용 내역"
            columns={[
              { key: "group", label: "그룹" },
              { key: "user", label: "유저" },
              { key: "tool", label: "도구" },
              { key: "uses", label: "사용 횟수", render: fmt },
            ]}
            rows={tools.data}
          />
        )}

        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <DataTable
            title="유저별 Skill 사용 내역"
            columns={[
              { key: "group", label: "그룹" },
              { key: "user", label: "유저" },
              { key: "skill", label: "Skill" },
              { key: "invocations", label: "호출 수", render: fmt },
            ]}
            rows={skills.data}
          />
        )}
      </div>
    </div>
  );
}
