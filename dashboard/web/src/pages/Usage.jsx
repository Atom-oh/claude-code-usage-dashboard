import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Loading, ErrorBox } from "../components/Card.jsx";
import { useApi } from "../useApi.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (ok, total) => (total > 0 ? `${((ok / total) * 100).toFixed(0)}%` : "—");

export default function Usage() {
  const toolMcp = useApi("/api/usage/tool-mcp");
  const skills = useApi("/api/usage/skills");
  const connectors = useApi("/api/usage/connectors");

  return (
    <div>
      <PageHeader title="Usage" subtitle="Tool / MCP 커넥터 / Skill 사용 패턴" right={<RangePicker />} />
      <div className="p-8 flex flex-col gap-4">
        {toolMcp.loading ? (
          <Loading />
        ) : toolMcp.error ? (
          <ErrorBox error={toolMcp.error} />
        ) : (
          <DataTable
            title="Tool / MCP 사용 패턴"
            subtitle="성공/실패"
            columns={[
              { key: "group", label: "그룹" },
              { key: "tool", label: "도구" },
              { key: "mcp_server", label: "MCP 서버" },
              { key: "ok", label: "성공", render: fmt },
              { key: "fail", label: "실패", render: fmt },
              { key: "total", label: "합계", render: fmt },
            ]}
            rows={toolMcp.data}
          />
        )}

        {connectors.loading ? (
          <Loading />
        ) : connectors.error ? (
          <ErrorBox error={connectors.error} />
        ) : (
          <DataTable
            title="커넥터(MCP) 사용 현황"
            subtitle="읽기/쓰기 구분은 텔레메트리에 없어 유저수·호출수·성공률로 단순화"
            columns={[
              { key: "group", label: "그룹" },
              { key: "connector", label: "커넥터" },
              { key: "users", label: "유저", render: fmt },
              { key: "calls", label: "호출", render: fmt },
              { key: "ok", label: "성공률", render: (v, r) => pct(v, r.calls) },
            ]}
            rows={connectors.data}
          />
        )}

        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <DataTable
            title="Skill 사용 분포"
            subtitle="비용은 Claude Code 보고값(cost.usage) 기준 — skill 사용은 토큰에 귀속되지 않아 계산 비용을 낼 수 없다"
            columns={[
              { key: "group", label: "그룹" },
              { key: "skill", label: "Skill" },
              { key: "invocations", label: "호출 수", render: fmt },
              { key: "est_cost_usd", label: "근사 비용($)", render: (v) => Number(v).toFixed(2) },
              { key: "cost_per_use", label: "사용당 비용($)", render: (_v, r) => (Number(r.est_cost_usd) / (Number(r.invocations) || 1)).toFixed(3) },
            ]}
            rows={skills.data}
          />
        )}
      </div>
    </div>
  );
}
