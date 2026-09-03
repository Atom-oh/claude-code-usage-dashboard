import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useConfig } from "../ConfigContext.jsx";
import { groupsShown } from "../pivot.js";

const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (ok, total) => (total > 0 ? `${((ok / total) * 100).toFixed(0)}%` : "—");
// ClickHouse quantile()은 float를 그대로 내려보낸다 — ms 컬럼은 반올림해서 표시.
const ms = (v) => fmt(Math.round(Number(v) || 0));
// render와 CSV 내보내기용 값이 같아야 하는 컬럼용 — 화면의 라벨/단위를 CSV에도 그대로 넣는다.
const pct0 = (v) => `${(Number(v || 0) * 100).toFixed(0)}%`;
// 압축률의 원본 render는 `Number(v)`였다(|| 0 없음) — 동작을 바꾸지 않기 위해 따로 둔다.
const ratioPct0 = (v) => `${(Number(v) * 100).toFixed(0)}%`;
// 오류/실패 컬럼의 render는 0보다 크면 강조용 <span>을 돌려준다 — CSV엔 원본 숫자를 넣는다.
const count = (v) => Number(v) || 0;
// 성공률·사용당 비용은 컬럼 자신의 값이 아니라 row의 다른 필드에서 나온다.
const okRate = (v, r) => pct(v, r.calls);
const costPerUse = (_v, r) => (Number(r.est_cost_usd) / (Number(r.invocations) || 1)).toFixed(3);

// group을 카드 제목으로 좌우 분리해 보여주므로 테이블 안에서는 그룹 컬럼을 뺀다.
const TOOL_MCP_COLUMNS = [
  { key: "tool", label: "도구" },
  { key: "mcp_server", label: "MCP 서버" },
  { key: "ok", label: "성공", render: fmt },
  { key: "fail", label: "실패", render: fmt },
  { key: "total", label: "합계", render: fmt },
];

// 2026-08-31 — 툴 권한 결정 퍼널. source가 핵심: config는 사전 허용(개발자를 안 멈춤),
// user_temporary는 매번 물어봤다는 뜻, user_permanent는 사용자가 직접 허용목록에 넣은 것.
// 상위 20개 툴 × source라 그룹당 수십 행 — SUBAGENT_FANOUT_COLUMNS 주석의 판단 기준상
// group 컬럼 하나로 합치는 쪽이 아니라 TOOL_MCP_COLUMNS처럼 그룹별 카드로 좌우 분리한다.
// 합계(n)가 수락+거부와 다르면 accept/reject 외의 decision 값이 새로 생긴 것.
const TOOL_DECISION_COLUMNS = [
  { key: "tool", label: "도구" },
  { key: "source", label: "허용 출처" },
  { key: "accepts", label: "수락", render: fmt },
  { key: "rejects", label: "거부", render: fmt },
  { key: "accept_rate", label: "수락률", render: pct0, toText: pct0 },
  { key: "n", label: "합계", render: fmt },
];

const TOOL_LATENCY_COLUMNS = [
  { key: "tool", label: "도구" },
  { key: "uses", label: "실행", render: fmt },
  { key: "errors", label: "오류", render: (v) => (Number(v) > 0 ? <span className="text-negative-text font-medium">{fmt(v)}</span> : fmt(v)), toText: count },
  { key: "p50_ms", label: "p50(ms)", render: ms },
  { key: "p95_ms", label: "p95(ms)", render: ms },
];

const COMMAND_COLUMNS = [
  { key: "command", label: "커맨드" },
  { key: "uses", label: "사용", render: fmt },
  { key: "users", label: "사용자", render: fmt },
];

