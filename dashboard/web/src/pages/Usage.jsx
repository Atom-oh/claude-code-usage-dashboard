import { DataTable } from "../components/DataTable.jsx";
import { PageHeader } from "../components/PageHeader.jsx";
import { RangePicker } from "../components/RangePicker.jsx";
import { Card, Loading, ErrorBox } from "../components/Card.jsx";
import { StatTile } from "../components/StatTile.jsx";
import { useApi } from "../useApi.js";
import { useGroupsShown } from "../useGroupsShown.js";

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
// 화면과 CSV에 원시 enum 값이 그대로 나가지 않게 한다. 이 두 맵은 이 페이지에만 필요해
// labels.js로 올리지 않는다. 매핑되지 않은 값은 그대로 통과시킨다.
const SOURCE_LABEL = { config: "설정 사전 허용", user_temporary: "매번 확인", user_permanent: "사용자 허용 목록" };
const sourceLabel = (v) => SOURCE_LABEL[v] ?? v;
const SKILL_TRIGGER_LABEL = { "user-slash": "슬래시 커맨드 호출", "claude-proactive": "자동 발동", "nested-skill": "다른 Skill에서 호출" };
const skillTriggerLabel = (v) => SKILL_TRIGGER_LABEL[v] ?? v;

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
  { key: "source", label: "허용 출처", render: sourceLabel, toText: sourceLabel },
  { key: "accepts", label: "수락", render: fmt },
  { key: "rejects", label: "거부", render: fmt },
  { key: "accept_rate", label: "수락률", render: pct0, toText: pct0 },
  { key: "n", label: "합계", render: fmt },
];

const TOOL_LATENCY_COLUMNS = [
  { key: "tool", label: "도구" },
  { key: "uses", label: "실행", render: fmt },
  { key: "errors", label: "오류", render: (v) => (Number(v) > 0 ? <span className="text-negative-text font-medium">{fmt(v)}</span> : fmt(v)), toText: count },
  { key: "p50_ms", label: "p50 (ms)", render: ms },
  { key: "p95_ms", label: "p95 (ms)", render: ms },
];

const COMMAND_COLUMNS = [
  { key: "command", label: "커맨드" },
  { key: "uses", label: "사용", render: fmt },
  { key: "users", label: "사용자", render: fmt },
];

// MCP 서버는 그룹당 몇 개뿐이라 SUBAGENT_FANOUT_COLUMNS 주석의 판단 기준대로 좌우 카드 분리
// 대신 group 컬럼 하나로 합친다 — 커넥터 사용 현황(호출량, 수십 행)과 다르게 가는 의도적 선택.
const MCP_HEALTH_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "server", label: "서버" },
  { key: "attempts", label: "시도", render: fmt },
  { key: "connected", label: "성공", render: fmt },
  { key: "failed", label: "실패", render: (v) => (Number(v) > 0 ? <span className="text-negative-text font-medium">{fmt(v)}</span> : fmt(v)), toText: count },
  { key: "p95_ms", label: "p95 (ms)", render: ms },
];

const CONNECTOR_COLUMNS = [
  { key: "connector", label: "커넥터" },
  { key: "users", label: "사용자", render: fmt },
  { key: "calls", label: "호출", render: fmt },
  { key: "ok", label: "성공률", render: okRate, toText: okRate },
];

const SKILL_COLUMNS = [
  { key: "skill", label: "Skill" },
  { key: "invocations", label: "사용 세션 수", render: fmt },
  { key: "est_cost_usd", label: "Claude Code 보고 비용 ($)", render: (v) => Number(v).toFixed(2) },
  { key: "cost_per_use", label: "세션당 비용 ($)", render: costPerUse, toText: costPerUse },
];

// 2026-08-11 — STEP 3 신규 이벤트 패널. skill_activated의 trigger가 'claude-proactive'인
// 비율이 "우리가 만든 스킬이 실제로 자동 발동하는지"의 핵심 지표(원본 지시서 강조 사항).
const SKILL_ACTIVATION_COLUMNS = [
  { key: "skill", label: "Skill" },
  { key: "trigger", label: "발동 방식", render: skillTriggerLabel, toText: skillTriggerLabel },
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
  { key: "group", label: "채널" },
  { key: "subagent_completions", label: "완료 건수", render: fmt },
  { key: "interactions", label: "인터랙션 수", render: fmt },
  { key: "avg_subagents_per_interaction", label: "인터랙션당 평균 에이전트 수" },
];

const COMPACTION_COLUMNS = [
  { key: "group", label: "채널" },
  { key: "trigger", label: "발생 방식" },
  { key: "compactions", label: "압축 횟수", render: fmt },
  { key: "sessions", label: "세션 수", render: fmt },
  { key: "compactions_per_session", label: "세션당 압축 횟수" },
  { key: "avg_compression_ratio", label: "평균 압축률", render: ratioPct0, toText: ratioPct0 },
];

