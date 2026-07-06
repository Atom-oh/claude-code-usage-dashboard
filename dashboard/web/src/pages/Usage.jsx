import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { SimpleTable } from "../components/SimpleTable.jsx";
import { useApi } from "../useApi.js";

const fmt = (n) => Number(n || 0).toLocaleString();

export default function Usage() {
  const toolMcp = useApi("/api/usage/tool-mcp");
  const skills = useApi("/api/usage/skills");

  return (
    <div className="grid gap-4">
      <Card title="Tool / MCP 사용 패턴 (성공/실패)">
        {toolMcp.loading ? (
          <Loading />
        ) : toolMcp.error ? (
          <ErrorBox error={toolMcp.error} />
        ) : (
          <SimpleTable
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
      </Card>

      <Card title="Skill 사용 분포">
        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <SimpleTable
            columns={[
              { key: "group", label: "그룹" },
              { key: "skill", label: "Skill" },
              { key: "invocations", label: "호출 수", render: fmt },
              { key: "est_cost_usd", label: "근사 비용($, 그룹 내 상대비교용)", render: (v) => Number(v).toFixed(2) },
            ]}
            rows={skills.data}
          />
        )}
      </Card>
    </div>
  );
}