// MCP 서버는 그룹당 몇 개뿐이라 SUBAGENT_FANOUT_COLUMNS 주석의 판단 기준대로 좌우 카드 분리
// 대신 group 컬럼 하나로 합친다 — 커넥터 사용 현황(호출량, 수십 행)과 다르게 가는 의도적 선택.
const MCP_HEALTH_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "server", label: "서버" },
  { key: "attempts", label: "시도", render: fmt },
  { key: "connected", label: "성공", render: fmt },
  { key: "failed", label: "실패", render: (v) => (Number(v) > 0 ? <span className="text-negative-text font-medium">{fmt(v)}</span> : fmt(v)), toText: count },
  { key: "p95_ms", label: "p95(ms)", render: ms },
];

const CONNECTOR_COLUMNS = [
  { key: "connector", label: "커넥터" },
  { key: "users", label: "유저", render: fmt },
  { key: "calls", label: "호출", render: fmt },
  { key: "ok", label: "성공률", render: okRate, toText: okRate },
];

const SKILL_COLUMNS = [
  { key: "skill", label: "Skill" },
  { key: "invocations", label: "호출 수", render: fmt },
  { key: "est_cost_usd", label: "근사 비용($)", render: (v) => Number(v).toFixed(2) },
  { key: "cost_per_use", label: "사용당 비용($)", render: costPerUse, toText: costPerUse },
];

// 2026-08-11 — STEP 3 신규 이벤트 패널. skill_activated의 trigger가 'claude-proactive'인
// 비율이 "우리가 만든 스킬이 실제로 자동 발동하는지"의 핵심 지표(원본 지시서 강조 사항).
const SKILL_ACTIVATION_COLUMNS = [
  { key: "skill", label: "Skill" },
  { key: "trigger", label: "발동 방식" },
  { key: "invocations", label: "건수", render: fmt },
];

const PLUGIN_COLUMNS = [
  { key: "plugin", label: "플러그인" },
  { key: "marketplace", label: "마켓플레이스" },
  { key: "session_loads", label: "세션 로드 수", render: fmt },
  { key: "sessions", label: "세션 수", render: fmt },
];

// 2026-08-11 — 서브에이전트 팬아웃(otel_logs의 subagent_completed, 베타 불필요)과 compaction
// 압박(컨텍스트 한도 프록시). 둘 다 그룹당 행이 적어(≤몇 개) bedrock/enterprise 카드 분리 없이
// group 컬럼 하나로 충분하다 — 위 tool/skill 패턴과 다르게 가는 의도적 선택.
const SUBAGENT_FANOUT_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "subagent_completions", label: "완료 건수", render: fmt },
  { key: "interactions", label: "인터랙션 수", render: fmt },
  { key: "avg_subagents_per_interaction", label: "인터랙션당 평균 서브에이전트" },
];

const COMPACTION_COLUMNS = [
  { key: "group", label: "그룹" },
  { key: "trigger", label: "트리거" },
  { key: "compactions", label: "압축 횟수", render: fmt },
  { key: "sessions", label: "세션 수", render: fmt },
  { key: "compactions_per_session", label: "세션당 압축" },
  { key: "avg_compression_ratio", label: "평균 압축률", render: ratioPct0, toText: ratioPct0 },
];