export default function Usage() {
  const shownGroups = useGroupsShown();
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
      <PageHeader title="Usage" subtitle="Tool, MCP 커넥터, Skill 사용 현황" right={<RangePicker />} />
      <div className="p-8 flex flex-col gap-4">
        {toolMcp.loading ? (
          <Loading />
        ) : toolMcp.error ? (
          <ErrorBox error={toolMcp.error} />
        ) : (
          <div className="group-grid">
            {shownGroups(toolMcp.data).map((g) => (
              <DataTable
                key={g}
                title={`Tool / MCP 사용 현황 — ${g}`}
                subtitle="도구별 실행 성공과 실패 건수"
                help="도구 실행 결과를 도구와 MCP 서버 단위로 집계합니다. 성공이나 실패로 기록되지 않은 실행은 합계에만 포함됩니다."
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
          <div className="group-grid">
            {shownGroups(toolDecisions.data).map((g) => (
              <DataTable
                key={g}
                title={`도구 권한 결정 — ${g}`}
                subtitle="허용 출처별 수락과 거부, 상위 20개 도구"
                help="설정에서 사전 허용된 도구는 사용자를 멈추지 않고 실행됩니다. 매번 확인을 받은 경우는 사용자가 그때마다 응답한 것이고, 사용자 허용 목록은 사용자가 항상 허용으로 등록한 것입니다. 상위 20개 도구는 채널 구분 없이 전체 기준으로 선정합니다."
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
          <div className="group-grid">
            {shownGroups(toolLatency.data).map((g) => (
              <DataTable
                key={g}
                title={`도구 실행 시간 — ${g}`}
                subtitle="실행 수 상위 10개 도구"
                help="도구 실행이 끝난 시점에 기록된 소요 시간입니다. 오류에는 실행이 실패한 경우와 오류 메시지가 남은 경우를 모두 포함합니다."
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
          <div className="group-grid">
            {shownGroups(connectors.data).map((g) => (
              <DataTable
                key={g}
                title={`MCP 커넥터 사용 현황 — ${g}`}
                subtitle="커넥터별 사용자 수, 호출 수, 성공률"
                help="MCP 서버를 거친 도구 호출 기준입니다. 읽기 호출과 쓰기 호출은 구분하지 않습니다."
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
            title="MCP 연결 상태"
            subtitle="MCP 서버별 연결 시도의 성공과 실패"
            help="시도 수에는 연결이 끊긴 경우도 포함되므로 성공과 실패의 합과 다를 수 있습니다. p95는 연결에 걸린 시간의 95번째 백분위입니다."
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
          <div className="group-grid">
            {shownGroups(skills.data).map((g) => (
              <DataTable
                key={g}
                title={`Skill 사용 분포 — ${g}`}
                subtitle="Claude Code 보고 비용 기준"
                help="Skill 사용은 토큰 단위로 집계되지 않아 토큰에 단가를 적용한 비용을 계산할 수 없습니다. 이 표의 비용은 Claude Code가 직접 보고한 값으로, Claude Code 버전에 따라 차이가 날 수 있습니다. 사용 세션 수는 세션 단위 집계에서 나온 근사값입니다."
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
          <div className="group-grid">
            {shownGroups(skillActivations.data).map((g) => (
              <DataTable
                key={g}
                title={`Skill 발동 방식 — ${g}`}
                subtitle="Skill별 발동 방식과 건수"
                help="Claude가 스스로 판단해 발동한 비율이 높을수록 Skill이 사용자 개입 없이 자동으로 쓰이고 있다는 뜻입니다."
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
            title="플러그인 목록"
            subtitle="채널 구분 없이 세션 시작 시 로드된 플러그인"
            help="채널, 사용자, 모델 필터를 적용하지 않은 전체 기준입니다."
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
            title="인터랙션당 에이전트 수"
            subtitle="인터랙션 하나에서 실행된 에이전트 수"
            help="에이전트 완료 기록을 인터랙션 단위로 묶어 집계합니다. 인터랙션 정보가 없는 에이전트 실행은 제외됩니다."
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
            title="컨텍스트 압축"
            subtitle="세션당 압축 횟수와 평균 압축률"
            help="압축 횟수가 많거나 압축률이 낮으면 세션이 컨텍스트 한도에 자주 도달하고 있다는 신호입니다. 압축률은 압축 전과 비교해 줄어든 토큰의 비율입니다."
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
          <div className="group-grid">
            {shownGroups(commands.data?.commands).map((g) => (
              <DataTable
                key={g}
                title={`슬래시 커맨드 사용 — ${g}`}
                subtitle="슬래시 커맨드가 포함된 프롬프트만 집계"
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
          <div className="group-grid">
            {shownGroups(commands.data?.prompts).map((g) => {
              const r = (commands.data?.prompts || []).find((row) => row.group === g);
              return (
                <Card key={g} title={`프롬프트 길이 — ${g}`} subtitle="사용자 프롬프트 길이 분포" help="슬래시 커맨드 프롬프트를 포함한 모든 사용자 프롬프트가 대상입니다.">
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
          <div className="group-grid">
            {shownGroups(hookOverhead.data).map((g) => {
              const r = (hookOverhead.data || []).find((row) => row.group === g);
              return (
                <Card key={g} title={`Hook 실행 시간 — ${g}`} subtitle="Hook 실행 횟수와 소요 시간" help="총 소요는 선택한 기간의 Hook 실행 시간을 모두 합한 값이고, p95는 실행 한 건당 소요 시간의 95번째 백분위입니다. 차단 수는 Hook이 하나 이상 동작을 차단한 실행 건수입니다.">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatTile label="실행 수" value={r ? fmt(r.executions) : "—"} />
                    <StatTile label="총 소요 (s)" value={r ? fmt(Math.round(Number(r.total_seconds) || 0)) : "—"} />
                    <StatTile label="p95 (ms)" value={r ? ms(r.p95_ms) : "—"} />
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