export default function Usage() {
  const { groupMode } = useConfig();
  const toolMcp = useApi("/api/usage/tool-mcp");
  const toolDecisions = useApi("/api/usage/tool-decisions");
  const skills = useApi("/api/usage/skills");
  const connectors = useApi("/api/usage/connectors");
  const skillActivations = useApi("/api/usage/skill-activations");
  const plugins = useApi("/api/usage/plugins");
  const subagentFanout = useApi("/api/usage/subagent-fanout");
  const compaction = useApi("/api/usage/compaction");
  const toolLatency = useApi("/api/usage/tool-latency");
  const commands = useApi("/api/usage/commands");
  const hookOverhead = useApi("/api/usage/hook-overhead");
  const mcpHealth = useApi("/api/usage/mcp-health");

  return (
    <div>
      <PageHeader title="Usage" subtitle="Tool / MCP 커넥터 / Skill 사용 패턴" right={<RangePicker />} />
      <div className="p-8 flex flex-col gap-4">
        {toolMcp.loading ? (
          <Loading />
        ) : toolMcp.error ? (
          <ErrorBox error={toolMcp.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, toolMcp.data).map((g) => (
              <DataTable
                key={g}
                title={`Tool / MCP 사용 패턴 — ${g}`}
                subtitle="성공/실패"
                columns={TOOL_MCP_COLUMNS}
                rows={(toolMcp.data || []).filter((r) => r.group === g)}
                exportName={`usage_tool_mcp_${g}`}
              />
            ))}
          </div>
        )}

        {toolDecisions.loading ? (
          <Loading />
        ) : toolDecisions.error ? (
          <ErrorBox error={toolDecisions.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, toolDecisions.data).map((g) => (
              <DataTable
                key={g}
                title={`툴 권한 결정 퍼널 — ${g}`}
                subtitle="config = 사전 허용(개발자를 멈추지 않음), user_temporary = 매번 물어봄, user_permanent = 사용자가 허용목록에 넣음 — 상위 20개 툴"
                columns={TOOL_DECISION_COLUMNS}
                rows={(toolDecisions.data || []).filter((r) => r.group === g)}
                exportName={`usage_tool_decisions_${g}`}
              />
            ))}
          </div>
        )}

        {toolLatency.loading ? (
          <Loading />
        ) : toolLatency.error ? (
          <ErrorBox error={toolLatency.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, toolLatency.data).map((g) => (
              <DataTable
                key={g}
                title={`도구 실행 레이턴시 — ${g}`}
                subtitle="tool_result 이벤트 기준 — 실행 수 상위 10개 도구"
                columns={TOOL_LATENCY_COLUMNS}
                rows={(toolLatency.data || [])
                  .filter((r) => r.group === g)
                  .sort((a, b) => Number(b.uses) - Number(a.uses))
                  .slice(0, 10)}
                exportName={`usage_tool_latency_${g}`}
              />
            ))}
          </div>
        )}

        {connectors.loading ? (
          <Loading />
        ) : connectors.error ? (
          <ErrorBox error={connectors.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, connectors.data).map((g) => (
              <DataTable
                key={g}
                title={`커넥터(MCP) 사용 현황 — ${g}`}
                subtitle="읽기/쓰기 구분은 텔레메트리에 없어 유저수·호출수·성공률로 단순화"
                columns={CONNECTOR_COLUMNS}
                rows={(connectors.data || []).filter((r) => r.group === g)}
                exportName={`usage_connectors_${g}`}
              />
            ))}
          </div>
        )}

        {mcpHealth.loading ? (
          <Loading />
        ) : mcpHealth.error ? (
          <ErrorBox error={mcpHealth.error} />
        ) : (
          <DataTable
            title="MCP 연결 헬스"
            subtitle="mcp_server_connection 이벤트 기준 — 세션 시작 시 서버별 연결 성공/실패"
            columns={MCP_HEALTH_COLUMNS}
            rows={mcpHealth.data || []}
            exportName="usage_mcp_health"
          />
        )}

        {skills.loading ? (
          <Loading />
        ) : skills.error ? (
          <ErrorBox error={skills.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, skills.data).map((g) => (
              <DataTable
                key={g}
                title={`Skill 사용 분포 — ${g}`}
                subtitle="비용은 Claude Code 보고값(cost.usage) 기준 — skill 사용은 토큰에 귀속되지 않아 계산 비용을 낼 수 없다"
                columns={SKILL_COLUMNS}
                rows={(skills.data || []).filter((r) => r.group === g)}
                exportName={`usage_skills_${g}`}
              />
            ))}
          </div>
        )}

        {skillActivations.loading ? (
          <Loading />
        ) : skillActivations.error ? (
          <ErrorBox error={skillActivations.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, skillActivations.data).map((g) => (
              <DataTable
                key={g}
                title={`스킬 발동 방식 — ${g}`}
                subtitle="claude-proactive 비율이 높을수록 스킬이 사용자 개입 없이 자동 발동한다는 뜻"
                columns={SKILL_ACTIVATION_COLUMNS}
                rows={(skillActivations.data || []).filter((r) => r.group === g)}
                exportName={`usage_skill_activations_${g}`}
              />
            ))}
          </div>
        )}

        {plugins.loading ? (
          <Loading />
        ) : plugins.error ? (
          <ErrorBox error={plugins.error} />
        ) : (
          <DataTable
            title="플러그인 인벤토리 (플릿 전체)"
            subtitle="그룹 구분 없음 — 세션 시작마다 로드된 플러그인 집계"
            columns={PLUGIN_COLUMNS}
            rows={plugins.data || []}
            exportName="usage_plugins"
          />
        )}

        {subagentFanout.loading ? (
          <Loading />
        ) : subagentFanout.error ? (
          <ErrorBox error={subagentFanout.error} />
        ) : (
          <DataTable
            title="서브에이전트 팬아웃"
            subtitle="인터랙션(prompt.id) 하나당 서브에이전트가 몇 개 뜨는지 — traces beta 없이도 오늘 실데이터로 동작"
            columns={SUBAGENT_FANOUT_COLUMNS}
            rows={subagentFanout.data || []}
            exportName="usage_subagent_fanout"
          />
        )}

        {compaction.loading ? (
          <Loading />
        ) : compaction.error ? (
          <ErrorBox error={compaction.error} />
        ) : (
          <DataTable
            title="Compaction 압박"
            subtitle="컨텍스트 압박 프록시 — 압축률이 낮거나 빈도가 높으면 세션이 컨텍스트 한도에 자주 부딪힌다"
            columns={COMPACTION_COLUMNS}
            rows={compaction.data || []}
            exportName="usage_compaction"
          />
        )}

        {commands.loading ? (
          <Loading />
        ) : commands.error ? (
          <ErrorBox error={commands.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, commands.data?.commands).map((g) => (
              <DataTable
                key={g}
                title={`슬래시 커맨드 사용 — ${g}`}
                subtitle="user_prompt의 command_name 기준 — 커맨드 없는 일반 프롬프트는 제외"
                columns={COMMAND_COLUMNS}
                rows={(commands.data?.commands || []).filter((r) => r.group === g)}
                exportName={`usage_commands_${g}`}
              />
            ))}
          </div>
        )}

        {commands.loading ? (
          <Loading />
        ) : commands.error ? (
          <ErrorBox error={commands.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, commands.data?.prompts).map((g) => {
              const r = (commands.data?.prompts || []).find((row) => row.group === g);
              return (
                <Card key={g} title={`프롬프트 길이 — ${g}`} subtitle="user_prompt의 prompt_length 분포">
                  <div className="grid grid-cols-3 gap-4">
                    <StatTile label="프롬프트 수" value={r ? fmt(r.prompts) : "—"} />
                    <StatTile label="p50 길이" value={r ? fmt(Math.round(Number(r.p50_len) || 0)) : "—"} />
                    <StatTile label="p95 길이" value={r ? fmt(Math.round(Number(r.p95_len) || 0)) : "—"} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        {hookOverhead.loading ? (
          <Loading />
        ) : hookOverhead.error ? (
          <ErrorBox error={hookOverhead.error} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {groupsShown(groupMode, hookOverhead.data).map((g) => {
              const r = (hookOverhead.data || []).find((row) => row.group === g);
              return (
                <Card key={g} title={`Hook 오버헤드 — ${g}`} subtitle="hook_execution_complete 기준 — 총 소요는 초, p95는 ms">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatTile label="실행 수" value={r ? fmt(r.executions) : "—"} />
                    <StatTile label="총 소요(s)" value={r ? fmt(Math.round(Number(r.total_seconds) || 0)) : "—"} />
                    <StatTile label="p95(ms)" value={r ? ms(r.p95_ms) : "—"} />
                    <StatTile label="차단 수" value={r ? fmt(r.blocked) : "—"} variant={Number(r?.blocked) > 0 ? "danger" : "default"} />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
